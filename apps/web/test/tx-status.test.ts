import { describe, expect, it } from 'vitest';
import { statusCells, type TxStatus } from '../lib/tx-status';

const base: TxStatus = { submission: 'submitted', inclusion: 'pending', execution: 'unknown', finality: 'unknown', indexing: 'not_applicable' };
const indexing = (s: Partial<TxStatus>, kind = 'call', configured = false) => statusCells({ ...base, ...s }, null, kind, configured)[4];

describe('indexing status cell', () => {
  it('waits for the receipt when an indexer already covers the contract', () => {
    expect(indexing({}, 'call', true)).toMatchObject({ t: 'Waiting for receipt', tone: 'info' });
    expect(indexing({}, 'call', true).n).not.toMatch(/Configure an indexer/);
  });
  it('asks to configure an indexer only when none covers the contract', () => {
    expect(indexing({}, 'call', false)).toMatchObject({ t: 'No indexer configured' });
    expect(indexing({}, 'call', false).n).toMatch(/Configure an indexer/);
    expect(indexing({ inclusion: 'included', indexing: 'not_covered' }, 'call', false)).toMatchObject({ t: 'No indexer configured' });
  });
  it('explains a block outside the range when an indexer was added after the receipt', () => {
    expect(indexing({ inclusion: 'included', indexing: 'not_covered' }, 'call', true)).toMatchObject({ t: 'Not indexed' });
  });
  it('keeps the recorded states', () => {
    expect(indexing({ indexing: 'pending' }, 'call', true).t).toBe('Waiting for checkpoint');
    expect(indexing({ indexing: 'indexed' }, 'call', true).t).toBe('Event indexed');
    expect(indexing({ indexing: 'no_events' }, 'call', true).t).toBe('No events emitted');
    expect(indexing({}, 'deploy', true).t).toBe('No event expected');
  });
  it('describes reorged_out as a reorganization, not a missing receipt', () => {
    expect(statusCells({ ...base, inclusion: 'reorged_out' }, null, 'call')[1]).toMatchObject({ t: 'Reorganized out', tone: 'warning' });
  });
});
