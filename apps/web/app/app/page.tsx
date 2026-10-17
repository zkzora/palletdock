'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useWorkspace } from '@/components/workspace-shell';
import { EmptyState, ErrorState, LoadingCards } from '@/components/page-state';
import { execLabel } from '@/components/tx-progress';
import { CopyButton, Notice, type Tone } from '@/components/ui';
import { useResource } from '@/lib/use-resource';
import { useWallet } from '@/lib/wallet';
import { ago, groupDigits, shortAddr, shortHash, when } from '@/lib/format';

interface Overview {
  project: Record<string, any>;
  counts: { contracts: number; transactions: number; failed_transactions: number; indexed_events: number; active_keys: number };
  indexer: Record<string, any> | null;
  transactions: Array<Record<string, any>>;
  events: Array<Record<string, any>>;
  contracts: Array<Record<string, any>>;
}

export default function OverviewPage() {
  const { projectId, project, readOnly, href } = useWorkspace();
  const { data: res, error, loading, reload } = useResource<{ data: Overview }>(projectId ? `/workspace/projects/${projectId}/overview` : null, { pollMs: 15000 });
  const net = useResource<{ data: any }>('/workspace/network');
  const data = res?.data;

  if (!project)
    return <EmptyState title="Start your first project" body="Keep a contract, its events, and its application API in the same project." action={<Link className="button" href="/app/projects/new">Create project</Link>} />;

  const ixStatus = data?.indexer?.status as string | undefined;
  const flow: Array<[string, string, string, Tone, string]> = data
    ? [
        ['01 · Contracts', String(data.counts.contracts), data.counts.contracts ? 'Tracked in this project' : 'No contracts connected', data.counts.contracts ? 'success' : 'idle', '/app/contracts'],
        ['02 · Transactions', String(data.counts.transactions), data.counts.failed_transactions ? `${data.counts.failed_transactions} reverted execution(s)` : 'No reverted executions observed', data.counts.failed_transactions ? 'danger' : 'success', '/app/transactions'],
        ['03 · Indexer', ixStatus ? ixStatus.replace('_', ' ') : 'Not configured', data.indexer?.checkpoint_block ? `Checkpoint ${groupDigits(data.indexer.checkpoint_block)} · ${ago(data.indexer.checkpoint_at)}` : 'Coverage unavailable', ixStatus === 'error' || ixStatus === 'recovery_required' ? 'danger' : ixStatus ? 'info' : 'idle', '/app/indexer'],
        ['04 · Events', groupDigits(String(data.counts.indexed_events)), data.counts.indexed_events ? 'Canonical records stored' : 'No indexed events', data.counts.indexed_events ? 'success' : 'idle', '/app/indexer'],
        ['05 · API', `${data.counts.active_keys} active key${data.counts.active_keys === 1 ? '' : 's'}`, 'Project-scoped read access', data.counts.active_keys ? 'success' : 'idle', '/app/api'],
      ]
    : [];

  const activity: Array<{ title: string; detail: string; at: string; tone: Tone; href: string }> = [];
  data?.transactions.forEach((t) => {
    const [label, tone] = execLabel(t as any);
    activity.push({ title: label, detail: `${t.kind === 'deploy' ? 'Contract creation' : t.function_name ?? 'call'}${t.hash ? ` · ${shortHash(t.hash)}` : ''}`, at: t.updated_at, tone, href: `/app/transactions/${t.id}` });
  });
  data?.events.forEach((e) => activity.push({ title: 'Event indexed', detail: `${e.event_name ?? e.status} · block ${groupDigits(e.block_number)} · log ${e.log_index}`, at: e.indexed_at, tone: e.status === 'decoded' ? 'success' : 'warning', href: `/app/transactions?hash=${e.transaction_hash}` }));
  data?.contracts.forEach((c) => activity.push({ title: c.source === 'deployed' ? 'Contract deployed' : 'Contract imported', detail: `${c.name} · ${shortAddr(c.address)}`, at: c.created_at, tone: 'idle', href: `/app/contracts/${c.id}` }));
  activity.sort((a, b) => (a.at < b.at ? 1 : -1));

  const fp = net.data?.data?.fingerprint;
  return (
    <div className="page-stack">
      <div className="page-heading">
        <div>
          <div className="eyebrow">Project overview</div>
          <h1 className="page-title">{project.name}</h1>
          <p>{project.description || 'No project description.'}</p>
          <div className="badge-row">
            <span className="badge">Portaldot V3 Testnet</span>
            <span className="badge">EVM layer</span>
          </div>
        </div>
        {data && data.counts.contracts > 0 && (
          <Link className="button" href={href('/app/contracts')}>
            Open contracts
          </Link>
        )}
      </div>
      {loading ? (
        <LoadingCards />
      ) : error ? (
        <ErrorState message={error} retry={() => void reload()} />
      ) : (
        <>
          {data && data.counts.contracts === 0 && (
            <section className="empty-state">
              <div>
                <h2>No contracts in this project yet</h2>
                <p>Deploy a compiled artifact with your browser wallet, or import a contract you already deployed by address and ABI. Importing is off-chain organization; it does not change contract ownership.</p>
              </div>
              {!readOnly && (
                <div className="form-actions" style={{ marginTop: 0 }}>
                  <Link className="button" href={href('/app/contracts/deploy')}>
                    Deploy contract
                  </Link>
                  <Link className="button secondary" href={href('/app/contracts/import')}>
                    Import contract
                  </Link>
                </div>
              )}
              <span className="dim" style={{ fontSize: 12.5 }}>
                Before deploying, read <Link href="/docs/accounts">Accounts and mapping</Link> and <Link href="/docs/deploy">Deploy a Solidity contract</Link>.
              </span>
            </section>
          )}
          <div className="flow-grid">
            {flow.map(([k, v, n, s, h]) => (
              <Link href={href(h)} key={k}>
                <span className="mono dim">{k}</span>
                <strong>{v}</strong>
                <span className="flow-note">
                  {n}
                </span>
              </Link>
            ))}
          </div>
          <div className="two-column">
            <section className="card table-card">
              <div className="card-head">
                <h2>Activity</h2>
                <span>Newest first · recorded observations</span>
              </div>
              {activity.length ? (
                activity.slice(0, 12).map((a, i) => (
                  <Link key={i} className="activity-row" href={href(a.href)} style={{ textDecoration: 'none', color: 'inherit' }}>
                    <span>
                      <strong style={{ fontWeight: 500 }}>{a.title}</strong>
                      <small className="mono">{a.detail}</small>
                    </span>
                    <time>{when(a.at).slice(5, 16)}</time>
                  </Link>
                ))
              ) : (
                <p className="card-empty">No activity recorded yet.</p>
              )}
            </section>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 20, minWidth: 0 }}>
              <section className="card panel">
                <div className="panel-row">
                  <h2>Network identity</h2>
                  <Link href={href('/app/network')} style={{ fontSize: 12 }}>
                    Probes and fingerprint
                  </Link>
                </div>
                <dl className="kv">
                  <div>
                    <dt>Network</dt>
                    <dd>Portaldot V3 Testnet</dd>
                  </div>
                  <div>
                    <dt>EVM chain ID</dt>
                    <dd>420420777 · 0x190f1ca9</dd>
                  </div>
                  <div>
                    <dt>Genesis hash</dt>
                    <dd>{fp ? (fp.status === 'active' ? fp.genesis_hash : `${fp.genesis_hash} (${fp.status})`) : <span className="warning-text">Not verified yet</span>}</dd>
                  </div>
                  <div>
                    <dt>Runtime</dt>
                    <dd>{fp ? `${fp.spec_name} v${fp.spec_version}` : 'Unavailable'}</dd>
                  </div>
                  <div>
                    <dt>Verified</dt>
                    <dd>{fp ? `${when(fp.last_verified_at)} (${ago(fp.last_verified_at)})` : 'No successful identity probe recorded'}</dd>
                  </div>
                </dl>
              </section>
              <MappingPanel verified={!!fp && fp.status === 'active'} />
              <section className="card panel">
                <h2>Capabilities not yet available</h2>
                {[
                  ['Native event indexing', 'Planned'],
                  ['Native signer and Revive weight review', 'Planned'],
                  ['Verified finality adapter', 'Not available'],
                  ['Source verification', 'Unavailable'],
                  ['Native Assets / NFTs management', 'Planned'],
                ].map(([l, s]) => (
                  <div key={l} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, padding: '8px 0', borderTop: '1px solid #222429', fontSize: 13 }}>
                    <span style={{ color: '#c4c8ce' }}>{l}</span>
                    <span className="chip dashed">{s}</span>
                  </div>
                ))}
              </section>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function MappingPanel({ verified }: { verified: boolean }) {
  const { projectId, request, openSigner } = useWorkspace();
  const wallet = useWallet();
  const [m, setM] = useState<any>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  async function resolve(refresh = false) {
    setBusy(true);
    setErr('');
    try {
      const r = await request<{ data: any }>(`/workspace/projects/${projectId}/accounts/mapping`, { method: 'POST', body: JSON.stringify({ address: wallet.account, refresh }) });
      setM(r.data);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="card panel">
      <div className="panel-row">
        <h2>Account mapping</h2>
        <Link href="/docs/accounts" style={{ fontSize: 12 }}>
          How mapping works
        </Link>
      </div>
      <p className="dim" style={{ margin: '0 0 12px', fontSize: 12.5, lineHeight: 1.5 }}>
        Resolves the native funding account for your EVM signer with the runtime's reviveApi.accountId at a finalized block. The result is never guessed.
      </p>
      {!wallet.account ? (
        <button className="button secondary" onClick={openSigner}>
          Connect wallet to resolve
        </button>
      ) : !verified ? (
        <Notice tone="warning">Network identity is not verified yet, so mapping is unavailable.</Notice>
      ) : m ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div className="card" style={{ padding: '10px 12px', background: '#111214' }}>
            <div className="dim" style={{ fontSize: 11.5 }}>EVM signing address (H160)</div>
            <div className="mono" style={{ marginTop: 4, fontSize: 12, overflowWrap: 'anywhere' }}>{m.evm_address}</div>
          </div>
          <div className="mono dim" style={{ paddingLeft: 14, fontSize: 11.5 }}>↓ mapping direction: EVM → native</div>
          <div className="card" style={{ padding: '10px 12px', background: '#111214' }}>
            <div className="dim" style={{ fontSize: 11.5 }}>Mapped native funding account (SS58, prefix 42)</div>
            <div className="mono" style={{ marginTop: 4, fontSize: 12, overflowWrap: 'anywhere', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              {m.native_ss58} <CopyButton text={m.native_ss58} label="Copy native account" />
            </div>
          </div>
          <span className="dim mono" style={{ fontSize: 11.5 }}>
            {m.method} · block {groupDigits(m.block_number)} ({shortHash(m.block_hash)}) · runtime v{m.spec_version} · {when(m.resolved_at)}
            {m.cached ? ' · cached' : ''}
          </span>
          <div>
            <button className="mini-button" onClick={() => void resolve(true)} disabled={busy}>
              Recheck now
            </button>
          </div>
        </div>
      ) : (
        <button className="button secondary" onClick={() => void resolve()} disabled={busy} aria-busy={busy}>
          {busy ? 'Resolving…' : `Resolve funding account for ${shortAddr(wallet.account)}`}
        </button>
      )}
      {err && <div style={{ marginTop: 10 }}><Notice tone="danger">{err}</Notice></div>}
    </section>
  );
}
