'use client';

import { useMemo, useState } from 'react';
import { useWorkspace } from '@/components/workspace-shell';
import { CopyButton, Notice, Pre, Tabs } from '@/components/ui';
import { EmptyState } from '@/components/page-state';
import { KeysPanel } from '@/components/keys-panel';

type Tab = 'playground' | 'keys' | 'endpoints';
type Ep = 'events' | 'transactions' | 'contracts' | 'indexer';

const FIELDS: Record<Ep, Array<{ key: string; label: string; placeholder?: string; options?: string[] }>> = {
  events: [
    { key: 'contract', label: 'contract', placeholder: '0x… address' },
    { key: 'event', label: 'event', placeholder: 'NumberChanged' },
    { key: 'fromBlock', label: 'fromBlock', placeholder: 'any' },
    { key: 'toBlock', label: 'toBlock', placeholder: 'any' },
    { key: 'finality', label: 'finality', options: ['', 'unknown', 'finalized'] },
    { key: 'limit', label: 'limit', placeholder: '25' },
  ],
  transactions: [
    { key: 'executionStatus', label: 'executionStatus', options: ['', 'success', 'reverted', 'unknown'] },
    { key: 'inclusionStatus', label: 'inclusionStatus', options: ['', 'pending', 'included', 'reorged_out'] },
    { key: 'contract', label: 'contract', placeholder: '0x… address' },
    { key: 'limit', label: 'limit', placeholder: '25' },
  ],
  contracts: [
    { key: 'address', label: 'address', placeholder: '0x… address' },
    { key: 'limit', label: 'limit', placeholder: '25' },
  ],
  indexer: [],
};

function publicBase(): string {
  const configured = process.env.NEXT_PUBLIC_PALLETDOCK_PUBLIC_API_URL;
  if (configured) return configured.replace(/\/$/, '');
  return typeof window === 'undefined' ? '' : `${window.location.origin}/backend`;
}

export default function ApiPage() {
  const { project, projectId, readOnly, request } = useWorkspace();
  const [tab, setTab] = useState<Tab>('playground');
  if (!project || !projectId) return <EmptyState title="Create a project first" body="The read API is scoped to one project." />;
  return (
    <div className="page-stack">
      <div className="page-heading">
        <div>
          <div className="eyebrow">API · v1 · read-only · EVM layer</div>
          <h1 className="page-title">Project API</h1>
          <p>Query this project's contracts, transactions, indexed events, and indexer coverage with a scoped read key.</p>
        </div>
      </div>
      <Tabs<Tab> label="API views" value={tab} onChange={setTab} tabs={[['playground', 'Playground'], ['keys', 'Keys'], ['endpoints', 'Endpoints']]} />
      {tab === 'playground' && <Playground projectId={projectId} readOnly={readOnly} request={request} />}
      {tab === 'keys' && <KeysPanel />}
      {tab === 'endpoints' && <Endpoints projectId={projectId} />}
    </div>
  );
}

function Playground({ projectId, readOnly, request }: { projectId: string; readOnly: boolean; request: <T>(p: string, i?: RequestInit) => Promise<T> }) {
  const [ep, setEp] = useState<Ep>('events');
  const [vals, setVals] = useState<Record<string, string>>({});
  const [cursor, setCursor] = useState('');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [resp, setResp] = useState<{ status: number; ms: number; body: any; requestId: string | null } | null>(null);
  const [keyNote, setKeyNote] = useState('');
  const path = useMemo(() => {
    const q = new URLSearchParams();
    for (const f of FIELDS[ep]) if (vals[f.key]) q.set(f.key, vals[f.key]);
    if (cursor) q.set('cursor', cursor);
    const s = q.toString();
    return `/v1/projects/${projectId}/${ep}${s ? `?${s}` : ''}`;
  }, [ep, vals, cursor, projectId]);
  const curl = `curl -sS "${publicBase()}${path}" \\\n  -H "Authorization: Bearer $PALLETDOCK_READ_KEY"`;

  async function send() {
    setBusy(true);
    const t0 = performance.now();
    try {
      const r = await fetch(`/backend${path}`, { headers: key ? { authorization: `Bearer ${key}` } : {}, credentials: 'omit' });
      const body = await r.json().catch(() => ({ note: 'Response body was not JSON.' }));
      setResp({ status: r.status, ms: Math.round(performance.now() - t0), body, requestId: body?.requestId ?? body?.error?.requestId ?? null });
    } catch (e) {
      setResp({ status: 0, ms: Math.round(performance.now() - t0), body: { error: (e as Error).message }, requestId: null });
    } finally {
      setBusy(false);
    }
  }

  async function createPlaygroundKey() {
    setKeyNote('');
    try {
      const r = await request<{ secret: string; data: { expires_at: string } }>(`/workspace/projects/${projectId}/keys`, {
        method: 'POST',
        body: JSON.stringify({ name: `playground-${new Date().toISOString().slice(0, 10)}`, scopes: ['contracts:read', 'transactions:read', 'events:read', 'indexer:read'], expiresInDays: 7 }),
      });
      setKey(r.secret);
      setKeyNote(`Created a 7-day playground key (expires ${new Date(r.data.expires_at).toLocaleDateString()}). It is held only in this page's memory; revoke it from Keys when done.`);
    } catch (e) {
      setKeyNote((e as Error).message);
    }
  }

  return (
    <div className="two-column">
      <section className="card form-card">
        <h2 style={{ margin: 0, fontSize: 14 }}>Request</h2>
        <div className="field">
          <label htmlFor="pg-ep">Endpoint</label>
          <select id="pg-ep" className="input mono" value={ep} onChange={(e) => { setEp(e.target.value as Ep); setVals({}); setCursor(''); setResp(null); }}>
            {(['events', 'transactions', 'contracts', 'indexer'] as Ep[]).map((e) => (
              <option key={e} value={e}>
                GET /v1/projects/{'{projectId}'}/{e}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="pg-key">Read key</label>
          <input id="pg-key" className="input mono" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder="pd_live_… (kept in memory only)" />
          <span className="dim" style={{ fontSize: 11.5 }}>
            Stored secrets cannot be retrieved. Paste a key you saved, or create a short-lived one for this page.{' '}
            {!readOnly && (
              <button type="button" className="mini-button" onClick={() => void createPlaygroundKey()}>
                Create 7-day playground key
              </button>
            )}
          </span>
          {keyNote && <span className="dim" style={{ fontSize: 12 }}>{keyNote}</span>}
        </div>
        {FIELDS[ep].length ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(150px,100%),1fr))', gap: 10 }}>
            {FIELDS[ep].map((f) => (
              <div className="field" key={f.key} style={{ minWidth: 0 }}>
                <label htmlFor={`pg-${f.key}`} className="mono" style={{ fontSize: 11.5 }}>
                  {f.label}
                </label>
                {f.options ? (
                  <select id={`pg-${f.key}`} className="input mono" value={vals[f.key] ?? ''} onChange={(e) => { setVals({ ...vals, [f.key]: e.target.value }); setCursor(''); }}>
                    {f.options.map((o) => (
                      <option key={o} value={o}>
                        {o || 'any'}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input id={`pg-${f.key}`} className="input mono" value={vals[f.key] ?? ''} placeholder={f.placeholder} onChange={(e) => { setVals({ ...vals, [f.key]: e.target.value }); setCursor(''); }} />
                )}
              </div>
            ))}
          </div>
        ) : (
          <p className="dim" style={{ margin: 0, fontSize: 12.5 }}>This endpoint takes no filters.</p>
        )}
        <div className="card" style={{ background: '#111214' }}>
          <div className="eyebrow" style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 12px', borderBottom: '1px solid var(--border)' }}>
            <span>curl · key redacted</span>
            <CopyButton text={curl} label="Copy curl" />
          </div>
          <Pre>{curl}</Pre>
        </div>
        <div>
          <button className="button" onClick={() => void send()} disabled={busy} aria-busy={busy}>
            {busy ? 'Sending…' : 'Send request'}
          </button>
        </div>
      </section>
      <section className="card" style={{ minWidth: 0 }}>
        <div className="card-head">
          <h2>Response</h2>
          <span>live from this PalletDock API</span>
        </div>
        {resp ? (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(140px,100%),1fr))', borderBottom: '1px solid var(--border)' }}>
              {[
                ['HTTP status', String(resp.status || 'network error'), resp.status >= 200 && resp.status < 300 ? 'success-text' : 'danger-text'],
                ['Latency', `${resp.ms} ms`, ''],
                ['Request ID', resp.requestId ?? '—', ''],
              ].map(([k, v, cls]) => (
                <div key={k} style={{ padding: '12px 18px' }}>
                  <div className="dim" style={{ fontSize: 11.5 }}>{k}</div>
                  <div className={`mono ${cls}`} style={{ marginTop: 4, fontSize: 12.5, overflowWrap: 'anywhere' }}>{v}</div>
                </div>
              ))}
            </div>
            {resp.body?.meta && (
              <div style={{ padding: '10px 18px', borderBottom: '1px solid var(--border)', fontSize: 12.5 }} className="muted">
                Freshness: observed {resp.body.meta.observedAt} · checkpoint {resp.body.meta.checkpoint?.blockNumber ?? 'none'} · finality {resp.body.meta.finality}
              </div>
            )}
            {Array.isArray(resp.body?.data) && resp.body.data.length === 0 && <div style={{ padding: '10px 18px', borderBottom: '1px solid var(--border)', fontSize: 12.5 }}>Empty successful result. This differs from an unavailable service; check filters and coverage.</div>}
            {resp.body?.nextCursor && (
              <div style={{ padding: '10px 18px', borderBottom: '1px solid var(--border)' }}>
                <button className="button secondary" onClick={() => setCursor(resp.body.nextCursor)}>
                  Use nextCursor for the next page
                </button>
              </div>
            )}
            <Pre max={520}>{JSON.stringify(resp.body, null, 2)}</Pre>
          </>
        ) : (
          <p className="card-empty">Send a request to see the real HTTP status, request ID, pagination, freshness metadata, and JSON body.</p>
        )}
      </section>
    </div>
  );
}

function Endpoints({ projectId }: { projectId: string }) {
  const rows: Array<[string, string, string]> = [
    ['events', 'events:read', 'contract, event, fromBlock, toBlock, finality, limit, cursor'],
    ['transactions', 'transactions:read', 'executionStatus, inclusionStatus, contract, hash, limit, cursor'],
    ['contracts', 'contracts:read', 'address, limit, cursor'],
    ['indexer', 'indexer:read', 'none'],
  ];
  return (
    <div className="two-column">
      <section className="card" style={{ minWidth: 0 }}>
        <div className="card-head">
          <div>
            <h2>Endpoints</h2>
            <div className="dim mono" style={{ marginTop: 3, fontSize: 12 }}>
              projectId {projectId} · limit default 25, max 100
            </div>
          </div>
          <CopyButton text={projectId} label="Copy project ID" />
        </div>
        {rows.map(([p, scope, filters]) => (
          <div key={p} style={{ padding: '11px 18px', borderTop: '1px solid #1f2125', display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div className="mono" style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', fontSize: 12.5 }}>
              <span style={{ overflowWrap: 'anywhere' }}>
                <span className="dim">GET </span>/v1/projects/{'{projectId}'}/{p}
              </span>
              <span className="chip">{scope}</span>
            </div>
            <span className="dim" style={{ fontSize: 12 }}>
              Filters: {filters}
            </span>
          </div>
        ))}
        <p className="dim" style={{ margin: 0, padding: '12px 18px', borderTop: '1px solid #1f2125', fontSize: 12 }}>
          Base URL: <span className="mono">{publicBase()}</span> · OpenAPI: <a href="/backend/openapi.yaml">openapi.yaml</a>
        </p>
      </section>
      <section className="card panel" style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: 12.5, lineHeight: 1.55, color: 'var(--muted)' }}>
        <h2 style={{ margin: 0, color: 'var(--foreground)' }}>Response rules</h2>
        <p style={{ margin: 0 }}>Large integers, block numbers, and amounts are decimal strings. Undecoded logs keep their raw topics and data with an explicit decode status.</p>
        <p style={{ margin: 0 }}>Every response carries requestId, network identity, observedAt, the latest checkpoint, per-source coverage, and explicit unknown finality, so a stale indexer is distinguishable from an empty result.</p>
        <p style={{ margin: 0 }}>Cursors are opaque and bound to project, filters, network fingerprint, and snapshot. After a reorganization, reindex, or network reset, an old cursor returns 409 CURSOR_RESTART_REQUIRED instead of drifting.</p>
        <p style={{ margin: 0 }}>nextCursor: null means no next page in this snapshot, not that future chain events cannot appear.</p>
        <p style={{ margin: 0 }}>Errors: 400 INVALID_QUERY · 401 UNAUTHORIZED · 403 FORBIDDEN_SCOPE · 404 PROJECT_NOT_FOUND · 409 CURSOR_RESTART_REQUIRED · 429 RATE_LIMITED · 5xx SERVICE_UNAVAILABLE.</p>
        <p style={{ margin: 0 }}>Native endpoints, wallet aggregation, prices, mutation APIs, and SDK packages: Planned.</p>
      </section>
    </div>
  );
}
