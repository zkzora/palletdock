import type { Tone } from '../components/ui';
import { groupDigits } from './format';

/** The five independent facts recorded for a transaction. */
export interface TxStatus {
  submission: string;
  inclusion: string;
  execution: string;
  finality: string;
  indexing: string;
}

export type StatusCell = { k: string; t: string; n: string; tone: Tone };

/**
 * Display text for each status. `indexerConfigured` tells whether an active
 * indexer source covers this transaction's contract, so a transaction whose
 * receipt is not recorded yet is not told to "configure an indexer" when one exists.
 */
export function statusCells(s: TxStatus, blockNumber: string | null, kind: string, indexerConfigured = false): StatusCell[] {
  const sub: StatusCell =
    s.submission === 'submitted'
      ? { k: 'Submission', t: 'Hash returned by wallet', n: 'The wallet broadcast the transaction.', tone: 'success' }
      : s.submission === 'unknown'
        ? { k: 'Submission', t: 'Unconfirmed', n: 'The result is ambiguous. Check account activity before retrying.', tone: 'warning' }
        : s.submission === 'rejected'
          ? { k: 'Submission', t: 'Not submitted', n: 'Rejected or blocked before broadcast.', tone: 'idle' }
          : { k: 'Submission', t: 'Prepared', n: 'Awaiting wallet approval; nothing broadcast.', tone: 'idle' };
  const incl: StatusCell =
    s.inclusion === 'included'
      ? { k: 'Inclusion', t: `Included in block ${groupDigits(blockNumber)}`, n: 'Execution and finality are separate.', tone: 'success' }
      : s.inclusion === 'reorged_out'
        ? { k: 'Inclusion', t: 'Reorganized out', n: 'The block that held it was replaced at that height. It may be re-included.', tone: 'warning' }
        : s.inclusion === 'pending'
          ? { k: 'Inclusion', t: 'Waiting for receipt', n: 'No receipt yet. This is not proof of failure.', tone: 'info' }
          : { k: 'Inclusion', t: 'Not observed', n: s.submission === 'submitted' ? 'Receipt tracker has not checked yet.' : 'No hash to look up.', tone: 'idle' };
  const exec: StatusCell =
    s.execution === 'success'
      ? { k: 'Execution', t: 'Succeeded', n: 'Receipt status 0x1.', tone: 'success' }
      : s.execution === 'reverted'
        ? { k: 'Execution', t: 'Reverted', n: 'Receipt status 0x0. A fee may still be charged.', tone: 'danger' }
        : { k: 'Execution', t: 'Unknown', n: 'No receipt with a status yet.', tone: 'idle' };
  const fin: StatusCell = { k: 'Finality', t: 'Not confirmed', n: 'No verified adapter links EVM blocks to native finality.', tone: 'unknown' };
  return [sub, incl, exec, fin, indexingCell(s, kind, indexerConfigured)];
}

function indexingCell(s: TxStatus, kind: string, indexerConfigured: boolean): StatusCell {
  if (kind === 'deploy') return { k: 'Indexing', t: 'No event expected', n: 'Contract creation emits no tracked event.', tone: 'idle' };
  switch (s.indexing) {
    case 'indexed':
      return { k: 'Indexing', t: 'Event indexed', n: 'Stored and queryable.', tone: 'success' };
    case 'no_events':
      return { k: 'Indexing', t: 'No events emitted', n: 'The receipt contains no logs.', tone: 'idle' };
    case 'pending':
      return { k: 'Indexing', t: 'Waiting for checkpoint', n: 'Indexed after an indexer covering this contract passes the block.', tone: 'info' };
    case 'not_covered':
      return indexerConfigured
        ? { k: 'Indexing', t: 'Not indexed', n: 'An indexer now covers this contract, but its range did not include this block when the receipt was recorded.', tone: 'idle' }
        : { k: 'Indexing', t: 'No indexer configured', n: 'Configure an indexer for this contract to store its events.', tone: 'idle' };
    default:
      // Receipt not recorded yet, so indexing has not been evaluated.
      return indexerConfigured
        ? { k: 'Indexing', t: 'Waiting for receipt', n: 'An indexer covers this contract. Indexing is evaluated once the receipt is recorded.', tone: 'info' }
        : { k: 'Indexing', t: 'No indexer configured', n: 'Configure an indexer for this contract to store its events.', tone: 'idle' };
  }
}
