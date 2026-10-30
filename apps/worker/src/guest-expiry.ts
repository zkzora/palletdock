import type pg from 'pg';

/**
 * Maintenance for expired temporary playground workspaces. Authorization, indexer
 * claims/fencing, and receipt-tracker selection already refuse an expired guest;
 * this pass makes the shutdown durable: it revokes the guest's sessions and read
 * keys, stops and fences its indexer sources (generation + 1, so an in-flight
 * commit is discarded), and records it once.
 *
 * Bounded (LIMIT) and idempotent (guest_closed_at), and safe with several worker
 * instances: each guest row is claimed with FOR UPDATE SKIP LOCKED inside one
 * transaction. Records are retained (no deletion); see docs/PLAYGROUND.md for the
 * later purge procedure.
 */
export async function closeExpiredGuests(pool: pg.Pool, limit = 25): Promise<string[]> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const due = await c.query(
      `SELECT id FROM owners
        WHERE kind='guest' AND guest_expires_at <= now() AND guest_closed_at IS NULL
        ORDER BY guest_expires_at, id LIMIT $1
        FOR UPDATE SKIP LOCKED`,
      [limit],
    );
    const ids = due.rows.map((r) => r.id as string);
    if (ids.length) {
      await c.query(`UPDATE sessions SET revoked_at=now() WHERE owner_id = ANY($1::uuid[]) AND revoked_at IS NULL`, [ids]);
      await c.query(
        `UPDATE api_keys k SET revoked_at=now() FROM projects p WHERE p.id=k.project_id AND p.owner_id = ANY($1::uuid[]) AND k.revoked_at IS NULL`,
        [ids],
      );
      await c.query(
        `UPDATE indexer_sources s SET desired_state='archived',
                status=CASE WHEN s.status IN ('recovery_required','completed') THEN s.status ELSE 'stopped' END,
                generation=s.generation+1, updated_at=now()
           FROM projects p WHERE p.id=s.project_id AND p.owner_id = ANY($1::uuid[]) AND s.desired_state NOT IN ('archived','deleted')`,
        [ids],
      );
      await c.query(
        `INSERT INTO ops_logs(project_id,source,level,message)
         SELECT p.id,'worker','INFO','Temporary workspace expired: sessions and read keys revoked, indexer sources stopped and fenced. Records are retained; on-chain contracts and transactions are unchanged.'
           FROM projects p WHERE p.owner_id = ANY($1::uuid[])`,
        [ids],
      );
      await c.query(`UPDATE owners SET guest_closed_at=now() WHERE id = ANY($1::uuid[])`, [ids]);
    }
    await c.query('COMMIT');
    return ids;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}
