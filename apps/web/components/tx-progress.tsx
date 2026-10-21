'use client';

import Link from 'next/link';
import { useWorkspace } from '@/components/workspace-shell';
import { useResource } from '@/lib/use-resource';
import { groupDigits, shortHash } from '@/lib/format';
import { statusCells, type StatusCell } from '@/lib/tx-status';
import type { Tone } from '@/components/ui';

export { statusCells, type TxStatus } from '@/lib/tx-status';

export function StatusCells({ cells }: { cells: StatusCell[] }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(180px,100%),1fr))', gap: 12 }}>
      {cells.map((c) => (
        <div key={c.k} className="card" style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span className="eyebrow" style={{ fontSize: 10.5 }}>
            {c.k}
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600 }}>
            {c.t}
          </span>
          <span className="dim" style={{ fontSize: 12, lineHeight: 1.45 }}>
            {c.n}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Polls a transaction record while it is in flight. */
export function TxProgress({ transactionId }: { transactionId: string }) {
  const { projectId, href } = useWorkspace();
  const { data } = useResource<{ data: any }>(projectId ? `/workspace/projects/${projectId}/transactions/${transactionId}` : null, { pollMs: 3000 });
  const t = data?.data;
  if (!t) return <div className="skeleton" style={{ height: 120 }} />;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div>
        <div className="eyebrow">{t.kind === 'deploy' ? 'Deployment' : t.function}</div>
        <h2 className="mono" style={{ margin: '4px 0 0', fontSize: 16, overflowWrap: 'anywhere' }}>
          {t.hash ? shortHash(t.hash, 18, 10) : 'No hash'}
        </h2>
      </div>
      <StatusCells cells={statusCells(t.status, t.blockNumber, t.kind, t.indexerConfigured)} />
      {t.kind === 'deploy' && t.contract && (
        <div className="form-actions" style={{ marginTop: 0 }}>
          <Link className="button" href={href(`/app/contracts/${t.contract.id}`)}>
            Open contract {t.contract.address}
          </Link>
        </div>
      )}
      {t.kind === 'deploy' && t.status.execution === 'success' && !t.contract && <p className="dim" style={{ margin: 0, fontSize: 12.5 }}>Receipt observed; the contract is being added to the project…</p>}
    </div>
  );
}

export function execLabel(t: { submission_status: string; inclusion_status: string; execution_status: string; block_number: string | null }): [string, Tone] {
  if (t.execution_status === 'success') return ['Execution succeeded', 'success'];
  if (t.execution_status === 'reverted') return ['Execution reverted', 'danger'];
  if (t.inclusion_status === 'reorged_out') return ['Reorganized out', 'warning'];
  if (t.submission_status === 'unknown') return ['Submission unconfirmed', 'warning'];
  if (t.submission_status === 'rejected') return ['Not submitted', 'idle'];
  if (t.submission_status === 'prepared') return ['Awaiting signature', 'idle'];
  if (t.inclusion_status === 'included') return [`Included in ${groupDigits(t.block_number)}`, 'info'];
  return ['Waiting for receipt', 'info'];
}
