import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { hashPassword, randomToken, safeEqualStr, sha256Hex, withTx } from '@palletdock/db';
import { signupSchema } from '@palletdock/shared';
import { SESSION_COOKIE, fail, ownerView, requireCsrf, sessionAuth } from './context.js';
import { clientIp } from './client-ip.js';

export type SignupMode = 'disabled' | 'invite' | 'open';

export interface SignupConfig {
  mode: SignupMode;
  enabled: boolean;
  inviteRequired: boolean;
  inviteCode: string;
  rateLimit: number;
}

export function resolveSignupConfig(env: Record<string, string | undefined> = process.env): SignupConfig {
  const mode = (env.PALLETDOCK_SIGNUP_MODE ?? 'disabled').trim().toLowerCase();
  if (!['disabled', 'invite', 'open'].includes(mode)) {
    throw new Error('PALLETDOCK_SIGNUP_MODE must be disabled, invite, or open.');
  }
  const inviteCode = env.PALLETDOCK_SIGNUP_INVITE_CODE ?? '';
  if (mode === 'invite' && inviteCode.length < 16) {
    throw new Error('PALLETDOCK_SIGNUP_INVITE_CODE must contain at least 16 characters when invite signup is enabled.');
  }
  const rateLimit = Number(env.PALLETDOCK_SIGNUP_RATE_LIMIT_PER_15_MINUTES ?? 5);
  if (!Number.isSafeInteger(rateLimit) || rateLimit < 1 || rateLimit > 100) {
    throw new Error('PALLETDOCK_SIGNUP_RATE_LIMIT_PER_15_MINUTES must be an integer from 1 to 100.');
  }
  return {
    mode: mode as SignupMode,
    enabled: mode !== 'disabled',
    inviteRequired: mode === 'invite',
    inviteCode,
    rateLimit,
  };
}

export function setSessionCookie(reply: FastifyReply, token: string, expiresAt: Date | string): void {
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.SESSION_COOKIE_SECURE === '1',
    expires: new Date(expiresAt),
  });
}

export function registerSignupRoutes(app: FastifyInstance, pool: pg.Pool, cursorSecret: string, proxySecret: string | null = null): void {
  const config = resolveSignupConfig();

  app.get('/auth/signup-config', async () => ({
    enabled: config.enabled,
    inviteRequired: config.inviteRequired,
  }));

  app.post(
    '/auth/signup',
    { config: { rateLimit: { max: config.rateLimit, timeWindow: '15 minutes' } } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!config.enabled) return fail(reply, 'REGISTRATION_DISABLED', 'Account registration is not enabled on this deployment.');

      const parsed = signupSchema.safeParse(request.body);
      if (!parsed.success) return fail(reply, 'INVALID_REQUEST', parsed.error.issues[0]?.message ?? 'Invalid account details.');
      const email = parsed.data.email.trim().toLowerCase();
      const ipHash = sha256Hex(`${cursorSecret}:${clientIp(request, proxySecret)}`);
      const recent = await pool.query(
        `SELECT count(1)::int AS attempts
           FROM signup_attempts
          WHERE (email=$1 OR ip_hash=$2) AND created_at > now()-interval '15 minutes'`,
        [email, ipHash],
      );
      if (recent.rows[0].attempts >= config.rateLimit) {
        return fail(reply, 'RATE_LIMITED', 'Too many account creation attempts. Try again later.');
      }

      if (config.inviteRequired && !safeEqualStr(sha256Hex(parsed.data.inviteCode ?? ''), sha256Hex(config.inviteCode))) {
        await pool.query('INSERT INTO signup_attempts(email,ip_hash,success) VALUES ($1,$2,false)', [email, ipHash]);
        return fail(reply, 'UNAUTHORIZED', 'The registration code is invalid.');
      }

      // Saving a temporary workspace: only the current, unexpired guest of this session is promoted.
      let guest: Awaited<ReturnType<typeof sessionAuth>> = null;
      if (parsed.data.claimGuest) {
        guest = await sessionAuth(pool, request, reply);
        if (!guest) return;
        if (guest.kind !== 'guest') return fail(reply, 'CONFLICT', 'This session already belongs to a saved account.');
        if (!requireCsrf(guest, request, reply)) return;
      }

      const passwordHash = await hashPassword(parsed.data.password);
      const sessionToken = randomToken();
      const csrfToken = randomToken(24);
      if (guest) {
        const guestId = guest.ownerId;
        try {
          const promoted = await withTx(pool, async (client) => {
            const current = await client.query(`SELECT id FROM owners WHERE id=$1 AND kind='guest' AND guest_expires_at > now() FOR UPDATE`, [guestId]);
            if (!current.rowCount) return null;
            // Projects, contracts, transactions, indexer sources, keys (with their own expiry) and
            // playground progress stay attached to the same owner id; only the identity changes.
            const owner = await client.query(
              `UPDATE owners SET kind='account', email=$2, password_hash=$3, guest_expires_at=NULL, promoted_at=now() WHERE id=$1 RETURNING id,email`,
              [guestId, email, passwordHash],
            );
            // Rotate credentials: every guest session (and its CSRF token) is revoked.
            await client.query('UPDATE sessions SET revoked_at=now() WHERE owner_id=$1 AND revoked_at IS NULL', [guestId]);
            const session = await client.query(
              `INSERT INTO sessions(owner_id,token_hash,csrf_token,expires_at,user_agent)
               VALUES ($1,$2,$3,now()+interval '7 days',$4) RETURNING expires_at`,
              [guestId, sha256Hex(sessionToken), csrfToken, request.headers['user-agent']?.slice(0, 500) ?? null],
            );
            await client.query('INSERT INTO signup_attempts(email,ip_hash,success) VALUES ($1,$2,true)', [email, ipHash]);
            const project = await client.query('SELECT id FROM projects WHERE owner_id=$1 AND playground ORDER BY created_at LIMIT 1', [guestId]);
            return { owner: owner.rows[0], expiresAt: session.rows[0].expires_at, projectId: (project.rows[0]?.id as string | undefined) ?? null };
          });
          if (!promoted) return fail(reply, 'WORKSPACE_EXPIRED', 'This temporary workspace expired before it could be saved. Start a new playground or create an empty account.');
          setSessionCookie(reply, sessionToken, promoted.expiresAt);
          return reply.code(201).send({
            owner: ownerView({ ownerId: promoted.owner.id, email: promoted.owner.email, kind: 'account' }),
            session: { kind: 'account', expiresAt: null },
            csrfToken,
            promoted: true,
            projectId: promoted.projectId,
          });
        } catch (error) {
          if ((error as { code?: string }).code === '23505') {
            await pool.query('INSERT INTO signup_attempts(email,ip_hash,success) VALUES ($1,$2,false)', [email, ipHash]);
            // The transaction rolled back: the guest, its session and its workspace are unchanged.
            return fail(
              reply,
              'CONFLICT',
              'An account with this email already exists. Saving into an existing account is not supported yet; your temporary workspace is unchanged. Use a different email, or keep exploring until it expires.',
            );
          }
          throw error;
        }
      }
      try {
        const created = await withTx(pool, async (client) => {
          const owner = await client.query(
            'INSERT INTO owners(email,password_hash) VALUES ($1,$2) RETURNING id,email',
            [email, passwordHash],
          );
          const session = await client.query(
            `INSERT INTO sessions(owner_id,token_hash,csrf_token,expires_at,user_agent)
             VALUES ($1,$2,$3,now()+interval '7 days',$4) RETURNING expires_at`,
            [owner.rows[0].id, sha256Hex(sessionToken), csrfToken, request.headers['user-agent']?.slice(0, 500) ?? null],
          );
          await client.query('INSERT INTO signup_attempts(email,ip_hash,success) VALUES ($1,$2,true)', [email, ipHash]);
          return { owner: owner.rows[0], expiresAt: session.rows[0].expires_at };
        });
        setSessionCookie(reply, sessionToken, created.expiresAt);
        return reply.code(201).send({
          owner: ownerView({ ownerId: created.owner.id, email: created.owner.email, kind: 'account' }),
          session: { kind: 'account', expiresAt: null },
          csrfToken,
        });
      } catch (error) {
        if ((error as { code?: string }).code === '23505') {
          await pool.query('INSERT INTO signup_attempts(email,ip_hash,success) VALUES ($1,$2,false)', [email, ipHash]);
          return fail(reply, 'CONFLICT', 'An account with this email already exists. Sign in instead.');
        }
        throw error;
      }
    },
  );
}
