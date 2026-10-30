'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useWorkspace } from '@/components/workspace-shell';
import { KV, Notice, Status, useToast, type Tone } from '@/components/ui';
import { EmptyState, ErrorState, LoadingCards } from '@/components/page-state';
import { useResource } from '@/lib/use-resource';
import { ago, groupDigits, shortHash, when } from '@/lib/format';
import { NETWORK } from '@/lib/network';

interface Source {
  id: string;
  contract_id: string;
  contract_name: string;
  contract_address: string;
  event_names: string[];
  start_block: string;
  end_block: string | null;
  desired_state: string;
  status: string;
  reorg_epoch: string;
  last_error: string | null;
  last_error_at: string | null;
  latest_observed_block: string | null;
  latest_observed_at: string | null;
  checkpoint_block: string | null;
  checkpoint_hash: string | null;
  checkpoint_at: string | null;
  abi_version: number;
  attempts: number;
  next_run_at: string;
  records: number;
  orphaned: number;
}

const STATUS: Record<string, [string, Tone]> = {
  pending: ['Starting', 'info'],
  backfilling: ['Backfilling', 'info'],
  following: ['Following', 'success'],
  completed: ['Range complete', 'success'],
  paused: ['Paused', 'idle'],
  error: ['Needs attention', 'danger'],
  recovery_required: ['Recovery required', 'danger'],
  stopped: ['Stopped', 'idle'],
};

export default function IndexerPage() {
  const { project, projectId, readOnly, request, href } = useWorkspace();
  const toast = useToast();
  const { data, error, loading, reload } = useResource<{ data: { sources: Source[]; recentRecords: any[]; devControls: boolean } }>(projectId ? `/workspace/projects/${projectId}/indexer` : null, { pollMs: 5000 });
  const contracts = useResource<{ data: Array<{ id: string; name: string; address: string; deploy_block: string | null }> }>(projectId ? `/workspace/projects/${projectId}/contracts` : null);
  const [editing, setEditing] = useState<{ replace?: string } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  if (!project) return <EmptyState title="Create a project first" body="Indexer sources belong to a project." />;
  if (loading) return <LoadingCards />;
  if (error) return <ErrorState message={error} retry={() => void reload()} />;
  const sources = data?.data.sources ?? [];
  const src = sources.find((s) => s.id === selected) ?? sources[0];

  async function act(action: string, label: string) {
    try {
      await request(`/workspace/projects/${projectId}/indexer/sources/${src!.id}/${action}`, { method: 'POST' });
      toast.show(label);
      await reload();
    } catch (e) {
      toast.show((e as Error).message, true);
    }
  }

  if (editing)
    return (
      <SourceForm
        contracts={contracts.data?.data ?? []}
        replace={editing.replace ? sources.find((s) => s.id === editing.replace) : undefined}
        onCancel={() => setEditing(null)}
        onSaved={async (id) => {
          setEditing(null);
          setSelected(id);
          await reload();
        }}
      />
    );

  if (!src)
    return (
      <div className="page-stack">
        <div>
          <div className="eyebrow">Indexer</div>
          <h1 className="page-title">No indexer configured</h1>
        </div>
        <section className="empty-state">
          <p style={{ margin: 0 }}>An indexer reads EVM logs for one contract over a bounded block range, stores identifiable records, and reports exactly which range it covered. Native event indexing is Planned.</p>
          {contracts.data?.data.length ? (
            <button className="button" disabled={readOnly} onClick={() => setEditing({})}>
              Configure log source
            </button>
          ) : (
            <div className="form-actions" style={{ marginTop: 0, alignItems: 'center' }}>
              <span className="warning-text" style={{ fontSize: 13 }}>
                Add a contract first.
              </span>
              <Link className="button" href={href('/app/contracts/deploy')}>
                Deploy contract
              </Link>
              <Link className="button secondary" href={href('/app/contracts/import')}>
                Import contract
              </Link>
            </div>
          )}
          <Link href="/docs/indexer" style={{ fontSize: 12.5 }}>
            Indexing and finality
          </Link>
        </section>
      </div>
    );

  const [label, tone] = STATUS[src.status] ?? [src.status, 'idle'];
  const start = BigInt(src.start_block);
  const reqEnd = src.end_block ? BigInt(src.end_block) : src.latest_observed_block ? BigInt(src.latest_observed_block) : null;
  const cp = src.checkpoint_block ? BigInt(src.checkpoint_block) : null;
  const lag = cp !== null && src.latest_observed_block ? (BigInt(src.latest_observed_block) > cp ? BigInt(src.latest_observed_block) - cp : 0n) : null;
  const span = reqEnd !== null && reqEnd >= start ? reqEnd - start + 1n : null;
  const done = cp !== null && cp >= start ? (reqEnd !== null && cp > reqEnd ? reqEnd : cp) - start + 1n : 0n;
  const pct = span ? Number((done * 10000n) / span) / 100 : 0;
  const stale = src.latest_observed_at ? Date.now() - new Date(src.latest_observed_at).getTime() > 120_000 : true;
  const paused = src.desired_state !== 'running';

  return (
    <div className="page-stack">
      <div className="page-heading">
        <div>
          <div className="eyebrow">Indexer · EVM contract logs</div>
          <h1 className="page-title">{src.contract_name} events</h1>
          <div className="badge-row">
            <span className="chip">
              <Status tone={tone}>{label}</Status>
            </span>
            {sources.length > 1 && (
              <select className="input" style={{ minHeight: 26, height: 26, width: 'auto', fontSize: 12 }} value={src.id} onChange={(e) => setSelected(e.target.value)} aria-label="Indexer source">
                {sources.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.contract_name} · {s.event_names.join(', ')}
                  </option>
                ))}
              </select>
            )}
          </div>
        </div>
        <div className="form-actions" style={{ marginTop: 0 }}>
          <button className="button ghost" disabled={readOnly} onClick={() => setEditing({})}>
            Add source
          </button>
          <button className="button secondary" disabled={readOnly} onClick={() => setEditing({ replace: src.id })}>
            Edit configuration
          </button>
          {paused ? (
            <button className="button" disabled={readOnly || src.status === 'recovery_required'} onClick={() => void act('resume', 'Resumed from the stored checkpoint.')}>
              Resume
            </button>
          ) : (
            <button className="button" disabled={readOnly} onClick={() => void act('pause', 'Paused. In-flight work is discarded; checkpoint kept.')}>
              Pause
            </button>
          )}
        </div>
      </div>

      {src.status === 'error' && (
        <Notice tone="danger" title="RPC connection interrupted" action={<button className="button secondary" onClick={() => void act('reconnect', 'Reconnect requested.')}>Reconnect</button>}>
          {src.last_error} · {src.attempts} failed attempt(s), next retry {when(src.next_run_at)}. Indexing resumes from checkpoint {src.checkpoint_block ? groupDigits(src.checkpoint_block) : '—'} with no duplicate records.
        </Notice>
      )}
      {src.status === 'recovery_required' && (
        <Notice tone="danger" title="Recovery required" action={<button className="button secondary" disabled={readOnly} onClick={() => setEditing({ replace: src.id })}>Choose recent start block</button>}>
          {src.last_error} The original start block {groupDigits(src.start_block)} may no longer be retained. Saving a recent start block validates it before replacing this source. Stored records stay available as non-canonical history.
        </Notice>
      )}
      {src.desired_state === 'archived' && <Notice tone="info">{readOnly ? 'The project is archived, so this source is stopped. Restore the project in Settings, then resume here.' : 'Indexing stopped when the project was archived. Resume to continue from the stored checkpoint.'}</Notice>}

      <div className="metric-grid">
        <div className="card stat">
          <span>Latest observed EVM block</span>
          <strong>{src.latest_observed_block ? groupDigits(src.latest_observed_block) : 'Unavailable'}</strong>
          <small>{src.latest_observed_at ? `observed ${ago(src.latest_observed_at)}${stale ? ' · stale' : ''}` : 'not observed yet'}</small>
        </div>
        <div className="card stat">
          <span>Checkpoint</span>
          <strong>{src.checkpoint_block ? groupDigits(src.checkpoint_block) : 'None'}</strong>
          <small>{src.checkpoint_hash ? `${shortHash(src.checkpoint_hash)} · ${ago(src.checkpoint_at)}` : 'nothing committed yet'}</small>
        </div>
        <div className="card stat">
          <span>Lag</span>
          <strong>{paused ? 'Not checked' : src.status === 'error' ? 'Unknown' : lag === null ? 'Unavailable' : `${groupDigits(lag.toString())} blocks`}</strong>
          <small>latest observed − checkpoint</small>
        </div>
        <div className="card stat">
          <span>Records</span>
          <strong>{groupDigits(String(src.records))}</strong>
          <small>
            canonical · {src.orphaned} orphaned · reorg epoch {src.reorg_epoch}
          </small>
        </div>
      </div>

      <section className="card panel" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <h2 style={{ margin: 0 }}>Coverage</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(220px,100%),1fr))', gap: 10, fontSize: 12.5 }}>
          <div>
            <div className="dim">Requested</div>
            <div className="mono" style={{ marginTop: 3 }}>
              {groupDigits(src.start_block)} – {src.end_block ? groupDigits(src.end_block) : `latest observed${src.latest_observed_block ? ` (${groupDigits(src.latest_observed_block)})` : ''}`}
            </div>
          </div>
          <div>
            <div className="dim">Completed</div>
            <div className="mono success-text" style={{ marginTop: 3 }}>
              {cp !== null && cp >= start ? `${groupDigits(src.start_block)} – ${groupDigits(src.checkpoint_block)} complete` : 'Nothing completed yet'}
            </div>
          </div>
          <div>
            <div className="dim">Remaining</div>
            <div className="mono" style={{ marginTop: 3 }}>
              {reqEnd === null ? 'Unknown until the head is observed' : cp === null || cp < reqEnd ? `${groupDigits(((cp ?? start - 1n) + 1n).toString())} – ${groupDigits(reqEnd.toString())} ${paused ? 'not checked' : 'pending'}` : 'No gap in requested range'}
            </div>
          </div>
        </div>
        <div className="coverage-bar" role="img" aria-label={`Completed ${pct}% of the requested range`}>
          <div style={{ width: `${Math.min(100, pct)}%` }} />
        </div>
        <p className="dim" style={{ margin: 0, fontSize: 12.5 }}>
          Striped = requested but not completed. An absent event outside completed coverage is not evidence that it never happened. Includes empty blocks.
        </p>
      </section>

      <div className="two-column">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20, minWidth: 0 }}>
          <section className="card panel">
            <h2>Configuration</h2>
            <KV
              rows={[
                ['Contract', <Link key="c" href={href(`/app/contracts/${src.contract_id}`)}>{src.contract_address}</Link>],
                ['Events', src.event_names.join(', ')],
                ['ABI version', `v${src.abi_version} (pinned)`],
                ['Start block', groupDigits(src.start_block)],
                ['End block', src.end_block ? groupDigits(src.end_block) : 'Follow latest observed'],
                ['Finality policy', 'included-with-explicit-finality: records stay "finality unknown" until a verified adapter exists'],
                ['Network', `${NETWORK.label} · EVM chain ${NETWORK.chainId}`],
              ]}
            />
            <div className="form-actions">
              <button className="button danger" disabled={readOnly} onClick={() => void act('delete', 'Source removed. Raw logs kept.')}>
                Remove source
              </button>
            </div>
          </section>
          {data?.data.devControls && (
            <section className="card panel" style={{ borderStyle: 'dashed' }}>
              <div className="panel-row">
                <h2>Development controls</h2>
                <span className="chip dashed">Dev only</span>
              </div>
              <p className="dim" style={{ margin: '0 0 10px', fontSize: 12.5 }}>
                Makes the worker's next RPC calls fail so recovery from the stored checkpoint can be observed. Disabled unless PALLETDOCK_DEV_CONTROLS=1; never a production metric.
              </p>
              <div className="form-actions" style={{ marginTop: 0 }}>
                <button className="button secondary" onClick={() => void act('simulate-failure', 'Simulated RPC interruption queued.')}>
                  Simulate RPC interruption
                </button>
                <button className="button secondary" onClick={() => void act('reconnect', 'Reconnect requested.')}>
                  Reconnect
                </button>
              </div>
            </section>
          )}
        </div>
        <section className="card" style={{ minWidth: 0 }}>
          <div className="card-head">
            <div>
              <h2>Indexed records</h2>
              <div className="dim" style={{ marginTop: 3, fontSize: 12 }}>
                Identity: block hash · transaction hash · log index
              </div>
            </div>
          </div>
          {data?.data.recentRecords.filter((r) => r.source_id === src.id).map((r) => (
            <Link key={r.id} className="row-link mono" href={href(`/app/transactions?hash=${r.transaction_hash}`)} style={{ gridTemplateColumns: '80px 130px minmax(0,1fr)' }}>
              <span>{groupDigits(r.block_number)}</span>
              <span className={r.status === 'decoded' ? 'ellipsis' : 'ellipsis warning-text'}>{r.event_name ?? r.status}</span>
              <span className="ellipsis dim">
                {shortHash(r.transaction_hash)} · log {r.log_index}
                {r.args ? ` · ${Object.entries(r.args).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' ')}` : ''}
              </span>
            </Link>
          ))}
          {!data?.data.recentRecords.some((r) => r.source_id === src.id) && <p className="card-empty">No records stored yet. Records appear after a tracked event is emitted inside the completed range.</p>}
        </section>
      </div>
      {toast.node}
    </div>
  );
}

function SourceForm({ contracts, replace, onCancel, onSaved }: { contracts: Array<{ id: string; name: string; address: string; deploy_block: string | null }>; replace?: Source; onCancel(): void; onSaved(id: string): void }) {
  const { projectId, request } = useWorkspace();
  const [contractId, setContractId] = useState(replace?.contract_id ?? contracts[0]?.id ?? '');
  const detail = useResource<{ data: { events: Array<{ name: string; signature: string }>; deployBlock: string | null } }>(projectId && contractId ? `/workspace/projects/${projectId}/contracts/${contractId}` : null);
  const [events, setEvents] = useState<string[]>(replace?.event_names ?? []);
  const [start, setStart] = useState(replace?.start_block ?? '');
  const [end, setEnd] = useState(replace?.end_block ?? '');
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const evs = detail.data?.data.events ?? [];
  useEffect(() => {
    if (!replace && detail.data) {
      setEvents(detail.data.data.events.map((e) => e.name));
      if (!start && detail.data.data.deployBlock) setStart(detail.data.data.deployBlock);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.data]);

  async function save() {
    const e: Record<string, string> = {};
    if (!events.length) e.events = 'Select at least one event.';
    if (!/^(0|[1-9][0-9]*)$/.test(start)) e.start = 'Enter a whole start block.';
    if (end && !/^(0|[1-9][0-9]*)$/.test(end)) e.end = 'Enter a whole end block or leave blank.';
    if (!e.start && !e.end && end && BigInt(end) < BigInt(start)) e.end = 'End block must be at least the start block.';
    setErrs(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    try {
      const r = await request<{ data: { id: string } }>(`/workspace/projects/${projectId}/indexer/sources`, {
        method: 'POST',
        body: JSON.stringify({ contractId, events, startBlock: start, endBlock: end, replaceSourceId: replace?.id }),
      });
      onSaved(r.data.id);
    } catch (err) {
      setErrs({ form: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page-stack">
      <div>
        <div className="eyebrow">Indexer · EVM contract logs</div>
        <h1 className="page-title">{replace ? 'Edit log source' : 'Configure log source'}</h1>
      </div>
      <section className="card form-card" style={{ maxWidth: 720 }}>
        {replace && <Notice tone="info">Saving creates a new source with fresh coverage and stops the current one. Its stored records are kept.</Notice>}
        <div className="field">
          <label htmlFor="ix-contract">Contract</label>
          <select id="ix-contract" className="input" value={contractId} onChange={(e) => { setContractId(e.target.value); setEvents([]); setStart(''); }}>
            {contracts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} · {c.address}
              </option>
            ))}
          </select>
        </div>
        <fieldset>
          <legend>Events</legend>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {evs.map((ev) => (
              <label key={ev.signature} className="check-chip">
                <input type="checkbox" checked={events.includes(ev.name)} onChange={() => setEvents((x) => (x.includes(ev.name) ? x.filter((y) => y !== ev.name) : [...x, ev.name]))} />
                {ev.signature}
              </label>
            ))}
          </div>
          {detail.data && !evs.length && <p className="warning-text" style={{ fontSize: 12.5 }}>This contract's ABI declares no events. Indexing needs at least one event.</p>}
          {errs.events && <p className="field-error">{errs.events}</p>}
        </fieldset>
        <div className="two-column" style={{ gap: 12 }}>
          <div className="field">
            <label htmlFor="ix-start">Start block</label>
            <input id="ix-start" className="input mono" value={start} onChange={(e) => setStart(e.target.value)} inputMode="numeric" spellCheck={false} aria-invalid={!!errs.start} aria-describedby={`ix-start-${errs.start ? 'error' : 'help'}`} />
            {errs.start && <p id="ix-start-error" className="field-error">{errs.start}</p>}
            <span id="ix-start-help" className="dim" style={{ fontSize: 11.5 }}>{detail.data?.data.deployBlock ? `Deployment block ${groupDigits(detail.data.data.deployBlock)}. The RPC must still retain the chosen block.` : 'Deployment block not recorded; choose a retained block at or before deployment.'}</span>
          </div>
          <div className="field">
            <label htmlFor="ix-end">
              End block <span className="dim">optional</span>
            </label>
            <input id="ix-end" className="input mono" value={end} onChange={(e) => setEnd(e.target.value)} inputMode="numeric" spellCheck={false} placeholder="follow latest observed" aria-invalid={!!errs.end} aria-describedby={`ix-end-${errs.end ? 'error' : 'help'}`} />
            {errs.end && <p id="ix-end-error" className="field-error">{errs.end}</p>}
            <span id="ix-end-help" className="dim" style={{ fontSize: 11.5 }}>Blank keeps following the latest observed EVM block.</span>
          </div>
        </div>
        <p className="dim" style={{ margin: 0, fontSize: 12.5, lineHeight: 1.5 }}>
          Finality policy: included-with-explicit-finality. Records stay “finality unknown” until a verified adapter links native finality to EVM blocks.
        </p>
        {errs.form && <Notice tone="danger">{errs.form}</Notice>}
        <div className="form-actions" style={{ marginTop: 0 }}>
          {/* Wait for the contract's events and deployment block before validating, so a fast click never saves stale defaults. */}
          <button className="button" onClick={() => void save()} disabled={busy || !detail.data} aria-busy={busy || !detail.data}>
            {busy ? 'Saving…' : 'Save and start indexing'}
          </button>
          <button className="button secondary" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </section>
    </div>
  );
}
