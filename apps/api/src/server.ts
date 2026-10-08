import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import type pg from 'pg';
import {
  createPool,
  hashPassword,
  loadEnv,
  randomToken,
  safeEqualStr,
  sha256Hex,
  verifyPassword,
  withTx,
} from '@palletdock/db';
import {
  API_DEFAULT_LIMIT,
  API_KEY_PREFIX,
  API_MAX_LIMIT,
  ERROR_CODES,
  apiKeyCreateSchema,
  projectCreateSchema,
  projectUpdateSchema,
  resolveNetwork,
  type ErrorCode,
  type ReadScope,
} from '@palletdock/shared';
import { registerRequestLogging, registerV1 } from './v1.js';
import { registerWorkspace, type WorkspaceDeps } from './workspace.js';
import {
  SESSION_COOKIE,
  cursorSecret,
  fail,
  keyAuth,
  projectOwned,
  requireCsrf,
  sessionAuth,
  stringParam,
} from './context.js';

loadEnv();

const CURSOR_SECRET = cursorSecret();

export async function buildServer(pool = createPool(), deps: WorkspaceDeps = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: process.env.NODE_ENV === 'test' ? false : { redact: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-csrf-token"]'] },
    bodyLimit: 3 * 1024 * 1024,
    trustProxy: process.env.API_TRUST_PROXY === '1',
    genReqId: () => `req_${randomToken(9)}`,
  });
  await app.register(cookie);
  await app.register(cors, { origin: process.env.WEB_ORIGIN ?? 'http://127.0.0.1:3000', credentials: true });
  await app.register(rateLimit, {
    max: Number(process.env.API_RATE_LIMIT_PER_MINUTE ?? 120),
    timeWindow: '1 minute',
    errorResponseBuilder: (request, context) => {
      request.pdErrorCode = 'RATE_LIMITED';
      return { statusCode: 429, error: { code: 'RATE_LIMITED', message: `Too many requests. Retry after ${Math.ceil(context.ttl / 1000)} s.`, requestId: request.id } };
    },
  });
  registerRequestLogging(app, pool);

  app.get('/openapi.yaml', async (_request, reply) => {
    const { readFile } = await import('node:fs/promises');
    const spec = await readFile(new URL('../../../docs/openapi.yaml', import.meta.url), 'utf8');
    return reply.type('application/yaml; charset=utf-8').send(spec);
  });

  app.get('/health', async () => {
    const db = await pool.query('SELECT now() AS now');
    return { status: 'ok', database: 'connected', observedAt: db.rows[0].now };
  });

  app.post('/auth/login', { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } }, async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!email || !password) return fail(reply, 'INVALID_REQUEST', 'Email and password are required.');
    const ipHash = sha256Hex(`${CURSOR_SECRET}:${request.ip}`);
    const recent = await pool.query(
      `SELECT count(1)::int AS failures FROM login_attempts WHERE (email=$1 OR ip_hash=$2) AND success=false AND created_at > now()-interval '15 minutes'`,
      [email, ipHash],
    );
    if (recent.rows[0].failures >= 10) return fail(reply, 'RATE_LIMITED', 'Too many failed sign-in attempts. Try again later.');
    const owner = await pool.query('SELECT id, email, password_hash FROM owners WHERE email=$1', [email]);
    const valid = owner.rows[0] ? await verifyPassword(password, owner.rows[0].password_hash) : false;
    await pool.query('INSERT INTO login_attempts(email,ip_hash,success) VALUES ($1,$2,$3)', [email, ipHash, valid]);
    if (!valid) return fail(reply, 'UNAUTHORIZED', 'Email or password is incorrect.');
    const sessionToken = randomToken();
    const csrfToken = randomToken(24);
    const session = await pool.query(
      `INSERT INTO sessions(owner_id,token_hash,csrf_token,expires_at,user_agent)
       VALUES ($1,$2,$3,now()+interval '7 days',$4) RETURNING id,expires_at`,
      [owner.rows[0].id, sha256Hex(sessionToken), csrfToken, request.headers['user-agent']?.slice(0, 500) ?? null],
    );
    reply.setCookie(SESSION_COOKIE, sessionToken, {
      path: '/',
      httpOnly: true,
      sameSite: 'strict',
      secure: process.env.SESSION_COOKIE_SECURE === '1',
      expires: session.rows[0].expires_at,
    });
    return { owner: { id: owner.rows[0].id, email }, csrfToken };
  });

  app.get('/auth/me', async (request, reply) => {
    const auth = await sessionAuth(pool, request, reply);
    if (!auth) return;
    return { owner: { id: auth.ownerId, email: auth.email }, csrfToken: auth.csrfToken };
  });

  app.post('/auth/logout', async (request, reply) => {
    const auth = await sessionAuth(pool, request, reply);
    if (!auth || !requireCsrf(auth, request, reply)) return;
    await pool.query('UPDATE sessions SET revoked_at=now() WHERE id=$1', [auth.sessionId]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.code(204).send();
  });

  app.get('/workspace/projects', async (request, reply) => {
    const auth = await sessionAuth(pool, request, reply);
    if (!auth) return;
    const result = await pool.query(
      `SELECT p.id,p.name,p.description,p.network_id,p.archived_at,p.created_at,p.updated_at,
              (SELECT count(1)::int FROM contracts c WHERE c.project_id=p.id AND c.removed_at IS NULL) AS contract_count,
              (SELECT count(1)::int FROM api_keys k WHERE k.project_id=p.id AND k.revoked_at IS NULL AND k.expires_at > now()) AS active_key_count,
              COALESCE((SELECT s.status FROM indexer_sources s WHERE s.project_id=p.id ORDER BY s.updated_at DESC LIMIT 1),'not_configured') AS indexer_status
         FROM projects p WHERE p.owner_id=$1 ORDER BY p.updated_at DESC,p.id DESC`,
      [auth.ownerId],
    );
    return { data: result.rows };
  });

  app.get('/workspace/projects/:projectId/overview', async (request, reply) => {
    const auth = await sessionAuth(pool, request, reply);
    if (!auth) return;
    const projectId = stringParam((request.params as Record<string, unknown>).projectId);
    const project = await projectOwned(pool, projectId, auth.ownerId);
    if (!project) return fail(reply, 'PROJECT_NOT_FOUND', 'Project not found.');
    const [counts, source, transactions, events, contracts] = await Promise.all([
      pool.query(
        `SELECT
          (SELECT count(1)::int FROM contracts WHERE project_id=$1 AND removed_at IS NULL) AS contracts,
          (SELECT count(1)::int FROM transactions WHERE project_id=$1) AS transactions,
          (SELECT count(1)::int FROM transactions WHERE project_id=$1 AND execution_status='reverted') AS failed_transactions,
          (SELECT count(1)::int FROM raw_logs WHERE project_id=$1 AND canonical=true) AS indexed_events,
          (SELECT count(1)::int FROM api_keys WHERE project_id=$1 AND revoked_at IS NULL AND expires_at > now()) AS active_keys`,
        [projectId],
      ),
      pool.query(
        `SELECT s.id,s.status,s.start_block::text,s.latest_observed_block::text,s.latest_observed_at,s.last_error,
                c.block_number::text AS checkpoint_block,c.block_hash AS checkpoint_hash,c.committed_at AS checkpoint_at
           FROM indexer_sources s LEFT JOIN indexer_checkpoints c ON c.source_id=s.id
          WHERE s.project_id=$1 ORDER BY s.updated_at DESC LIMIT 1`,
        [projectId],
      ),
      pool.query(
        `SELECT id,hash,kind,function_name,submission_status,inclusion_status,execution_status,block_number::text,created_at,updated_at
           FROM transactions WHERE project_id=$1 ORDER BY updated_at DESC LIMIT 8`,
        [projectId],
      ),
      pool.query(
        `SELECT r.seq::text,r.block_number::text,r.transaction_hash,r.log_index,d.event_name,d.status,r.indexed_at
           FROM raw_logs r LEFT JOIN decoded_events d ON d.raw_log_id=r.id
          WHERE r.project_id=$1 AND r.canonical=true ORDER BY r.seq DESC LIMIT 8`,
        [projectId],
      ),
      pool.query(`SELECT id,name,address,source,created_at FROM contracts WHERE project_id=$1 AND removed_at IS NULL ORDER BY created_at DESC LIMIT 5`, [projectId]),
    ]);
    return { data: { project, counts: counts.rows[0], indexer: source.rows[0] ?? null, transactions: transactions.rows, events: events.rows, contracts: contracts.rows } };
  });

  app.get('/workspace/network', async (request, reply) => {
    const auth = await sessionAuth(pool, request, reply);
    if (!auth) return;
    const config = resolveNetwork();
    const [probes, fingerprint, workers] = await Promise.all([
      pool.query(`SELECT DISTINCT ON (target) target,status,method,latency_ms,result,error,observed_at FROM rpc_probes WHERE network_id=$1 ORDER BY target,observed_at DESC`, [config.networkId]),
      pool.query(`SELECT id,status,genesis_hash,evm_chain_id::text,evm_genesis_hash,spec_name,spec_version::text,ss58_format,token_symbol,token_decimals,last_verified_at FROM network_fingerprints WHERE network_id=$1 ORDER BY last_verified_at DESC LIMIT 1`, [config.networkId]),
      pool.query(`SELECT worker_id,started_at,last_seen_at,info,now()-last_seen_at < interval '30 seconds' AS healthy FROM worker_heartbeats ORDER BY last_seen_at DESC LIMIT 10`),
    ]);
    return {
      data: {
        config: {
          networkId: config.networkId,
          name: config.name,
          environment: config.environment,
          evmRpcUrl: config.evmRpcUrl,
          substrateRpcUrl: config.substrateRpcUrl,
          evmChainId: config.evmChainId,
          evmChainIdHex: config.evmChainIdHex,
          nativeTokenSymbol: config.nativeTokenSymbol,
          nativeTokenDecimals: config.nativeTokenDecimals,
          ss58Format: config.ss58Format,
          nodeConsoleUrl: config.nodeConsoleUrl,
          fixture: /^(https?|wss?):\/\/(127\.0\.0\.1|localhost)[:/]/.test(config.evmRpcUrl),
          nativeAdapter: process.env.PALLETDOCK_NATIVE_ADAPTER === 'disabled' ? 'disabled' : 'enabled',
        },
        probes: probes.rows,
        fingerprint: fingerprint.rows[0] ?? null,
        workers: workers.rows,
      },
    };
  });

  app.post('/workspace/projects', async (request, reply) => {
    const auth = await sessionAuth(pool, request, reply);
    if (!auth || !requireCsrf(auth, request, reply)) return;
    const parsed = projectCreateSchema.safeParse(request.body);
    if (!parsed.success) return fail(reply, 'INVALID_REQUEST', parsed.error.issues[0]?.message ?? 'Invalid project.');
    try {
      const result = await pool.query(
        'INSERT INTO projects(owner_id,name,description,network_id) VALUES ($1,$2,$3,$4) RETURNING *',
        [auth.ownerId, parsed.data.name, parsed.data.description, parsed.data.networkId],
      );
      return reply.code(201).send({ data: result.rows[0] });
    } catch (error) {
      if ((error as { code?: string }).code === '23505') return fail(reply, 'CONFLICT', 'A project with this name already exists.');
      throw error;
    }
  });

  app.patch('/workspace/projects/:projectId', async (request, reply) => {
    const auth = await sessionAuth(pool, request, reply);
    if (!auth || !requireCsrf(auth, request, reply)) return;
    const projectId = stringParam((request.params as Record<string, unknown>).projectId);
    const parsed = projectUpdateSchema.safeParse(request.body);
    if (!parsed.success || !Object.keys(parsed.data ?? {}).length) return fail(reply, 'INVALID_REQUEST', parsed.success ? 'No project changes were supplied.' : parsed.error.issues[0]?.message ?? 'Invalid project.');
    const current = await projectOwned(pool, projectId, auth.ownerId);
    if (!current) return fail(reply, 'PROJECT_NOT_FOUND', 'Project not found.');
    const result = await pool.query(
      'UPDATE projects SET name=$1,description=$2,updated_at=now() WHERE id=$3 AND owner_id=$4 RETURNING *',
      [parsed.data.name ?? current.name, parsed.data.description ?? current.description, projectId, auth.ownerId],
    );
    return { data: result.rows[0] };
  });

  app.post('/workspace/projects/:projectId/archive', async (request, reply) => {
    const auth = await sessionAuth(pool, request, reply);
    if (!auth || !requireCsrf(auth, request, reply)) return;
    const projectId = stringParam((request.params as Record<string, unknown>).projectId);
    if (!(await projectOwned(pool, projectId, auth.ownerId))) return fail(reply, 'PROJECT_NOT_FOUND', 'Project not found.');
    await withTx(pool, async (client) => {
      await client.query('UPDATE projects SET archived_at=now(),updated_at=now() WHERE id=$1', [projectId]);
      await client.query(`INSERT INTO ops_logs(project_id,source,level,message) VALUES ($1,'worker','INFO','Project archived: indexer jobs stopped and fenced.')`, [projectId]);
      await client.query(`UPDATE indexer_sources SET desired_state='archived',status=CASE WHEN status IN ('recovery_required','completed') THEN status ELSE 'stopped' END,generation=generation+1,updated_at=now() WHERE project_id=$1 AND desired_state NOT IN ('archived','deleted')`, [projectId]);
    });
    return { data: { id: projectId, archived: true, workerResumeRequiredOnRestore: true } };
  });

  app.post('/workspace/projects/:projectId/restore', async (request, reply) => {
    const auth = await sessionAuth(pool, request, reply);
    if (!auth || !requireCsrf(auth, request, reply)) return;
    const projectId = stringParam((request.params as Record<string, unknown>).projectId);
    const result = await pool.query('UPDATE projects SET archived_at=NULL,updated_at=now() WHERE id=$1 AND owner_id=$2 RETURNING id', [projectId, auth.ownerId]);
    if (!result.rowCount) return fail(reply, 'PROJECT_NOT_FOUND', 'Project not found.');
    return { data: { id: projectId, archived: false, indexersResumed: false } };
  });

  app.get('/workspace/projects/:projectId/keys', async (request, reply) => {
    const auth = await sessionAuth(pool, request, reply);
    if (!auth) return;
    const projectId = stringParam((request.params as Record<string, unknown>).projectId);
    if (!(await projectOwned(pool, projectId, auth.ownerId))) return fail(reply, 'PROJECT_NOT_FOUND', 'Project not found.');
    const result = await pool.query('SELECT id,name,prefix,scopes,created_at,expires_at,revoked_at,last_used_at,replaced_by FROM api_keys WHERE project_id=$1 ORDER BY created_at DESC', [projectId]);
    return { data: result.rows };
  });

  app.post('/workspace/projects/:projectId/keys', async (request, reply) => {
    const auth = await sessionAuth(pool, request, reply);
    if (!auth || !requireCsrf(auth, request, reply)) return;
    const projectId = stringParam((request.params as Record<string, unknown>).projectId);
    const project = await projectOwned(pool, projectId, auth.ownerId);
    if (!project) return fail(reply, 'PROJECT_NOT_FOUND', 'Project not found.');
    if (project.archived_at) return fail(reply, 'PROJECT_ARCHIVED', 'Restore the project before creating a key.');
    const parsed = apiKeyCreateSchema.safeParse(request.body);
    if (!parsed.success) return fail(reply, 'INVALID_REQUEST', parsed.error.issues[0]?.message ?? 'Invalid key request.');
    const prefix = `${API_KEY_PREFIX}${randomToken(9)}`;
    const secret = `${prefix}.${randomToken(32)}`;
    const result = await pool.query(
      `INSERT INTO api_keys(project_id,name,prefix,secret_hash,scopes,expires_at)
       VALUES ($1,$2,$3,$4,$5,now()+($6::text || ' days')::interval)
       RETURNING id,name,prefix,scopes,created_at,expires_at`,
      [projectId, parsed.data.name, prefix, sha256Hex(secret), parsed.data.scopes, parsed.data.expiresInDays],
    );
    return reply.code(201).send({ data: result.rows[0], secret, secretShownOnce: true });
  });

  app.post('/workspace/projects/:projectId/keys/:keyId/revoke', async (request, reply) => {
    const auth = await sessionAuth(pool, request, reply);
    if (!auth || !requireCsrf(auth, request, reply)) return;
    const params = request.params as Record<string, unknown>;
    const projectId = stringParam(params.projectId);
    if (!(await projectOwned(pool, projectId, auth.ownerId))) return fail(reply, 'PROJECT_NOT_FOUND', 'Project not found.');
    const result = await pool.query('UPDATE api_keys SET revoked_at=COALESCE(revoked_at,now()) WHERE id=$1 AND project_id=$2 RETURNING id,revoked_at', [stringParam(params.keyId), projectId]);
    if (!result.rowCount) return fail(reply, 'NOT_FOUND', 'Key not found.');
    return { data: result.rows[0] };
  });

  registerV1(app, pool);
  registerWorkspace(app, pool, deps);

  app.setErrorHandler((error, request, reply) => {
    if (reply.sent) return;
    const status = (error as { statusCode?: number }).statusCode;
    if (status === 429) return reply.code(429).send({ error: { code: 'RATE_LIMITED', message: (error as Error).message, requestId: request.id } });
    if (status === 413) return fail(reply, 'PAYLOAD_TOO_LARGE', 'Request body is too large.');
    if (status === 400 || (error as { code?: string }).code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') return fail(reply, 'INVALID_REQUEST', 'The request body could not be parsed.');
    request.log.error({ err: error }, 'request failed');
    fail(reply, 'INTERNAL', 'The request could not be completed.', request.id);
  });
  return app;
}

if (process.env.NODE_ENV !== 'test') {
  const host = process.env.API_HOST ?? '127.0.0.1';
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(host);
  if (process.env.NODE_ENV === 'production' && process.env.SESSION_COOKIE_SECURE !== '1') {
    throw new Error('Refusing to start in production without SESSION_COOKIE_SECURE=1 (HTTPS-only session cookies).');
  }
  if (!loopback && process.env.NODE_ENV !== 'production') {
    console.warn(`[api] listening on ${host} outside production mode. Use only on a private network.`);
  }
  const app = await buildServer();
  const port = Number(process.env.API_PORT ?? 4100);
  await app.listen({ host, port });
}

// Exported for one-time owner bootstrap tests/tools that need the same policy.
export const passwordPolicy = { hash: hashPassword };
