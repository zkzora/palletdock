'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { useWorkspace } from '@/components/workspace-shell';
import { AbiInputs } from '@/components/abi-form';
import { SignDialog, type FlowResult, type Prepared } from '@/components/sign-flow';
import { TxProgress } from '@/components/tx-progress';
import { CopyButton, Modal, Notice, Pre, Tabs, useToast } from '@/components/ui';
import { ErrorState, LoadingCards } from '@/components/page-state';
import { useResource } from '@/lib/use-resource';
import { useWallet } from '@/lib/wallet';
import { evmUnitExplanation, evmUnitLabel, useEvmUnitPolicy } from '@/lib/units';
import { groupDigits, pretty, shortHash, when } from '@/lib/format';

interface Fn {
  name: string;
  signature: string;
  inputs: Array<{ name: string; type: string; components?: any[] }>;
  outputs?: Array<{ name: string; type: string }>;
  payable?: boolean;
}
interface Contract {
  id: string;
  name: string;
  address: string;
  source: string;
  deployTxHash: string | null;
  deployBlock: string | null;
  codeObserved: any;
  removedAt: string | null;
  abi: unknown[];
  abiVersion: { version: number; sha256: string; provenance: string; createdAt: string };
  abiVersions: Array<{ version: number; abi_sha256: string; provenance: string; created_at: string }>;
  readFunctions: Fn[];
  writeFunctions: Fn[];
  events: Array<{ name: string; signature: string; topic0: string }>;
  indexerSources: Array<{ id: string; status: string; checkpoint_block: string | null; start_block: string }>;
}

type Tab = 'read' | 'write' | 'events' | 'abi';

export default function ContractDetailPage() {
  const { contractId } = useParams<{ contractId: string }>();
  const { projectId, readOnly, request, href } = useWorkspace();
  const router = useRouter();
  const toast = useToast();
  const { data, error, loading, reload } = useResource<{ data: Contract }>(projectId ? `/workspace/projects/${projectId}/contracts/${contractId}` : null);
  const [tab, setTab] = useState<Tab>('read');
  const [confirmRemove, setConfirmRemove] = useState(false);
  const c = data?.data;

  if (loading) return <LoadingCards />;
  if (error) return <ErrorState message={error} retry={() => void reload()} />;
  if (!c) return null;

  async function remove() {
    try {
      await request(`/workspace/projects/${projectId}/contracts/${contractId}/remove`, { method: 'POST' });
      router.push(href('/app/contracts'));
    } catch (e) {
      toast.show((e as Error).message, true);
      setConfirmRemove(false);
    }
  }

  function downloadAbi() {
    const blob = new Blob([JSON.stringify(c!.abi, null, 2)], { type: 'application/json' });
    const u = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = u;
    a.download = `${c!.name}.abi.v${c!.abiVersion.version}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(u), 2000);
  }

  return (
    <div className="page-stack">
      <div>
        <Link href={href('/app/contracts')} className="dim" style={{ fontSize: 13 }}>
          ← Contracts
        </Link>
      </div>
      <div className="page-heading">
        <div style={{ minWidth: 0 }}>
          <div className="eyebrow">Contract Studio · {c.source}</div>
          <h1 className="page-title">{c.name}</h1>
          <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span className="mono" style={{ fontSize: 12.5, color: '#c4c8ce', overflowWrap: 'anywhere' }}>
              {c.address}
            </span>
            <CopyButton text={c.address} label="Copy contract address" />
          </div>
          <div className="badge-row">
            <span className="chip">
              ABI v{c.abiVersion.version} · {c.abiVersion.provenance}
            </span>
            <span className="chip dashed">Verification unavailable</span>
            <span className="chip">{c.deployBlock ? `Deployed in block ${groupDigits(c.deployBlock)}` : 'Deployment block not recorded'}</span>
            {c.removedAt && <span className="chip dashed">Removed from tracking</span>}
          </div>
        </div>
        <div className="form-actions" style={{ marginTop: 0 }}>
          <button className="button secondary" onClick={downloadAbi}>
            Download ABI
          </button>
          {!c.removedAt && (
            <button className="button danger" disabled={readOnly} onClick={() => setConfirmRemove(true)}>
              Remove
            </button>
          )}
        </div>
      </div>
      <Tabs<Tab>
        label="Contract views"
        value={tab}
        onChange={setTab}
        tabs={[
          ['read', `Read (${c.readFunctions.length})`],
          ['write', `Write (${c.writeFunctions.length})`],
          ['events', 'Events'],
          ['abi', 'ABI'],
        ]}
      />
      {tab === 'read' && <ReadTab c={c} />}
      {tab === 'write' && <WriteTab c={c} />}
      {tab === 'events' && <EventsTab c={c} />}
      {tab === 'abi' && <AbiTab c={c} onReplaced={() => void reload()} />}
      {confirmRemove && (
        <Modal
          title="Remove from workspace tracking"
          onClose={() => setConfirmRemove(false)}
          footer={
            <>
              <button className="button secondary" onClick={() => setConfirmRemove(false)} data-autofocus>
                Keep contract
              </button>
              <button className="button danger" onClick={() => void remove()}>
                Remove from project
              </button>
            </>
          }
        >
          <p style={{ margin: 0, lineHeight: 1.55, color: '#c4c8ce' }}>
            {c.name} stops being tracked in this project and its indexer sources stop. On-chain code is unchanged. Historical transactions and indexed logs are kept.
          </p>
        </Modal>
      )}
      {toast.node}
    </div>
  );
}

function ReadTab({ c }: { c: Contract }) {
  const { projectId, request } = useWorkspace();
  const [sig, setSig] = useState(c.readFunctions[0]?.signature ?? '');
  const [args, setArgs] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<any>(null);
  const [err, setErr] = useState('');
  const fn = c.readFunctions.find((f) => f.signature === sig);
  if (!c.readFunctions.length) return <section className="card panel"><p className="dim" style={{ margin: 0 }}>This ABI has no read functions.</p></section>;
  async function run() {
    setBusy(true);
    setErr('');
    setRes(null);
    try {
      const r = await request<{ data: any }>(`/workspace/projects/${projectId}/contracts/${c.id}/read`, { method: 'POST', body: JSON.stringify({ function: sig, args }) });
      setRes(r.data);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="card form-card" style={{ maxWidth: 760 }}>
      <div className="field">
        <label htmlFor="read-fn">Function</label>
        <select id="read-fn" className="input mono" value={sig} onChange={(e) => { setSig(e.target.value); setArgs([]); setRes(null); }}>
          {c.readFunctions.map((f) => (
            <option key={f.signature} value={f.signature}>
              {f.signature}
            </option>
          ))}
        </select>
      </div>
      <span className="dim" style={{ fontSize: 12.5 }}>
        Returns ({fn?.outputs?.map((o) => o.type).join(', ')}) · eth_call, nothing is broadcast
      </span>
      {fn && <AbiInputs params={fn.inputs} values={args} onChange={setArgs} idPrefix="read" />}
      <div>
        <button className="button" onClick={() => void run()} disabled={busy} aria-busy={busy}>
          {busy ? 'Reading…' : 'Read'}
        </button>
      </div>
      {err && <Notice tone="danger">{err}</Notice>}
      {res && (
        <div className="card" style={{ background: '#111214', overflow: 'hidden' }}>
          {res.ok ? (
            <div style={{ padding: '12px 14px', display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
              <span className="mono" style={{ fontSize: 15, overflowWrap: 'anywhere' }}>
                {typeof res.result === 'string' ? res.result : pretty(res.result)}
              </span>
              <span className="dim" style={{ fontSize: 12 }}>
                at block {groupDigits(res.blockNumber)} · {when(res.observedAt)}
              </span>
            </div>
          ) : (
            <div style={{ padding: 14 }}>
              <Notice tone="danger" title={res.revert ? `Reverted: ${res.revert.name}` : 'Call failed'}>
                {res.revert ? JSON.stringify(res.revert.args) : res.error}
              </Notice>
            </div>
          )}
          <div className="eyebrow" style={{ padding: '8px 14px 4px', borderTop: '1px solid var(--border)' }}>
            Raw response
          </div>
          <Pre>{res.raw ?? res.revertData ?? '—'}</Pre>
        </div>
      )}
    </section>
  );
}

function WriteTab({ c }: { c: Contract }) {
  const { projectId, readOnly, request, openSigner, href } = useWorkspace();
  const units = useEvmUnitPolicy();
  const wallet = useWallet();
  const [sig, setSig] = useState(c.writeFunctions[0]?.signature ?? '');
  const [args, setArgs] = useState<string[]>([]);
  const [value, setValue] = useState('0');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [result, setResult] = useState<FlowResult | null>(null);
  const fn = c.writeFunctions.find((f) => f.signature === sig);
  const blocked = readOnly ? 'This project is archived and read-only.' : c.removedAt ? 'This contract was removed from tracking.' : !wallet.account ? 'Connect a wallet to sign writes. PalletDock never holds keys.' : !wallet.onPortaldot ? 'The wallet is on a different network. You will be asked to switch before signing.' : '';

  async function review() {
    setErr('');
    setBusy(true);
    try {
      const r = await request<{ data: Prepared }>(`/workspace/projects/${projectId}/contracts/${c.id}/prepare-write`, {
        method: 'POST',
        body: JSON.stringify({ function: sig, args, value: value.trim() || '0', from: wallet.account }),
      });
      setPrepared(r.data);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!c.writeFunctions.length) return <section className="card panel"><p className="dim" style={{ margin: 0 }}>This ABI has no write functions.</p></section>;
  return (
    <div className="two-column">
      <section className="card form-card">
        <div className="field">
          <label htmlFor="write-fn">Function</label>
          <select id="write-fn" className="input mono" value={sig} onChange={(e) => { setSig(e.target.value); setArgs([]); setResult(null); }}>
            {c.writeFunctions.map((f) => (
              <option key={f.signature} value={f.signature}>
                {f.signature}
              </option>
            ))}
          </select>
        </div>
        <span className="dim" style={{ fontSize: 12.5, lineHeight: 1.5 }}>
          Writes change on-chain state and require a wallet signature after review. Fee and deposit estimates come from the node at review time.
        </span>
        {fn && <AbiInputs params={fn.inputs} values={args} onChange={setArgs} idPrefix="write" />}
        {fn?.payable && (
          <div className="field">
            <label htmlFor="write-value">
              Value <span className="dim">{evmUnitLabel(units)}</span>
            </label>
            <input id="write-value" className="input mono" value={value} onChange={(e) => setValue(e.target.value)} />
          </div>
        )}
        {blocked && (
          <Notice tone="warning" action={!wallet.account && !readOnly ? <button className="button secondary" onClick={openSigner}>Connect wallet</button> : undefined}>
            {blocked}
          </Notice>
        )}
        {err && <Notice tone="danger">{err}</Notice>}
        <div>
          <button className="button" onClick={() => void review()} disabled={busy || readOnly || !!c.removedAt || !wallet.account} aria-busy={busy}>
            {busy ? 'Preparing review…' : 'Review write'}
          </button>
        </div>
        {result && (
          <div style={{ borderTop: '1px solid var(--border)', paddingTop: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
            {result.kind === 'submitted' ? (
              <TxProgress transactionId={result.transactionId} />
            ) : (
              <Notice tone={result.kind === 'rejected' ? 'info' : result.kind === 'unknown' ? 'warning' : 'danger'} title={result.kind === 'rejected' ? 'Rejected in the wallet' : result.kind === 'unknown' ? 'Submission could not be confirmed' : 'Not submitted'}>
                {result.error}
                {result.kind === 'unknown' && " Check this account's activity before retrying."}
              </Notice>
            )}
            <div>
              <Link className="button secondary" href={href(`/app/transactions/${result.transactionId}`)}>
                View transaction details
              </Link>
            </div>
          </div>
        )}
      </section>
      <SignerPanel />
      {prepared && projectId && (
        <SignDialog title="Review on-chain write" prepared={prepared} request={request} projectId={projectId} onClose={() => setPrepared(null)} onDone={(r) => { setPrepared(null); setResult(r); }} extraRows={[['Function', prepared.review.function]]} />
      )}
    </div>
  );
}

function SignerPanel() {
  const wallet = useWallet();
  const units = useEvmUnitPolicy();
  const { openSigner } = useWorkspace();
  const [bal, setBal] = useState<string | null>(null);
  useEffect(() => {
    if (wallet.account && wallet.onPortaldot) wallet.balanceRaw().then(setBal);
    else setBal(null);
  }, [wallet.account, wallet.onPortaldot, wallet]);
  return (
    <section className="card panel">
      <div className="panel-row">
        <h2>Signer</h2>
        <Link href="/docs/accounts" style={{ fontSize: 12 }}>
          Accounts and mapping
        </Link>
      </div>
      {wallet.account ? (
        <dl className="kv">
          <div>
            <dt>EVM account</dt>
            <dd>{wallet.account}</dd>
          </div>
          <div>
            <dt>Wallet chain</dt>
            <dd className={wallet.onPortaldot ? 'success-text' : 'warning-text'}>{wallet.onPortaldot ? '420420777 · matches' : `${wallet.chainId} · does not match`}</dd>
          </div>
          <div>
            <dt>EVM balance</dt>
            <dd>{bal === null ? 'Unavailable' : `${groupDigits(bal)} raw base units`}</dd>
          </div>
          <div>
            <dt>Unit note</dt>
            <dd className="dim">{evmUnitExplanation(units)}</dd>
          </div>
        </dl>
      ) : (
        <>
          <p className="muted" style={{ margin: '0 0 14px', fontSize: 13, lineHeight: 1.55 }}>
            No signing account connected. PalletDock never asks for a seed phrase or private key; approvals happen in your wallet.
          </p>
          <button className="button secondary" onClick={openSigner}>
            Connect wallet
          </button>
        </>
      )}
    </section>
  );
}

function EventsTab({ c }: { c: Contract }) {
  const { projectId, href } = useWorkspace();
  const [f, setF] = useState({ event: 'all', decode: 'all', fromBlock: '', toBlock: '' });
  const [applied, setApplied] = useState(f);
  const qs = useMemo(() => new URLSearchParams(Object.entries(applied).filter(([, v]) => v && v !== 'all')).toString(), [applied]);
  const { data, error, loading, reload } = useResource<{ data: any[] }>(projectId ? `/workspace/projects/${projectId}/contracts/${c.id}/events?${qs}` : null);
  const rangeErr = (f.fromBlock && !/^\d+$/.test(f.fromBlock)) || (f.toBlock && !/^\d+$/.test(f.toBlock)) ? 'Block numbers must be whole numbers.' : f.fromBlock && f.toBlock && BigInt(f.toBlock) < BigInt(f.fromBlock) ? 'To block must be at least From block.' : '';
  return (
    <div className="page-stack" style={{ gap: 14 }}>
      <div className="filters">
        <div className="field">
          <label htmlFor="ev-sig">Event</label>
          <select id="ev-sig" className="input" value={f.event} onChange={(e) => setF({ ...f, event: e.target.value })}>
            <option value="all">All events</option>
            {c.events.map((e) => (
              <option key={e.signature} value={e.name}>
                {e.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="ev-dec">Decode status</label>
          <select id="ev-dec" className="input" value={f.decode} onChange={(e) => setF({ ...f, decode: e.target.value })}>
            <option value="all">All</option>
            <option value="decoded">Decoded</option>
            <option value="unknown_event">Unknown event</option>
            <option value="decode_error">Decode error</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="ev-from">From block</label>
          <input id="ev-from" className="input mono" style={{ width: 120 }} value={f.fromBlock} onChange={(e) => setF({ ...f, fromBlock: e.target.value })} placeholder="any" />
        </div>
        <div className="field">
          <label htmlFor="ev-to">To block</label>
          <input id="ev-to" className="input mono" style={{ width: 120 }} value={f.toBlock} onChange={(e) => setF({ ...f, toBlock: e.target.value })} placeholder="any" />
        </div>
        <button className="button secondary" disabled={!!rangeErr} onClick={() => setApplied(f)}>
          Apply
        </button>
        <button className="button ghost" onClick={() => { const z = { event: 'all', decode: 'all', fromBlock: '', toBlock: '' }; setF(z); setApplied(z); }}>
          Clear filters
        </button>
      </div>
      {rangeErr && <p className="field-error">{rangeErr}</p>}
      {!c.indexerSources.length && (
        <Notice tone="info" action={<Link className="button secondary" href={href('/app/indexer')}>Open indexer</Link>}>
          No indexer covers this contract. Events appear here after a log source is configured and its checkpoint passes their block.
        </Notice>
      )}
      {loading ? (
        <LoadingCards />
      ) : error ? (
        <ErrorState message={error} retry={() => void reload()} />
      ) : (
        <section className="card table-scroll">
          <div style={{ minWidth: 760 }}>
            <div className="row-head" style={{ gridTemplateColumns: '90px 150px minmax(220px,1fr) 170px 50px' }}>
              <span>Block</span>
              <span>Event</span>
              <span>Decoded</span>
              <span>Transaction</span>
              <span>Log</span>
            </div>
            {data?.data.map((e) => (
              <div key={e.id} style={{ borderTop: '1px solid #1f2125', padding: '11px 18px' }}>
                <div className="mono" style={{ display: 'grid', gridTemplateColumns: '90px 150px minmax(220px,1fr) 170px 50px', gap: 14, fontSize: 12.5, alignItems: 'center' }}>
                  <span>{groupDigits(e.block_number)}</span>
                  <span className={e.status === 'decoded' ? '' : 'warning-text'}>{e.event_name ?? (e.status === 'unknown_event' ? 'Unknown' : 'Not decoded')}</span>
                  <span className="ellipsis" style={{ color: '#c4c8ce', fontSize: 12 }}>
                    {e.args ? Object.entries(e.args).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' · ') : e.decode_error ?? '—'}
                  </span>
                  <Link href={href(`/app/transactions?hash=${e.transaction_hash}`)} className="ellipsis">
                    {shortHash(e.transaction_hash)}
                  </Link>
                  <span>{e.log_index}</span>
                </div>
                {e.status !== 'decoded' && <Pre>{`topics: ${JSON.stringify(e.topics)}\ndata: ${e.data}`}</Pre>}
              </div>
            ))}
            {!data?.data.length && (
              <p className="card-empty" style={{ borderTop: '1px solid #1f2125' }}>
                No indexed events match these filters. Absence outside completed coverage is not evidence that an event never happened.
              </p>
            )}
          </div>
        </section>
      )}
    </div>
  );
}

function AbiTab({ c, onReplaced }: { c: Contract; onReplaced(): void }) {
  const { projectId, readOnly, request } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [err, setErr] = useState('');
  async function replace() {
    setErr('');
    try {
      JSON.parse(text);
    } catch {
      return setErr('ABI is not valid JSON.');
    }
    try {
      await request(`/workspace/projects/${projectId}/contracts/${c.id}/abi`, { method: 'POST', body: JSON.stringify({ abi: text }) });
      setOpen(false);
      setText('');
      onReplaced();
    } catch (e) {
      setErr((e as Error).message);
    }
  }
  return (
    <section className="card" style={{ minWidth: 0 }}>
      <div className="card-head">
        <span style={{ fontSize: 12.5 }}>
          v{c.abiVersion.version} · sha256 {c.abiVersion.sha256.slice(0, 12)}… · {c.abiVersions.length} version(s) · ABI attached, not source verification
        </span>
        {!open && (
          <button className="button secondary" disabled={readOnly || !!c.removedAt} onClick={() => setOpen(true)}>
            Replace ABI
          </button>
        )}
      </div>
      {open && (
        <div style={{ padding: '14px 18px', display: 'flex', flexDirection: 'column', gap: 10, borderBottom: '1px solid var(--border)' }}>
          <div className="field">
            <label htmlFor="abi-new">Replacement ABI (JSON)</label>
            <textarea id="abi-new" className="input mono" rows={10} value={text} onChange={(e) => setText(e.target.value)} style={{ fontSize: 12 }} />
          </div>
          <p className="dim" style={{ margin: 0, fontSize: 12.5 }}>
            Adds a new version. Earlier versions, raw logs, and existing decoded records are kept; existing indexer sources keep their pinned version.
          </p>
          {err && <p className="field-error">{err}</p>}
          <div className="form-actions" style={{ marginTop: 0 }}>
            <button className="button" onClick={() => void replace()}>
              Add ABI version
            </button>
            <button className="button secondary" onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      <div style={{ padding: '10px 18px' }}>
        {c.abiVersions.map((v) => (
          <div key={v.version} className="mono dim" style={{ fontSize: 12, padding: '3px 0' }}>
            v{v.version} · {v.provenance} · {when(v.created_at)} · {v.abi_sha256.slice(0, 16)}…
          </div>
        ))}
      </div>
      <Pre max={460}>{JSON.stringify(c.abi, null, 2)}</Pre>
    </section>
  );
}
