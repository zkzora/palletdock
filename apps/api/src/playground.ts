import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { randomToken, sha256Hex, withTx } from '@palletdock/db';
import { PORTALDOT_V3_TESTNET, playgroundStartSchema } from '@palletdock/shared';
import { PLAYGROUND_TEMPLATES } from '@palletdock/contracts';
import { QuotaError, SESSION_COOKIE, fail, ownerView, type SessionAuth } from './context.js';
import { clientIp } from './client-ip.js';
import { resolveGuestConfig, type GuestConfig } from './guest-config.js';
import { setSessionCookie } from './registration.js';

/**
 * Starting a playground must be an explicit action from the PalletDock page. The custom
 * header cannot be sent cross-site without a CORS preflight (which only WEB_ORIGIN passes),
 * so a third-party page cannot create a guest session in a visitor's browser.
 */
export const PLAYGROUND_INTENT_HEADER = 'x-palletdock-intent';
const GUEST_CREATE_LOCK = 727101;

/** Addresses of the shared template contracts: tracking one never counts toward a guest's contract quota. */
export function sharedAddresses(config: GuestConfig = resolveGuestConfig()): string[] {
  return Object.values(config.shared).map((s) => s!.address);
}

export function guestLimits(config: GuestConfig) {
  return { projects: 1, contracts: config.maxContracts, indexerSources: config.maxSources, readKeys: config.maxKeys, actions: config.maxActions };
}

/** Limits and current usage for a guest's workspace (shown in the temporary-workspace indicator). */
export async function guestUsage(pool: pg.Pool, ownerId: string) {
  const config = resolveGuestConfig();
  const r = await pool.query(
    `SELECT o.guest_actions,
            (SELECT count(*)::int FROM contracts c JOIN projects p ON p.id=c.project_id WHERE p.owner_id=o.id AND c.removed_at IS NULL AND NOT (lower(c.address) = ANY($2::text[]))) AS contracts,
            (SELECT count(*)::int FROM indexer_sources s JOIN projects p ON p.id=s.project_id WHERE p.owner_id=o.id AND s.desired_state <> 'deleted') AS sources,
            (SELECT count(*)::int FROM api_keys k JOIN projects p ON p.id=k.project_id WHERE p.owner_id=o.id AND k.revoked_at IS NULL AND k.expires_at > now()) AS keys
       FROM owners o WHERE o.id=$1`,
    [ownerId, sharedAddresses(config)],
  );
  const row = r.rows[0] ?? { guest_actions: 0, contracts: 0, sources: 0, keys: 0 };
  return { limits: guestLimits(config), used: { contracts: row.contracts, indexerSources: row.sources, readKeys: row.keys, actions: row.guest_actions } };
}

// ---------------------------------------------------------------- quotas (call inside a transaction after lockProject)

/**
 * Tracked contracts plus deployments that may still create one (submitted, or prepared in the
 * last 30 minutes). Shared template contracts are excluded: they are a fixed, operator-set list.
 */
export async function assertContractQuota(client: pg.PoolClient, auth: SessionAuth, projectId: string): Promise<void> {
  if (auth.kind !== 'guest') return;
  const config = resolveGuestConfig();
  const max = config.maxContracts;
  const r = await client.query(
    `SELECT (SELECT count(*)::int FROM contracts WHERE project_id=$1 AND removed_at IS NULL AND NOT (lower(address) = ANY($2::text[])))
          + (SELECT count(*)::int FROM transactions t WHERE t.project_id=$1 AND t.kind='deploy' AND t.contract_id IS NULL AND t.execution_status <> 'reverted'
               AND ((t.submission_status IN ('submitted','unknown') AND t.tracking_status='active')
                    OR (t.submission_status='prepared' AND t.created_at > now() - interval '30 minutes'))) AS used`,
    [projectId, sharedAddresses(config)],
  );
  if (r.rows[0].used >= max) {
    throw new QuotaError(
      `A temporary workspace tracks up to ${max} contracts, counting deployments that are prepared or still waiting for a receipt. Remove a contract, or save the workspace as an account.`,
    );
  }
}

export async function assertSourceQuota(client: pg.PoolClient, auth: SessionAuth, projectId: string): Promise<void> {
  if (auth.kind !== 'guest') return;
  const max = resolveGuestConfig().maxSources;
  const r = await client.query(`SELECT count(*)::int AS n FROM indexer_sources WHERE project_id=$1 AND desired_state <> 'deleted'`, [projectId]);
  if (r.rows[0].n >= max) throw new QuotaError(`A temporary workspace runs up to ${max} indexer source${max === 1 ? '' : 's'}. Edit or remove the existing source, or save the workspace as an account.`);
}

export async function assertKeyQuota(client: pg.PoolClient, auth: SessionAuth, projectId: string): Promise<void> {
  if (auth.kind !== 'guest') return;
  const max = resolveGuestConfig().maxKeys;
  const r = await client.query(`SELECT count(*)::int AS n FROM api_keys WHERE project_id=$1 AND revoked_at IS NULL AND expires_at > now()`, [projectId]);
  if (r.rows[0].n >= max) throw new QuotaError(`A temporary workspace can hold ${max} active read key${max === 1 ? '' : 's'}. Revoke the existing key to create another.`);
}

/** SQL expression for a new key's expiry: a guest's keys never outlive the workspace. */
export function keyExpirySql(auth: SessionAuth, daysParam: string, expiryParam: string): string {
  return auth.kind === 'guest' ? `LEAST(now()+(${daysParam}::text || ' days')::interval, ${expiryParam}::timestamptz)` : `now()+(${daysParam}::text || ' days')::interval`;
}

// ---------------------------------------------------------------- routes

export function registerPlaygroundRoutes(app: FastifyInstance, pool: pg.Pool, cursorSecret: string, proxySecret: string | null): void {
  // Public and side-effect free: page rendering and prefetching never create anything.
  app.get('/auth/playground-config', async () => {
    const config = resolveGuestConfig();
    return {
      enabled: config.enabled,
      lifetimeMinutes: config.lifetimeMinutes,
      limits: guestLimits(config),
      network: { name: PORTALDOT_V3_TESTNET.name, evmChainId: PORTALDOT_V3_TESTNET.evmChainId },
      // `shared` is the operator's already deployed copy, or null when visitors deploy their own.
      templates: PLAYGROUND_TEMPLATES.map((t) => ({ ...t, sharedContract: config.shared[t.id] ?? null })),
    };
  });

  app.post('/auth/playground', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request: FastifyRequest, reply: FastifyReply) => {
    const config = resolveGuestConfig();
    if (!config.enabled) return fail(reply, 'PLAYGROUND_DISABLED', 'The playground is not enabled on this deployment.');
    if (request.headers[PLAYGROUND_INTENT_HEADER] !== 'start-playground') return fail(reply, 'INVALID_REQUEST', 'Start the playground from the PalletDock playground page.');
    const parsed = playgroundStartSchema.safeParse(request.body ?? {});
    if (!parsed.success) return fail(reply, 'INVALID_REQUEST', parsed.error.issues[0]?.message ?? 'Unknown template.');

    // An existing session is reused, never replaced: an account stays signed in, and a
    // still-valid guest gets its own workspace back (a double click creates nothing).
    const token = request.cookies[SESSION_COOKIE];
    if (token) {
      const r = await pool.query(
        `SELECT o.id, o.kind, o.guest_expires_at, (SELECT p.id FROM projects p WHERE p.owner_id=o.id AND p.playground ORDER BY p.created_at LIMIT 1) AS project_id
           FROM sessions s JOIN owners o ON o.id=s.owner_id
          WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at > now() AND (o.kind <> 'guest' OR o.guest_expires_at > now())`,
        [sha256Hex(token)],
      );
      const existing = r.rows[0];
      if (existing?.kind === 'account') return reply.code(200).send({ created: false, session: { kind: 'account', expiresAt: null }, projectId: null });
      if (existing?.kind === 'guest') return reply.code(200).send({ created: false, session: { kind: 'guest', expiresAt: new Date(existing.guest_expires_at).toISOString() }, projectId: existing.project_id });
    }

    const ipHash = sha256Hex(`${cursorSecret}:${clientIp(request, proxySecret)}`);
    const sessionToken = randomToken();
    const csrfToken = randomToken(24);
    const out = await withTx(pool, async (c) => {
      // One creation at a time: the per-visitor and global capacity checks below cannot race.
      await c.query('SELECT pg_advisory_xact_lock($1)', [GUEST_CREATE_LOCK]);
      const recent = await c.query(`SELECT count(*)::int AS n FROM guest_starts WHERE ip_hash=$1 AND created_at > now() - interval '1 hour'`, [ipHash]);
      if (recent.rows[0].n >= config.startsPerHour) return { error: 'RATE_LIMITED' as const };
      const active = await c.query(`SELECT count(*)::int AS n FROM owners WHERE kind='guest' AND guest_expires_at > now()`);
      if (active.rows[0].n >= config.capacity) return { error: 'PLAYGROUND_FULL' as const };
      const owner = await c.query(`INSERT INTO owners(kind,guest_expires_at) VALUES ('guest', now() + ($1::int * interval '1 minute')) RETURNING id, guest_expires_at`, [
        config.lifetimeMinutes,
      ]);
      const { id: ownerId, guest_expires_at: expiresAt } = owner.rows[0];
      await c.query('INSERT INTO guest_starts(ip_hash,owner_id) VALUES ($1,$2)', [ipHash, ownerId]);
      const project = await c.query(
        `INSERT INTO projects(owner_id,name,description,network_id,playground,playground_template)
         VALUES ($1,'Playground','Temporary playground workspace.','portaldot-v3-testnet',true,$2) RETURNING id`,
        [ownerId, parsed.data.template ?? null],
      );
      await c.query(`INSERT INTO sessions(owner_id,token_hash,csrf_token,expires_at,user_agent) VALUES ($1,$2,$3,$4,$5)`, [
        ownerId,
        sha256Hex(sessionToken),
        csrfToken,
        expiresAt,
        request.headers['user-agent']?.slice(0, 500) ?? null,
      ]);
      return { ownerId: ownerId as string, expiresAt: new Date(expiresAt).toISOString(), projectId: project.rows[0].id as string };
    });
    if ('error' in out) {
      if (out.error === 'RATE_LIMITED') return fail(reply, 'RATE_LIMITED', 'Too many playground workspaces were started from this address. Try again later, or create an account.');
      return fail(reply, 'PLAYGROUND_FULL', 'The playground is at capacity right now. Try again later, or create an account.');
    }
    setSessionCookie(reply, sessionToken, out.expiresAt);
    return reply.code(201).send({
      created: true,
      owner: ownerView({ ownerId: out.ownerId, email: null, kind: 'guest' }),
      session: { kind: 'guest', expiresAt: out.expiresAt },
      projectId: out.projectId,
      csrfToken,
    });
  });
}
