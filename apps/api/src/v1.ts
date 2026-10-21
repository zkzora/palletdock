import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { API_DEFAULT_LIMIT, API_MAX_LIMIT, evmUnitNote, type ReadScope } from '@palletdock/shared';
import { decodeCursor, encodeCursor, normalizedFilterHash } from './cursor.js';
import { activeUnitPolicy, cursorSecret, fail, isUuid, keyAuth, param } from './context.js';

/**
 * Public, project-scoped, read-only API. Authenticated by project read keys
 * (Bearer). Keys never authorize workspace mutations or signing.
 *
 * Snapshot/reorg policy: the first page fixes a snapshot made of the highest
 * ingested log sequence, the active network fingerprint, and the sum of the
 * project's source reorg epochs. A cursor whose snapshot no longer matches
 * (rollback, reindex, or network reset) returns 409 CURSOR_RESTART_REQUIRED.
 */

const ALLOWED: Record<string, string[]> = {
  contracts: ['limit', 'cursor', 'address'],
  transactions: ['limit', 'cursor', 'executionStatus', 'inclusionStatus', 'contract', 'hash'],
  events: ['limit', 'cursor', 'contract', 'event', 'fromBlock', 'toBlock', 'finality'],
  indexer: ['limit', 'cursor'],
};

class QueryError extends Error {}

function limitOf(q: Record<string, unknown>): number {
  if (q.limit == null || q.limit === '') return API_DEFAULT_LIMIT;
  if (typeof q.limit !== 'string' || !/^[0-9]{1,3}$/.test(q.limit)) throw new QueryError(`limit must be an integer between 1 and ${API_MAX_LIMIT}`);
  const n = Number(q.limit);
  if (n < 1 || n > API_MAX_LIMIT) throw new QueryError(`limit must be an integer between 1 and ${API_MAX_LIMIT}`);
  return n;
}

function dec(q: Record<string, unknown>, key: string): string | null {
  const v = q[key];
  if (v == null || v === '') return null;
  if (typeof v !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(v)) throw new QueryError(`${key} must be a non-negative decimal integer`);
  return v;
}

function addr(q: Record<string, unknown>, key: string): string | null {
  const v = q[key];
  if (v == null || v === '') return null;
  if (typeof v !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(v)) throw new QueryError(`${key} must be a 20-byte 0x address`);
  return v.toLowerCase();
}

function oneOf(q: Record<string, unknown>, key: string, values: string[]): string | null {
  const v = q[key];
  if (v == null || v === '') return null;
  if (typeof v !== 'string' || !values.includes(v)) throw new QueryError(`${key} must be one of: ${values.join(', ')}`);
  return v;
}

export async function projectMeta(pool: pg.Pool, projectId: string) {
  const [fp, sources] = await Promise.all([
    pool.query(`SELECT id, genesis_hash, evm_chain_id::text, last_verified_at FROM network_fingerprints WHERE network_id='portaldot-v3-testnet' AND status='active' LIMIT 1`),
    pool.query(
      `SELECT s.id, s.contract_address, s.start_block::text, s.end_block::text, s.status, s.reorg_epoch::text, s.latest_observed_block::text, s.latest_observed_at,
              c.block_number::text AS cp_block, c.block_hash AS cp_hash, c.committed_at AS cp_at
         FROM indexer_sources s LEFT JOIN indexer_checkpoints c ON c.source_id=s.id
        WHERE s.project_id=$1 AND s.desired_state <> 'deleted' ORDER BY s.created_at`,
      [projectId],
    ),
  ]);
  const f = fp.rows[0] ?? null;
  const latestCp = sources.rows.filter((s) => s.cp_block).sort((a, b) => (a.cp_at < b.cp_at ? 1 : -1))[0];
  return {
    networkId: 'portaldot-v3-testnet',
    networkFingerprint: f ? { id: f.id, genesisHash: f.genesis_hash, evmChainId: f.evm_chain_id, lastVerifiedAt: f.last_verified_at } : null,
    chainLayer: 'evm' as const,
    observedAt: new Date().toISOString(),
    checkpoint: latestCp ? { sourceId: latestCp.id, blockNumber: latestCp.cp_block, blockHash: latestCp.cp_hash, committedAt: latestCp.cp_at } : null,
    coverage: sources.rows.map((s) => ({
      sourceId: s.id,
      contractAddress: s.contract_address,
      requested: { fromBlock: s.start_block, toBlock: s.end_block },
      completed: s.cp_block ? { fromBlock: s.start_block, toBlock: s.cp_block, blockHash: s.cp_hash, committedAt: s.cp_at } : null,
      status: s.status,
      latestObservedBlock: s.latest_observed_block,
      latestObservedAt: s.latest_observed_at,
      lagBlocks: s.cp_block && s.latest_observed_block ? String(BigInt(s.latest_observed_block) > BigInt(s.cp_block) ? BigInt(s.latest_observed_block) - BigInt(s.cp_block) : 0n) : null,
    })),
    finalityPolicy: 'included-with-explicit-finality' as const,
    finality: 'unknown' as const,
    finalityNote: 'No adapter proving EVM-block-to-native-finality is available; inclusion is not finality.',
    _epochs: sources.rows.reduce((acc, s) => acc + BigInt(s.reorg_epoch), 0n).toString(),
    _fingerprintId: f?.id ?? 'none',
  };
}

function publicMeta(m: Awaited<ReturnType<typeof projectMeta>>) {
  const { _epochs, _fingerprintId, ...rest } = m;
  return rest;
}

export function registerV1(app: FastifyInstance, pool: pg.Pool) {
  const secret = cursorSecret();

  async function begin(request: FastifyRequest, reply: FastifyReply, resource: keyof typeof ALLOWED) {
    const projectId = param(request, 'projectId');
    const scope = `${resource}:read` as ReadScope;
    if (!(await keyAuth(pool, request, reply, projectId, scope))) return null;
    if (!isUuid(projectId)) {
      fail(reply, 'PROJECT_NOT_FOUND', 'Project not found for this key.');
      return null;
    }
    const q = (request.query ?? {}) as Record<string, unknown>;
    const unknown = Object.keys(q).filter((k) => !ALLOWED[resource].includes(k));
    if (unknown.length) {
      fail(reply, 'INVALID_QUERY', `Unsupported query parameter(s): ${unknown.join(', ')}`);
      return null;
    }
    if (Object.values(q).some((v) => Array.isArray(v))) {
      fail(reply, 'INVALID_QUERY', 'Repeated query parameters are not supported.');
      return null;
    }
    return { projectId, q, filterHash: normalizedFilterHash(q) };
  }

  function cursorOf(q: Record<string, unknown>, resource: string, projectId: string, filterHash: string) {
    if (typeof q.cursor !== 'string' || !q.cursor) return null;
    return decodeCursor(q.cursor, { resource, projectId, filterHash }, secret);
  }

  function respond(request: FastifyRequest, data: unknown[], nextCursor: string | null, meta: Awaited<ReturnType<typeof projectMeta>>, extra: Record<string, unknown> = {}) {
    return { requestId: request.id, data, nextCursor, meta: { ...publicMeta(meta), ...extra } };
  }

  // ------------------------------------------------------------------ events
  app.get('/v1/projects/:projectId/events', async (request, reply) => {
    const b = await begin(request, reply, 'events');
    if (!b) return;
    const { projectId, q, filterHash } = b;
    let limit: number, fromBlock: string | null, toBlock: string | null, contract: string | null, finality: string | null;
    try {
      limit = limitOf(q);
      fromBlock = dec(q, 'fromBlock');
      toBlock = dec(q, 'toBlock');
      if (fromBlock && toBlock && BigInt(toBlock) < BigInt(fromBlock)) throw new QueryError('toBlock must be greater than or equal to fromBlock');
      if (fromBlock && toBlock && BigInt(toBlock) - BigInt(fromBlock) > 10_000_000n) throw new QueryError('Block range is limited to 10,000,000 blocks');
      contract = addr(q, 'contract');
      finality = oneOf(q, 'finality', ['unknown', 'finalized']);
      if (q.event != null && (typeof q.event !== 'string' || q.event.length > 200)) throw new QueryError('event must be an event name or signature');
    } catch (e) {
      return fail(reply, 'INVALID_QUERY', (e as Error).message);
    }
    const meta = await projectMeta(pool, projectId);
    let snapshot: string;
    let after: string[] = [];
    try {
      const c = cursorOf(q, 'events', projectId, filterHash);
      if (c) {
        const [seq, fpId, epochs] = c.snapshot.split('|');
        if (fpId !== meta._fingerprintId) throw new Error('The network fingerprint changed since this cursor was issued. Restart pagination without a cursor.');
        if (epochs !== meta._epochs) throw new Error('Indexed data was rolled back or reindexed since this cursor was issued. Restart pagination without a cursor.');
        if (!/^[0-9]+$/.test(seq) || c.after.length !== 4 || c.after.some((x) => !/^[0-9]+$/.test(x))) throw new Error('Cursor position is invalid.');
        snapshot = c.snapshot;
        after = c.after;
      } else {
        const max = (await pool.query('SELECT COALESCE(max(seq),0)::text AS s FROM raw_logs WHERE project_id=$1', [projectId])).rows[0].s;
        snapshot = `${max}|${meta._fingerprintId}|${meta._epochs}`;
      }
    } catch (e) {
      return fail(reply, 'CURSOR_RESTART_REQUIRED', (e as Error).message);
    }
    if (finality === 'finalized') {
      // Nothing is proven finalized; an empty result here is explicit, not missing data.
      return respond(request, [], null, meta, { filterNote: 'No record is marked finalized because no verified finality adapter exists.' });
    }
    const values: unknown[] = [projectId, snapshot.split('|')[0], meta._fingerprintId === 'none' ? null : meta._fingerprintId];
    const cond = ['r.project_id=$1', 'r.canonical=true', 'r.seq <= $2::bigint', 'r.fingerprint_id = $3::uuid', `s.desired_state <> 'deleted'`];
    const push = (sql: (i: number) => string, v: unknown) => {
      values.push(v);
      cond.push(sql(values.length));
    };
    if (after.length) {
      values.push(after[0], after[1], after[2], after[3]);
      const n = values.length;
      cond.push(`(r.block_number, r.transaction_index, r.log_index, r.seq) > ($${n - 3}::bigint, $${n - 2}::int, $${n - 1}::int, $${n}::bigint)`);
    }
    if (fromBlock) push((i) => `r.block_number >= $${i}::bigint`, fromBlock);
    if (toBlock) push((i) => `r.block_number <= $${i}::bigint`, toBlock);
    if (contract) push((i) => `r.contract_address = $${i}`, contract);
    if (typeof q.event === 'string' && q.event) push((i) => `(d.event_name = $${i} OR d.event_signature = $${i})`, q.event);
    values.push(limit + 1);
    const rows = (
      await pool.query(
        `SELECT r.id, r.seq::text, r.source_id, r.contract_address, r.block_number::text, r.block_hash, r.transaction_hash, r.transaction_index, r.log_index,
                r.topics, r.data, r.indexed_at, d.status AS decode_status, d.event_name, d.event_signature, d.args, d.decode_error,
                av.version AS abi_version
           FROM raw_logs r
           JOIN indexer_sources s ON s.id=r.source_id
           LEFT JOIN decoded_events d ON d.raw_log_id=r.id
           LEFT JOIN abi_versions av ON av.id=d.abi_version_id
          WHERE ${cond.join(' AND ')}
          ORDER BY r.block_number, r.transaction_index, r.log_index, r.seq
          LIMIT $${values.length}`,
        values,
      )
    ).rows;
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    const next =
      rows.length > limit && last
        ? encodeCursor({ resource: 'events', projectId, filterHash, snapshot, after: [last.block_number, String(last.transaction_index), String(last.log_index), last.seq] }, secret)
        : null;
    const data = page.map((r) => ({
      id: r.id,
      networkId: 'portaldot-v3-testnet',
      chainLayer: 'evm',
      contractAddress: r.contract_address,
      blockNumber: r.block_number,
      blockHash: r.block_hash,
      transactionHash: r.transaction_hash,
      transactionIndex: r.transaction_index,
      logIndex: r.log_index,
      topics: r.topics,
      data: r.data,
      decodeStatus: r.decode_status ?? 'not_decoded',
      event: r.decode_status === 'decoded' ? { name: r.event_name, signature: r.event_signature, args: r.args } : null,
      decodeError: r.decode_error,
      abiVersion: r.abi_version,
      indexedAt: r.indexed_at,
      sourceId: r.source_id,
      finality: 'unknown',
    }));
    return respond(request, data, next, meta);
  });

  // ------------------------------------------------------------------ contracts
  app.get('/v1/projects/:projectId/contracts', async (request, reply) => {
    const b = await begin(request, reply, 'contracts');
    if (!b) return;
    const { projectId, q, filterHash } = b;
    let limit: number, address: string | null;
    try {
      limit = limitOf(q);
      address = addr(q, 'address');
    } catch (e) {
      return fail(reply, 'INVALID_QUERY', (e as Error).message);
    }
    const meta = await projectMeta(pool, projectId);
    let snapshot = new Date().toISOString();
    let after: string[] = [];
    try {
      const c = cursorOf(q, 'contracts', projectId, filterHash);
      if (c) {
        if (c.after.length !== 2) throw new Error('Cursor position is invalid.');
        snapshot = c.snapshot;
        after = c.after;
      }
    } catch (e) {
      return fail(reply, 'CURSOR_RESTART_REQUIRED', (e as Error).message);
    }
    const values: unknown[] = [projectId, snapshot];
    const cond = ['c.project_id=$1', 'c.created_at <= $2::timestamptz', 'c.removed_at IS NULL'];
    if (address) {
      values.push(address);
      cond.push(`lower(c.address) = $${values.length}`);
    }
    if (after.length) {
      values.push(after[0], after[1]);
      cond.push(`(c.created_at, c.id) > ($${values.length - 1}::timestamptz, $${values.length}::uuid)`);
    }
    values.push(limit + 1);
    const rows = (
      await pool.query(
        `SELECT c.id, c.name, c.address, c.source, c.deploy_tx_hash, c.deploy_block::text, c.created_at, f.genesis_hash,
                (SELECT json_build_object('version', a.version, 'sha256', a.abi_sha256, 'provenance', a.provenance, 'createdAt', a.created_at)
                   FROM abi_versions a WHERE a.contract_id=c.id ORDER BY a.version DESC LIMIT 1) AS abi
           FROM contracts c JOIN network_fingerprints f ON f.id=c.fingerprint_id
          WHERE ${cond.join(' AND ')} ORDER BY c.created_at, c.id LIMIT $${values.length}`,
        values,
      )
    ).rows;
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    const next = rows.length > limit && last ? encodeCursor({ resource: 'contracts', projectId, filterHash, snapshot, after: [new Date(last.created_at).toISOString(), last.id] }, secret) : null;
    return respond(
      request,
      page.map((r) => ({
        id: r.id,
        networkId: 'portaldot-v3-testnet',
        networkGenesisHash: r.genesis_hash,
        name: r.name,
        address: r.address,
        source: r.source,
        deployTransactionHash: r.deploy_tx_hash,
        deployBlock: r.deploy_block,
        abi: r.abi,
        interface: 'evm-abi',
        verificationStatus: 'unavailable',
        createdAt: r.created_at,
      })),
      next,
      meta,
    );
  });

  // ------------------------------------------------------------------ transactions
  app.get('/v1/projects/:projectId/transactions', async (request, reply) => {
    const b = await begin(request, reply, 'transactions');
    if (!b) return;
    const { projectId, q, filterHash } = b;
    let limit: number, exec: string | null, incl: string | null, contract: string | null;
    try {
      limit = limitOf(q);
      exec = oneOf(q, 'executionStatus', ['success', 'reverted', 'unknown']);
      incl = oneOf(q, 'inclusionStatus', ['not_observed', 'pending', 'included', 'reorged_out']);
      contract = addr(q, 'contract');
      if (q.hash != null && (typeof q.hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(q.hash))) throw new QueryError('hash must be a 32-byte 0x transaction hash');
    } catch (e) {
      return fail(reply, 'INVALID_QUERY', (e as Error).message);
    }
    const meta = await projectMeta(pool, projectId);
    let snapshot = new Date().toISOString();
    let after: string[] = [];
    try {
      const c = cursorOf(q, 'transactions', projectId, filterHash);
      if (c) {
        if (c.after.length !== 2) throw new Error('Cursor position is invalid.');
        snapshot = c.snapshot;
        after = c.after;
      }
    } catch (e) {
      return fail(reply, 'CURSOR_RESTART_REQUIRED', (e as Error).message);
    }
    const values: unknown[] = [projectId, snapshot];
    const cond = ['t.project_id=$1', 't.created_at <= $2::timestamptz', 't.hash IS NOT NULL'];
    const push = (sql: (i: number) => string, v: unknown) => {
      values.push(v);
      cond.push(sql(values.length));
    };
    if (exec) push((i) => `t.execution_status = $${i}`, exec);
    if (incl) push((i) => `t.inclusion_status = $${i}`, incl);
    if (contract) push((i) => `(lower(t.to_address) = $${i} OR lower(t.contract_address) = $${i})`, contract);
    if (typeof q.hash === 'string' && q.hash) push((i) => `lower(t.hash) = $${i}`, q.hash.toLowerCase());
    if (after.length) {
      values.push(after[0], after[1]);
      cond.push(`(t.created_at, t.id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`);
    }
    values.push(limit + 1);
    const rows = (
      await pool.query(
        `SELECT t.id, t.origin, t.kind, t.hash, t.from_address, t.to_address, t.contract_address, t.function_name, t.decoded_args, t.value_raw::text,
                t.submission_status, t.inclusion_status, t.execution_status, t.finality_status, t.indexing_status, t.block_number::text, t.block_hash,
                t.gas_used::text, t.effective_gas_price::text, t.fee_raw::text, t.created_at, t.updated_at
           FROM transactions t WHERE ${cond.join(' AND ')} ORDER BY t.created_at DESC, t.id DESC LIMIT $${values.length}`,
        values,
      )
    ).rows;
    const page = rows.slice(0, limit);
    const unitNote = evmUnitNote(await activeUnitPolicy(pool));
    const last = page.at(-1);
    const next = rows.length > limit && last ? encodeCursor({ resource: 'transactions', projectId, filterHash, snapshot, after: [new Date(last.created_at).toISOString(), last.id] }, secret) : null;
    return respond(
      request,
      page.map((t) => ({
        id: t.id,
        networkId: 'portaldot-v3-testnet',
        chainLayer: 'evm',
        hash: t.hash,
        origin: t.origin,
        kind: t.kind,
        from: t.from_address,
        to: t.to_address,
        contractAddress: t.contract_address,
        function: t.function_name,
        decodedArgs: t.decoded_args,
        valueRaw: t.value_raw,
        status: { submission: t.submission_status, inclusion: t.inclusion_status, execution: t.execution_status, finality: t.finality_status, indexing: t.indexing_status },
        blockNumber: t.block_number,
        blockHash: t.block_hash,
        gasUsed: t.gas_used,
        effectiveGasPriceRaw: t.effective_gas_price,
        feeRaw: t.fee_raw,
        unitNote,
        createdAt: t.created_at,
        updatedAt: t.updated_at,
      })),
      next,
      meta,
      { scope: 'Transactions submitted through PalletDock or explicitly registered. Not all wallet activity.' },
    );
  });

  // ------------------------------------------------------------------ indexer
  app.get('/v1/projects/:projectId/indexer', async (request, reply) => {
    const b = await begin(request, reply, 'indexer');
    if (!b) return;
    const { projectId, q } = b;
    try {
      limitOf(q);
      if (q.cursor) throw new QueryError('The indexer endpoint returns all sources in one page; cursor is not accepted.');
    } catch (e) {
      return fail(reply, 'INVALID_QUERY', (e as Error).message);
    }
    const meta = await projectMeta(pool, projectId);
    const rows = (
      await pool.query(
        `SELECT s.id, s.contract_id, s.contract_address, s.event_names, s.start_block::text, s.end_block::text, s.desired_state, s.status,
                s.reorg_epoch::text, s.last_error, s.last_error_at, s.latest_observed_block::text, s.latest_observed_at, s.finality_policy, s.created_at,
                c.block_number::text AS cp_block, c.block_hash AS cp_hash, c.committed_at AS cp_at, av.version AS abi_version
           FROM indexer_sources s LEFT JOIN indexer_checkpoints c ON c.source_id=s.id JOIN abi_versions av ON av.id=s.abi_version_id
          WHERE s.project_id=$1 AND s.desired_state <> 'deleted' ORDER BY s.created_at`,
        [projectId],
      )
    ).rows;
    return respond(
      request,
      rows.map((s) => ({
        id: s.id,
        contractId: s.contract_id,
        contractAddress: s.contract_address,
        events: s.event_names,
        abiVersion: s.abi_version,
        requestedRange: { fromBlock: s.start_block, toBlock: s.end_block },
        completedRange: s.cp_block ? { fromBlock: s.start_block, toBlock: s.cp_block } : null,
        checkpoint: s.cp_block ? { blockNumber: s.cp_block, blockHash: s.cp_hash, committedAt: s.cp_at } : null,
        latestObservedBlock: s.latest_observed_block,
        latestObservedAt: s.latest_observed_at,
        lagBlocks: s.cp_block && s.latest_observed_block ? String(BigInt(s.latest_observed_block) > BigInt(s.cp_block) ? BigInt(s.latest_observed_block) - BigInt(s.cp_block) : 0n) : null,
        desiredState: s.desired_state,
        status: s.status,
        reorgEpoch: s.reorg_epoch,
        lastError: s.last_error,
        lastErrorAt: s.last_error_at,
        finalityPolicy: s.finality_policy,
        finality: 'unknown',
      })),
      null,
      meta,
    );
  });
}

/** Persist one row per /v1 request (and workspace errors) for monitoring. Never stores headers or secrets. */
export function registerRequestLogging(app: FastifyInstance, pool: pg.Pool) {
  app.addHook('onResponse', async (request, reply) => {
    const url = request.routeOptions?.url ?? '';
    const isV1 = url.startsWith('/v1/');
    if (!isV1 && reply.statusCode < 400) return;
    if (url === '/health') return;
    const projectId = request.pdAuth?.projectId ?? (isV1 ? param(request, 'projectId') : '');
    try {
      await pool.query(
        `INSERT INTO request_logs(request_id,project_id,api_key_id,auth_kind,method,route,status,error_code,latency_ms)
         VALUES ($1,(SELECT id FROM projects WHERE id = CASE WHEN $2 ~* '^[0-9a-f-]{36}$' THEN $2::uuid END),$3,$4,$5,$6,$7,$8,$9)`,
        [
          request.id,
          projectId || '',
          request.pdAuth?.projectId ? request.pdAuth.keyId ?? null : null,
          request.pdAuth?.kind ?? 'none',
          request.method,
          (url || 'unmatched').slice(0, 200),
          reply.statusCode,
          request.pdErrorCode ?? null,
          Math.round(reply.elapsedTime),
        ],
      );
    } catch (e) {
      request.log.warn({ err: e }, 'request log insert failed');
    }
  });
}
