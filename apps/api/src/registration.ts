import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { hashPassword, randomToken, safeEqualStr, sha256Hex, withTx } from '@palletdock/db';
import { signupSchema } from '@palletdock/shared';
import { SESSION_COOKIE, fail } from './context.js';

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

function setSessionCookie(reply: FastifyReply, token: string, expiresAt: Date | string): void {
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.SESSION_COOKIE_SECURE === '1',
    expires: new Date(expiresAt),
  });
}

export function registerSignupRoutes(app: FastifyInstance, pool: pg.Pool, cursorSecret: string): void {
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
      const ipHash = sha256Hex(`${cursorSecret}:${request.ip}`);
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

      const passwordHash = await hashPassword(parsed.data.password);
      const sessionToken = randomToken();
      const csrfToken = randomToken(24);
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
        return reply.code(201).send({ owner: created.owner, csrfToken });
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
