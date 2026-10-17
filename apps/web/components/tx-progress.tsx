'use client';

import Link from 'next/link';
import { useWorkspace } from '@/components/workspace-shell';
import { useResource } from '@/lib/use-resource';
import { groupDigits, shortHash } from '@/lib/format';
import type { Tone } from '@/components/ui';

export interface TxStatus {
  submission: string;
  inclusion: string;
  execution: string;
  finality: string;
  indexing: string;
}

type Cell = { k: string; t: string; n: string; tone: Tone };

export function statusCells(s: TxStatus, blockNumber: string | null, kind: string): Cell[] {
  const sub: Cell =
    s.submission === 'submitted'
      ? { k: 'Submission', t: 'Hash returned by wallet', n: 'The wallet broadcast the transaction.', tone: 'success' }
      : s.submission === 'unknown'
        ? { k: 'Submission', t: 'Unconfirmed', n: 'The result is ambiguous. Check account activity before retrying.', tone: 'warning' }
        : s.submission === 'rejected'
          ? { k: 'Submission', t: 'Not submitted', n: 'Rejected or blocked before broadcast.', tone: 'idle' }
          : { k: 'Submission', t: 'Prepared', n: 'Awaiting wallet approval; nothing broadcast.', tone: 'idle' };
  const incl: Cell =
    s.inclusion === 'included'
      ? { k: 'Inclusion', t: `Included in block ${groupDigits(blockNumber)}`, n: 'Execution and finality are separate.', tone: 'success' }
      : s.inclusion === 'reorged_out'
        ? { k: 'Inclusion', t: 'Receipt disappeared', n: 'Possible reorganization. It may be re-included.', tone: 'warning' }
        : s.inclusion === 'pending'
          ? { k: 'Inclusion', t: 'Waiting for receipt', n: 'No receipt yet. This is not proof of failure.', tone: 'info' }
          : { k: 'Inclusion', t: 'Not observed', n: s.submission === 'submitted' ? 'Receipt tracker has not checked yet.' : 'No hash to look up.', tone: 'idle' };
  const exec: Cell =
    s.execution === 'success'
      ? { k: 'Execution', t: 'Succeeded', n: 'Receipt status 0x1.', tone: 'success' }
      : s.execution === 'reverted'
        ? { k: 'Execution', t: 'Reverted', n: 'Receipt status 0x0. A fee may still be charged.', tone: 'danger' }
        : { k: 'Execution', t: 'Unknown', n: 'No receipt with a status yet.', tone: 'idle' };
  const fin: Cell = { k: 'Finality', t: 'Not confirmed', n: 'No verified adapter links EVM blocks to native finality.', tone: 'unknown' };
  const idx: Cell =
    kind === 'deploy'
      ? { k: 'Indexing', t: 'No event expected', n: 'Contract creation emits no tracked event.', tone: 'idle' }
      : s.indexing === 'indexed'
        ? { k: 'Indexing', t: 'Event indexed', n: 'Stored and queryable.', tone: 'success' }
        : s.indexing === 'no_events'
          ? { k: 'Indexing', t: 'No events emitted', n: 'The receipt contains no logs.', tone: 'idle' }
          : s.indexing === 'pending'
            ? { k: 'Indexing', t: 'Waiting for checkpoint', n: 'Indexed after an indexer covering this contract passes the block.', tone: 'info' }
            : { k: 'Indexing', t: 'Not indexed', n: 'Configure an indexer for this contract to store its events.', tone: 'idle' };
  return [sub, incl, exec, fin, idx];
}

export function StatusCells({ cells }: { cells: Cell[] }) {
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
      <StatusCells cells={statusCells(t.status, t.blockNumber, t.kind)} />
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
  if (t.inclusion_status === 'reorged_out') return ['Receipt disappeared', 'warning'];
  if (t.submission_status === 'unknown') return ['Submission unconfirmed', 'warning'];
  if (t.submission_status === 'rejected') return ['Not submitted', 'idle'];
  if (t.submission_status === 'prepared') return ['Awaiting signature', 'idle'];
  if (t.inclusion_status === 'included') return [`Included in ${groupDigits(t.block_number)}`, 'info'];
  return ['Waiting for receipt', 'info'];
}
