'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useWorkspace } from '@/components/workspace-shell';
import { Dot, Notice, Pre, Segmented, useToast, type Tone } from '@/components/ui';
import { EmptyState, ErrorState, LoadingCards } from '@/components/page-state';
import { useResource } from '@/lib/use-resource';
import { ago, groupDigits, when } from '@/lib/format';

type Range = '1h' | '24h' | '7d' | '30d';
type Source = 'all' | 'rpc' | 'indexer' | 'api' | 'worker' | 'transaction' | 'network';
type Level = 'all' | 'INFO' | 'WARN' | 'ERROR';

export default function MonitoringPage() {
  const { project, projectId, request, href } = useWorkspace();
  const toast = useToast();
  const [range, setRange] = useState<Range>('24h');
  const [source, setSource] = useState<Source>('all');
  const [level, setLevel] = useState<Level>('all');
  const [before, setBefore] = useState<string[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [probing, setProbing] = useState(false);
  const cursor = before.at(-1);
  const qs = new URLSearchParams({ range, source, level, ...(cursor ? { before: cursor } : {}) }).toString();
  const { data, error, loading, reload } = useResource<{ data: any }>(projectId ? `/workspace/projects/${projectId}/monitoring?${qs}` : null, { pollMs: 10000 });

  if (!project) return <EmptyState title="Create a project first" body="Monitoring is shown per project." />;
  const d = data?.data;

  async function runProbes() {
    setProbing(true);
    try {
      const r = await request<{ data: Array<{ target: string; status: string; latencyMs: number; error: string | null }> }>(`/workspace/projects/${projectId}/monitoring/probe`, { method: 'POST' });
      toast.show(r.data.map((p) => `${p.target}: ${p.status} (${p.latencyMs} ms)`).join(' · '), r.data.some((p) => p.status !== 'responded'));
      await reload();
    } catch (e) {
      toast.show((e as Error).message, true);
    } finally {
      setProbing(false);
    }
  }

  const probeCard = (target: 'evm' | 'substrate') => {
    const p = d?.probes.find((x: any) => x.target === target);
    const status: [string, Tone] = !p ? ['Unavailable', 'idle'] : p.stale ? ['Stale', 'warning'] : p.status === 'responded' ? ['Responded', 'success'] : ['Failed', 'danger'];
    return (
      <div className="card metric" key={target}>
        <span>{target === 'evm' ? 'EVM RPC probe' : 'Substrate RPC probe'}</span>
        <strong style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Dot tone={status[1]} />
          {status[0]}
        </strong>
        <small className="mono">{p ? `${when(p.observed_at)} · ${p.latency_ms ?? '—'} ms${p.error ? ` · ${p.error.slice(0, 120)}` : ''}` : 'No probe recorded yet.'}</small>
      </div>
    );
  };
  const worker = d?.workers?.[0];
  const ix = d?.indexer?.[0];
  const errTotal = (d?.apiErrors ?? []).reduce((a: number, e: any) => a + e.n, 0);

  // Lag samples: head − checkpoint at each commit, oldest → newest.
  const samples: Array<{ lag: bigint; at: string }> = (d?.checkpointSamples ?? [])
    .filter((s: any) => s.head && s.to_block)
    .map((s: any) => ({ lag: BigInt(s.head) > BigInt(s.to_block) ? BigInt(s.head) - BigInt(s.to_block) : 0n, at: s.created_at }))
    .reverse()
    .slice(-48);
  const maxLag = samples.reduce((m, s) => (s.lag > m ? s.lag : m), 0n);
  const logs = source === 'api' ? [] : d?.logs ?? [];
  const reqs = d?.apiRequests ?? [];
  const selected = logs.find((l: any) => `ops-${l.id}` === sel) ?? reqs.find((r: any) => `req-${r.id}` === sel);

  return (
    <div className="page-stack">
      <div className="page-heading">
        <div>
          <div className="eyebrow">Monitoring</div>
          <h1 className="page-title">Probes, lag, and errors</h1>
          <p>Recorded observations only. Unknown values are shown as unavailable, never as zero. <Link href="/docs/troubleshooting">Troubleshooting</Link></p>
        </div>
        <div className="form-actions" style={{ marginTop: 0, alignItems: 'center' }}>
          <Segmented<Range> label="Time range" value={range} onChange={(v) => { setRange(v); setBefore([]); }} options={[['1h', '1h'], ['24h', '24h'], ['7d', '7d'], ['30d', '30d']]} />
          <button className="button secondary" onClick={() => void runProbes()} disabled={probing} aria-busy={probing}>
            {probing ? 'Probing…' : 'Run probes'}
          </button>
        </div>
      </div>
      {loading && !d ? (
        <LoadingCards />
      ) : error ? (
        <ErrorState message={error} retry={() => void reload()} />
      ) : (
        <>
          {ix?.status === 'error' && (
            <Notice tone="danger" title="Indexer RPC connection interrupted" action={<Link className="button secondary" href={href('/app/indexer')}>Open indexer</Link>}>
              The worker is retrying with backoff from the stored checkpoint.
            </Notice>
          )}
          <div className="metric-grid">
            {probeCard('evm')}
            {probeCard('substrate')}
            <div className="card metric">
              <span>Worker</span>
              <strong style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Dot tone={!worker ? 'idle' : worker.healthy ? 'success' : 'warning'} />
                {!worker ? 'Unavailable' : worker.healthy ? 'Heartbeat current' : 'Stale heartbeat'}
              </strong>
              <small className="mono">{worker ? `last seen ${ago(worker.last_seen_at)} · network ${worker.info?.networkStatus ?? 'unknown'}` : 'No worker has reported.'}</small>
            </div>
            <div className="card metric">
              <span>Indexer lag</span>
              <strong>{!ix ? 'Unavailable' : ['stopped', 'paused'].includes(ix.status) ? 'Not checked' : ix.status === 'error' || ix.lagBlocks === null ? 'Unknown' : `${groupDigits(ix.lagBlocks)} blocks`}</strong>
              <small className="mono">{ix ? `checkpoint ${ix.checkpoint_block ? groupDigits(ix.checkpoint_block) : '—'} · head ${ix.latest_observed_block ? groupDigits(ix.latest_observed_block) : '—'} · ${ix.status}` : 'No indexer configured.'}</small>
              <Link href={href('/app/indexer')} style={{ fontSize: 12.5 }}>Open indexer</Link>
            </div>
            <div className="card metric">
              <span>API errors · {range}</span>
              <strong>{groupDigits(String(errTotal))}</strong>
              <small>from recorded requests</small>
            </div>
          </div>

          <section className="card panel">
            <div className="panel-row">
              <h2>Indexer lag vs latest observed EVM block</h2>
              <span className="mono dim" style={{ fontSize: 12 }}>
                blocks · last {range} · {samples.length} commit samples
              </span>
            </div>
            {!d.indexer.length ? (
              <p className="dim" style={{ margin: 0 }}>No indexer configured. Lag is unavailable.</p>
            ) : !samples.length ? (
              <p className="dim" style={{ margin: 0 }}>No checkpoint commits recorded in this range.</p>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: '54px minmax(0,1fr)', gap: 10 }}>
                <div className="mono dim" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between', height: 160, fontSize: 11, textAlign: 'right' }}>
                  <span>{groupDigits(maxLag.toString())}</span>
                  <span>0</span>
                </div>
                <div className="chart" role="img" aria-label="Lag at each checkpoint commit">
                  {samples.map((s, i) => (
                    <div key={i} title={`${when(s.at)} · lag ${s.lag} blocks`} className={maxLag > 0n && s.lag * 2n > maxLag ? 'warn' : ''} style={{ height: `${maxLag === 0n ? 2 : Math.max(2, Number((s.lag * 100n) / maxLag))}%` }} />
                  ))}
                </div>
              </div>
            )}
          </section>

          <div className="two-column">
            <section className="card" style={{ minWidth: 0 }}>
              <div className="card-head" style={{ flexWrap: 'wrap' }}>
                <h2>Records</h2>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <Segmented<Source> label="Log source" value={source} onChange={(v) => { setSource(v); setBefore([]); setSel(null); }} options={[['all', 'All'], ['indexer', 'Indexer'], ['rpc', 'RPC'], ['api', 'API'], ['worker', 'Worker'], ['transaction', 'Tx']]} />
                  <Segmented<Level> label="Level" value={level} onChange={(v) => { setLevel(v); setBefore([]); }} options={[['all', 'All'], ['WARN', 'Warn'], ['ERROR', 'Error']]} />
                </div>
              </div>
              {logs.map((l: any) => (
                <button key={`ops-${l.id}`} className="row-link mono" aria-pressed={sel === `ops-${l.id}`} onClick={() => setSel(sel === `ops-${l.id}` ? null : `ops-${l.id}`)} style={{ gridTemplateColumns: '50px 120px minmax(0,1fr)', fontSize: 12, background: sel === `ops-${l.id}` ? '#1b1d21' : undefined }}>
                  <span className={l.level === 'ERROR' ? 'danger-text' : l.level === 'WARN' ? 'warning-text' : 'dim'}>{l.level}</span>
                  <span className="dim">{when(l.created_at).slice(5, 19)}</span>
                  <span style={{ fontFamily: 'var(--font-ui)', fontSize: 13 }} className="ellipsis">
                    {l.source} · {l.message}
                  </span>
                </button>
              ))}
              {(source === 'all' || source === 'api') &&
                reqs.map((r: any) => (
                  <button key={`req-${r.id}`} className="row-link mono" onClick={() => setSel(sel === `req-${r.id}` ? null : `req-${r.id}`)} style={{ gridTemplateColumns: '50px 120px minmax(0,1fr)', fontSize: 12, background: sel === `req-${r.id}` ? '#1b1d21' : undefined }}>
                    <span className={r.status >= 500 ? 'danger-text' : r.status >= 400 ? 'warning-text' : 'dim'}>{r.status}</span>
                    <span className="dim">{when(r.created_at).slice(5, 19)}</span>
                    <span style={{ fontFamily: 'var(--font-ui)', fontSize: 13 }} className="ellipsis">
                      api · {r.method} {r.route} {r.error_code ? `· ${r.error_code}` : ''}
                    </span>
                  </button>
                ))}
              {!logs.length && !reqs.length && <p className="card-empty">No records in this range for this source.</p>}
              {selected && (
                <div style={{ padding: '12px 18px', borderTop: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <Pre>{JSON.stringify({ ...selected, id: undefined }, null, 2)}</Pre>
                  <div className="form-actions" style={{ marginTop: 0 }}>
                    {selected.transaction_id && <Link className="button secondary" href={href(`/app/transactions/${selected.transaction_id}`)}>Open transaction</Link>}
                    {selected.indexer_source_id && <Link className="button secondary" href={href('/app/indexer')}>Open indexer</Link>}
                  </div>
                </div>
              )}
              <div className="form-actions" style={{ padding: '0 18px 14px' }}>
                {before.length > 0 && <button className="button ghost" onClick={() => setBefore(before.slice(0, -1))}>Newer</button>}
                {d.nextBefore && <button className="button secondary" onClick={() => setBefore([...before, d.nextBefore])}>Older</button>}
              </div>
              <p className="dim" style={{ margin: 0, padding: '0 18px 14px', fontSize: 12 }}>{d.retention} Request records never contain keys, cookies, or request bodies.</p>
            </section>
            <section className="card" style={{ minWidth: 0 }}>
              <div className="card-head">
                <div>
                  <h2>API request errors by code</h2>
                  <div className="dim" style={{ marginTop: 3, fontSize: 12 }}>Last {range}</div>
                </div>
              </div>
              {d.apiErrors.map((e: any) => (
                <div key={`${e.status}-${e.code}`} className="mono" style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 50px 130px', gap: 12, padding: '11px 18px', borderTop: '1px solid #1f2125', fontSize: 12.5 }}>
                  <span>
                    {e.status} {e.code}
                  </span>
                  <span style={{ textAlign: 'right' }}>{e.n}</span>
                  <span className="dim" style={{ textAlign: 'right' }} title={`last request ${e.last_request_id}`}>
                    {ago(e.last)}
                  </span>
                </div>
              ))}
              {!d.apiErrors.length && <p className="card-empty">0 API request errors in this range.</p>}
            </section>
          </div>
        </>
      )}
      {toast.node}
    </div>
  );
}
