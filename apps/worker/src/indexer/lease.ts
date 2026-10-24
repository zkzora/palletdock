import type pg from 'pg';
import type { PoolClient } from '@palletdock/db';

/**
 * A held lease. Every write a worker makes for a source must happen inside a
 * transaction that first calls `assertFence`, which re-reads the job and the
 * source under row locks. Archive/pause/reset bump `indexer_sources.generation`
 * and a competing claim replaces `lease_token`, so either makes stale work fail
 * its fence instead of committing.
 */
export interface Lease {
  sourceId: string;
  owner: string;
  token: string;
  generation: string;
  expiresAt: Date;
}

export class LeaseLostError extends Error {
  constructor(
    public readonly sourceId: string,
    public readonly reason: string,
  ) {
    super(`Lease lost for indexer source ${sourceId}: ${reason}`);
    this.name = 'LeaseLostError';
  }
}

const CLAIMABLE = `
  s.desired_state = 'running'
  AND s.status NOT IN ('recovery_required','completed','stopped')
  AND p.archived_at IS NULL
`;

/**
 * Claim at most one due source. Uses SKIP LOCKED so concurrent workers never
 * block on, or double-claim, the same job. An expired lease can be taken over;
 * the previous holder is then fenced out by the new token.
 */
export async function claimNextLease(pool: pg.Pool, owner: string, ttlMs: number, onlySourceId?: string): Promise<Lease | null> {
  const result = await pool.query(
    `WITH candidate AS (
       SELECT j.source_id, s.generation
         FROM indexer_jobs j
         JOIN indexer_sources s ON s.id = j.source_id
         JOIN projects p ON p.id = s.project_id
        WHERE ${CLAIMABLE}
          AND j.next_run_at <= now()
          AND (j.lease_expires_at IS NULL OR j.lease_expires_at <= now())
          AND ($3::uuid IS NULL OR j.source_id = $3::uuid)
        ORDER BY j.next_run_at, j.source_id
        LIMIT 1
        FOR UPDATE OF j SKIP LOCKED
     )
     UPDATE indexer_jobs j
        SET lease_owner = $1,
            lease_token = gen_random_uuid(),
            lease_expires_at = now() + ($2::int * interval '1 millisecond'),
            lease_generation = c.generation,
            updated_at = now()
       FROM candidate c
      WHERE j.source_id = c.source_id
  RETURNING j.source_id, j.lease_owner, j.lease_token, j.lease_generation::text, j.lease_expires_at`,
    [owner, ttlMs, onlySourceId ?? null],
  );
  if (!result.rowCount) return null;
  const row = result.rows[0];
  return { sourceId: row.source_id, owner: row.lease_owner, token: row.lease_token, generation: row.lease_generation, expiresAt: row.lease_expires_at };
}

/** Extend a lease that is still held and unexpired. Throws LeaseLostError otherwise. */
export async function renewLease(pool: pg.Pool, lease: Lease, ttlMs: number): Promise<void> {
  const result = await pool.query(
    `UPDATE indexer_jobs j
        SET lease_expires_at = now() + ($3::int * interval '1 millisecond'), updated_at = now()
       FROM indexer_sources s
      WHERE j.source_id = $1 AND s.id = j.source_id
        AND j.lease_token = $2 AND j.lease_expires_at > now()
        AND s.generation = j.lease_generation AND s.desired_state = 'running'
  RETURNING j.lease_expires_at`,
    [lease.sourceId, lease.token, ttlMs],
  );
  if (!result.rowCount) throw new LeaseLostError(lease.sourceId, 'renewal refused (expired, replaced, or generation changed)');
  lease.expiresAt = result.rows[0].lease_expires_at;
}

/**
 * Lock the job and source rows and verify the lease is still ours. Must be the
 * first statement in every committing transaction. Locking the source row
 * serialises the commit with archive/pause, which update that same row.
 */
export async function assertFence(client: PoolClient, lease: Lease): Promise<void> {
  const result = await client.query(
    `SELECT j.lease_token, j.lease_expires_at > clock_timestamp() AS live, s.generation::text, s.desired_state, p.archived_at
       FROM indexer_jobs j
       JOIN indexer_sources s ON s.id = j.source_id
       JOIN projects p ON p.id = s.project_id
      WHERE j.source_id = $1
        FOR UPDATE OF j, s`,
    [lease.sourceId],
  );
  const row = result.rows[0];
  if (!row) throw new LeaseLostError(lease.sourceId, 'job no longer exists');
  if (row.lease_token !== lease.token) throw new LeaseLostError(lease.sourceId, 'lease was taken over by another worker');
  if (!row.live) throw new LeaseLostError(lease.sourceId, 'lease expired before commit');
  if (row.generation !== lease.generation) throw new LeaseLostError(lease.sourceId, `generation changed from ${lease.generation} to ${row.generation}`);
  if (row.desired_state !== 'running' || row.archived_at) throw new LeaseLostError(lease.sourceId, `source is ${row.archived_at ? 'archived' : row.desired_state}`);
}

export type AttemptPolicy = 'reset' | 'increment' | 'keep';

/**
 * Release a lease we still hold and schedule the next run. `reset` records a
 * successful step, `increment` a failure that feeds backoff, `keep` neither
 * (for example a range that was split before retrying). A no-op if fenced out.
 */
export async function releaseLease(pool: pg.Pool, lease: Lease, nextRunInMs: number, outcome: { attempts: AttemptPolicy; chunkSize?: number }): Promise<void> {
  await pool.query(
    `UPDATE indexer_jobs
        SET lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, lease_generation = NULL,
            next_run_at = now() + ($3::int * interval '1 millisecond'),
            attempts = CASE $4::text WHEN 'reset' THEN 0 WHEN 'increment' THEN attempts + 1 ELSE attempts END,
            last_success_at = CASE WHEN $4::text = 'reset' THEN now() ELSE last_success_at END,
            chunk_size = COALESCE($5, chunk_size),
            updated_at = now()
      WHERE source_id = $1 AND lease_token = $2`,
    [lease.sourceId, lease.token, Math.max(0, Math.round(nextRunInMs)), outcome.attempts, outcome.chunkSize ?? null],
  );
}
