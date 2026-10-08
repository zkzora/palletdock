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
import { decodeCursor, encodeCursor, normalizedFilterHash } from './cursor.js';

loadEnv();

const SESSION_COOKIE = 'palletdock_session';
const CURSOR_SECRET = process.env.PALLETDOCK_CURSOR_SECRET ?? 'local-development-cursor-secret-change-me';

interface SessionAuth {
  ownerId: string;
  sessionId: string;
  csrfToken: string;
  email: string;
}

interface KeyAuth {
  keyId: string;
  projectId: string;
  scopes: ReadScope[];
}

function fail(reply: FastifyReply, code: ErrorCode, message: string, requestId?: string): FastifyReply {
  return reply.code(ERROR_CODES[code]).send({ error: { code, message, requestId: requestId ?? reply.request.id } });
}

function stringParam(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function requestedLimit(query: Record<string, unknown>): number {
  const value = query.limit == null ? API_DEFAULT_LIMIT : Number(query.limit);
  if (!Number.isInteger(value) || value < 1 || value > API_MAX_LIMIT) throw new Error(`limit must be between 1 and ${API_MAX_LIMIT}`);
  return value;
}

function exactDecimal(value: unknown, label: string): string | null {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`${label} must be a non-negative decimal integer`);
  return value;
}

async function sessionAuth(pool: pg.Pool, request: FastifyRequest, reply: FastifyReply): Promise<SessionAuth | null> {
  const token = request.cookies[SESSION_COOKIE];
  if (!token) {
    fail(reply, 'UNAUTHORIZED', 'Sign in to continue.');
    return null;
  }
  const result = await pool.query(
    `SELECT s.id AS session_id, s.csrf_token, o.id AS owner_id, o.email
       FROM sessions s JOIN owners o ON o.id=s.owner_id
      WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
    [sha256Hex(token)],
  );
  if (!result.rowCount) {
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    fail(reply, 'UNAUTHORIZED', 'Session expired. Sign in again.');
    return null;
  }
  const row = result.rows[0];
  await pool.query('UPDATE sessions SET last_seen_at=now() WHERE id=$1', [row.session_id]);
  return { ownerId: row.owner_id, sessionId: row.session_id, csrfToken: row.csrf_token, email: row.email };
}

function requireCsrf(auth: SessionAuth, request: FastifyRequest, reply: FastifyReply): boolean {
  const supplied = request.headers['x-csrf-token'];
  if (typeof supplied !== 'string' || !safeEqualStr(supplied, auth.csrfToken)) {
    fail(reply, 'CSRF_REJECTED', 'The CSRF token is missing or invalid. Refresh the session and try again.');
    return false;
  }
  return true;
}

async function keyAuth(pool: pg.Pool, request: FastifyRequest, reply: FastifyReply, projectId: string, scope: ReadScope): Promise<KeyAuth | null> {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith('Bearer ')) {
    fail(reply, 'UNAUTHORIZED', 'Provide a project read key as a Bearer token.');
    return null;
  }
  const token = authorization.slice(7).trim();
  const dot = token.indexOf('.');
  const prefix = dot > 0 ? token.slice(0, dot) : '';
  if (!prefix.startsWith(API_KEY_PREFIX) || token.length > 256) {
    fail(reply, 'UNAUTHORIZED', 'The project read key is invalid.');
    return null;
  }
  const result = await pool.query(
    `SELECT id, project_id, secret_hash, scopes
       FROM api_keys
      WHERE prefix=$1 AND revoked_at IS NULL AND expires_at > now()`,
    [prefix],
  );
  const row = result.rows[0];
  if (!row || !safeEqualStr(row.secret_hash, sha256Hex(token))) {
    fail(reply, 'UNAUTHORIZED', 'The project read key is invalid or expired.');
    return null;
  }
  if (row.project_id !== projectId) {
    fail(reply, 'PROJECT_NOT_FOUND', 'Project not found for this key.');
    return null;
  }
  if (!row.scopes.includes(scope)) {
    fail(reply, 'FORBIDDEN_SCOPE', `This key does not grant ${scope}.`);
    return null;
  }
  await pool.query('UPDATE api_keys SET last_used_at=now() WHERE id=$1', [row.id]);
  return { keyId: row.id, projectId: row.project_id, scopes: row.scopes };
}

async function projectOwned(pool: pg.Pool, projectId: string, ownerId: string): Promise<Record<string, unknown> | null> {
  const result = await pool.query('SELECT * FROM projects WHERE id=$1 AND owner_id=$2', [projectId, ownerId]);
  return result.rows[0] ?? null;
}

async function responseMeta(pool: pg.Pool, projectId: string) {
  const [fingerprint, checkpoints] = await Promise.all([
    pool.query(`SELECT id, genesis_hash, evm_chain_id::text, last_verified_at FROM network_fingerprints WHERE network_id='portaldot-v3-testnet' AND status='active' LIMIT 1`),
    pool.query(
      `SELECT s.id AS source_id, s.start_block::text, s.end_block::text, c.block_number::text, c.block_hash, c.committed_at
         FROM indexer_sources s LEFT JOIN indexer_checkpoints c ON c.source_id=s.id
        WHERE s.project_id=$1 ORDER BY s.created_at`,
      [projectId],
    ),
  ]);
  const fp = fingerprint.rows[0] ?? null;
  return {
    networkId: 'portaldot-v3-testnet',
    networkFingerprint: fp ? `${fp.genesis_hash}:${fp.evm_chain_id}` : null,
    chainLayer: 'evm' as const,
    observedAt: new Date().toISOString(),
    checkpoint: checkpoints.rows.find((row: { block_number?: string | null }) => row.block_number) ?? null,
    coverage: checkpoints.rows
      .filter((row: { block_number?: string | null }) => row.block_number)
      .map((row: { source_id: string; start_block: string; block_number: string }) => ({ sourceId: row.source_id, fromBlock: row.start_block, toBlock: row.block_number, status: 'complete' as const })),
    finalityPolicy: 'included-with-explicit-finality' as const,
    finality: 'unknown' as const,
  };
}

export async function buildServer(pool = createPool()): Promise<FastifyInstance> {
  const app = Fastify({ logger: true, bodyLimit: 2 * 1024 * 1024, trustProxy: false });
  await app.register(cookie);
  await app.register(cors, { origin: process.env.WEB_ORIGIN ?? 'http://127.0.0.1:3000', credentials: true });
  await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });

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
    const [counts, source, transactions, events] = await Promise.all([
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
        `SELECT id,hash,kind,function_name,submission_status,inclusion_status,execution_status,created_at
           FROM transactions WHERE project_id=$1 ORDER BY created_at DESC LIMIT 5`,
        [projectId],
      ),
      pool.query(
        `SELECT r.seq::text,r.block_number::text,r.transaction_hash,d.event_name,d.status,r.indexed_at
           FROM raw_logs r LEFT JOIN decoded_events d ON d.raw_log_id=r.id
          WHERE r.project_id=$1 AND r.canonical=true ORDER BY r.seq DESC LIMIT 5`,
        [projectId],
      ),
    ]);
    return { data: { project, counts: counts.rows[0], indexer: source.rows[0] ?? null, transactions: transactions.rows, events: events.rows } };
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
      await client.query(`UPDATE indexer_sources SET desired_state='archived',generation=generation+1,updated_at=now() WHERE project_id=$1 AND desired_state <> 'archived'`, [projectId]);
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

  async function readList(request: FastifyRequest, reply: FastifyReply, resource: 'contracts' | 'transactions' | 'indexer') {
    const projectId = stringParam((request.params as Record<string, unknown>).projectId);
    const scope = `${resource}:read` as ReadScope;
    if (!(await keyAuth(pool, request, reply, projectId, scope))) return;
    const query = (request.query ?? {}) as Record<string, unknown>;
    let limit: number;
    try {
      limit = requestedLimit(query);
    } catch (error) {
      return fail(reply, 'INVALID_QUERY', (error as Error).message);
    }
    const filterHash = normalizedFilterHash(query);
    let snapshot = new Date().toISOString();
    let after: string[] = [];
    if (typeof query.cursor === 'string') {
      try {
        const decoded = decodeCursor(query.cursor, { resource, projectId, filterHash }, CURSOR_SECRET);
        snapshot = decoded.snapshot;
        after = decoded.after;
      } catch (error) {
        return fail(reply, 'CURSOR_RESTART_REQUIRED', (error as Error).message);
      }
    }
    const table = resource === 'indexer' ? 'indexer_sources' : resource;
    const fields =
      resource === 'contracts'
        ? 'id,name,address,source,deploy_tx_hash,deploy_block::text,code_observed,created_at'
        : resource === 'transactions'
          ? 'id,contract_id,origin,kind,hash,from_address,to_address,value_raw::text,submission_status,inclusion_status,execution_status,finality_status,indexing_status,block_number::text,block_hash,gas_used::text,effective_gas_price::text,fee_raw::text,created_at,updated_at'
          : 'id,contract_id,contract_address,event_names,start_block::text,end_block::text,desired_state,status,generation::text,last_error,latest_observed_block::text,latest_observed_at,created_at,updated_at';
    const conditions = ['project_id=$1', 'created_at <= $2'];
    const values: unknown[] = [projectId, snapshot];
    if (resource === 'contracts') conditions.push('removed_at IS NULL');
    if (after.length) {
      if (after.length !== 2) return fail(reply, 'CURSOR_RESTART_REQUIRED', 'Cursor position is invalid.');
      values.push(after[0], after[1]);
      conditions.push(`(created_at,id) < ($${values.length - 1}::timestamptz,$${values.length}::uuid)`);
    }
    values.push(limit + 1);
    const result = await pool.query(`SELECT ${fields} FROM ${table} WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC,id DESC LIMIT $${values.length}`, values);
    const hasMore = result.rows.length > limit;
    const data = result.rows.slice(0, limit);
    const last = data.at(-1);
    const nextCursor =
      hasMore && last
        ? encodeCursor({ resource, projectId, filterHash, snapshot, after: [new Date(last.created_at).toISOString(), last.id] }, CURSOR_SECRET)
        : null;
    return { requestId: request.id, data, nextCursor, meta: await responseMeta(pool, projectId) };
  }

  app.get('/v1/projects/:projectId/contracts', (request, reply) => readList(request, reply, 'contracts'));
  app.get('/v1/projects/:projectId/transactions', (request, reply) => readList(request, reply, 'transactions'));
  app.get('/v1/projects/:projectId/indexer', (request, reply) => readList(request, reply, 'indexer'));

  app.get('/v1/projects/:projectId/events', async (request, reply) => {
    const projectId = stringParam((request.params as Record<string, unknown>).projectId);
    if (!(await keyAuth(pool, request, reply, projectId, 'events:read'))) return;
    const query = (request.query ?? {}) as Record<string, unknown>;
    let limit: number;
    let fromBlock: string | null;
    let toBlock: string | null;
    try {
      limit = requestedLimit(query);
      fromBlock = exactDecimal(query.fromBlock, 'fromBlock');
      toBlock = exactDecimal(query.toBlock, 'toBlock');
      if (fromBlock && toBlock && BigInt(toBlock) < BigInt(fromBlock)) throw new Error('toBlock must be greater than or equal to fromBlock');
    } catch (error) {
      return fail(reply, 'INVALID_QUERY', (error as Error).message);
    }
    const filterHash = normalizedFilterHash(query);
    let snapshot: string;
    let after: string[] = [];
    if (typeof query.cursor === 'string') {
      try {
        const decoded = decodeCursor(query.cursor, { resource: 'events', projectId, filterHash }, CURSOR_SECRET);
        snapshot = decoded.snapshot;
        after = decoded.after;
      } catch (error) {
        return fail(reply, 'CURSOR_RESTART_REQUIRED', (error as Error).message);
      }
    } else {
      snapshot = (await pool.query('SELECT COALESCE(max(seq),0)::text AS snapshot FROM raw_logs WHERE project_id=$1 AND canonical=true', [projectId])).rows[0].snapshot;
    }
    const conditions = ['r.project_id=$1', 'r.canonical=true', 'r.seq <= $2::bigint'];
    const values: unknown[] = [projectId, snapshot];
    if (after.length) {
      if (after.length !== 1 || !/^[0-9]+$/.test(after[0])) return fail(reply, 'CURSOR_RESTART_REQUIRED', 'Cursor position is invalid.');
      values.push(after[0]);
      conditions.push(`r.seq < $${values.length}::bigint`);
    }
    if (fromBlock) {
      values.push(fromBlock);
      conditions.push(`r.block_number >= $${values.length}::bigint`);
    }
    if (toBlock) {
      values.push(toBlock);
      conditions.push(`r.block_number <= $${values.length}::bigint`);
    }
    if (typeof query.contract === 'string' && query.contract) {
      values.push(query.contract.toLowerCase());
      conditions.push(`lower(r.contract_address)=$${values.length}`);
    }
    if (typeof query.event === 'string' && query.event) {
      values.push(query.event);
      conditions.push(`(d.event_name=$${values.length} OR d.event_signature=$${values.length})`);
    }
    values.push(limit + 1);
    const result = await pool.query(
      `SELECT r.seq::text,r.source_id,r.contract_address,r.block_number::text,r.block_hash,r.transaction_hash,r.transaction_index,r.log_index,r.topics,r.data,r.indexed_at,
              d.status AS decode_status,d.event_name,d.event_signature,d.args,d.decode_error
         FROM raw_logs r LEFT JOIN decoded_events d ON d.raw_log_id=r.id
        WHERE ${conditions.join(' AND ')} ORDER BY r.seq DESC LIMIT $${values.length}`,
      values,
    );
    const hasMore = result.rows.length > limit;
    const data = result.rows.slice(0, limit);
    const last = data.at(-1);
    const nextCursor = hasMore && last ? encodeCursor({ resource: 'events', projectId, filterHash, snapshot, after: [last.seq] }, CURSOR_SECRET) : null;
    return { requestId: request.id, data, nextCursor, meta: await responseMeta(pool, projectId) };
  });

  app.setErrorHandler((error, request, reply) => {
    request.log.error({ err: error }, 'request failed');
    if (reply.sent) return;
    fail(reply, 'INTERNAL', 'The request could not be completed.', request.id);
  });
  return app;
}

if (process.env.NODE_ENV !== 'test') {
  const app = await buildServer();
  const host = process.env.API_HOST ?? '127.0.0.1';
  const port = Number(process.env.API_PORT ?? 4100);
  await app.listen({ host, port });
}

// Exported for one-time owner bootstrap tests/tools that need the same policy.
export const passwordPolicy = { hash: hashPassword };
