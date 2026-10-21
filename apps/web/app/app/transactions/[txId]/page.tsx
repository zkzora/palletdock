'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { useWorkspace } from '@/components/workspace-shell';
import { StatusCells, statusCells } from '@/components/tx-progress';
import { CopyButton, KV, Notice, Pre, type Tone } from '@/components/ui';
import { ErrorState, LoadingCards } from '@/components/page-state';
import { useResource } from '@/lib/use-resource';
import { groupDigits, pretty, shortHash, when } from '@/lib/format';

const STAGE_TONE: Record<string, Tone> = {
  prepared: 'idle',
  submitted: 'success',
  registered: 'success',
  rejected: 'idle',
  wrong_network: 'danger',
  failed_before_broadcast: 'danger',
  unknown: 'warning',
  receipt_observed: 'success',
  receipt_moved: 'warning',
  receipt_disappeared: 'warning',
  execution_succeeded: 'success',
  execution_reverted: 'danger',
  execution_unknown: 'unknown',
  contract_tracked: 'success',
  reconcile: 'info',
  receipt_mismatch: 'warning',
  history_pruned: 'info',
  tracking_settled: 'success',
  tracking_stopped: 'warning',
  restored_from_observations: 'info',
};

const STAGE_LABEL: Record<string, string> = {
  prepared: 'Prepared for review',
  submitted: 'Submitted by wallet',
  registered: 'Hash registered',
  rejected: 'Rejected in wallet',
  wrong_network: 'Blocked: wrong network',
  failed_before_broadcast: 'Failed before broadcast',
  unknown: 'Submission unconfirmed',
  receipt_observed: 'Receipt observed',
  receipt_moved: 'Receipt moved to another block',
  receipt_disappeared: 'Receipt disappeared',
  execution_succeeded: 'Execution succeeded',
  execution_reverted: 'Execution reverted',
  execution_unknown: 'Execution status unknown',
  contract_tracked: 'Contract added to project',
  reconcile: 'Account activity checked',
  receipt_mismatch: 'Receipt does not match the reviewed request',
  history_pruned: 'Node history pruned',
  tracking_settled: 'Receipt checks settled',
  tracking_stopped: 'Receipt checks stopped',
  restored_from_observations: 'Restored from observation log',
};

export default function TransactionDetailPage() {
  const { txId } = useParams<{ txId: string }>();
  const { projectId, request, href } = useWorkspace();
  const { data, error, loading, reload } = useResource<{ data: any }>(projectId ? `/workspace/projects/${projectId}/transactions/${txId}` : null, { pollMs: 5000 });
  const [checking, setChecking] = useState(false);
  const [checkMsg, setCheckMsg] = useState('');
  if (loading) return <LoadingCards />;
  if (error) return <ErrorState message={error} retry={() => void reload()} />;
  const t = data?.data;
  if (!t) return null;

  async function reconcile() {
    setChecking(true);
    setCheckMsg('');
    try {
      const r = await request<{ data: any }>(`/workspace/projects/${projectId}/transactions/${txId}/reconcile`, { method: 'POST' });
      setCheckMsg(
        r.data.hash
          ? r.data.receiptFound
            ? 'A receipt exists; the tracker is recording it.'
            : 'No receipt yet. This is not proof that the transaction failed.'
          : `Account nonce: latest ${r.data.nonceLatest}, pending ${r.data.noncePending}. Compare with your wallet's activity list before retrying.`,
      );
      await reload();
    } catch (e) {
      setCheckMsg((e as Error).message);
    } finally {
      setChecking(false);
    }
  }

  const ambiguous = t.status.submission === 'unknown' || t.status.inclusion === 'reorged_out';
  const decoded = t.logs.filter((l: any) => l.canonical);
  return (
    <div className="page-stack">
      <div>
        <Link href={href('/app/transactions')} className="dim" style={{ fontSize: 13 }}>
          ← Transactions
        </Link>
      </div>
      <div>
        <div className="eyebrow">
          Transaction · {t.kind === 'deploy' ? 'Contract creation' : t.function ?? 'Not decoded'} · {t.origin === 'registered' ? 'registered hash' : 'submitted through PalletDock'}
        </div>
        <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <h1 className="mono" style={{ margin: 0, fontSize: 22, fontWeight: 500, overflowWrap: 'anywhere' }}>
            {t.hash ? shortHash(t.hash, 14, 8) : 'No transaction hash'}
          </h1>
          {t.hash && <CopyButton text={t.hash} label="Copy transaction hash" />}
          {t.contract && (
            <Link className="mini-button" href={href(`/app/contracts/${t.contract.id}`)}>
              Open contract
            </Link>
          )}
        </div>
      </div>
      {ambiguous && (
        <Notice
          tone="warning"
          title={t.status.inclusion === 'reorged_out' ? 'The receipt is no longer returned by the node' : "Submission could not be confirmed. Check this account's activity before retrying."}
          action={
            <button className="button secondary" onClick={() => void reconcile()} disabled={checking}>
              {checking ? 'Checking…' : 'Check account activity'}
            </button>
          }
        >
          No receipt is available. This is not proof that the transaction failed. Do not resubmit until the original submission is understood.
        </Notice>
      )}
      {t.trackingStatus === 'history_pruned' && (
        <Notice tone="info" title="Node history pruned">
          The RPC node no longer serves this receipt or block. PalletDock keeps the last observed inclusion (block number and hash) and has stopped checking. This is not a failure or a reorganization.
        </Notice>
      )}
      {t.trackingStatus === 'gave_up' && (
        <Notice tone="warning" title="Receipt checks stopped">
          Checks stopped after repeated failures or no receipt within the waiting window. Stored data is unchanged. Use Check account activity to recheck.
        </Notice>
      )}
      {checkMsg && <Notice tone="info">{checkMsg}</Notice>}
      <StatusCells cells={statusCells(t.status, t.blockNumber, t.kind, t.indexerConfigured)} />
      {t.revert && (
        <Notice tone="danger" title={`Reverted with ${t.revert.name}`}>
          {JSON.stringify(t.revert.args)}
        </Notice>
      )}
      <div className="two-column">
        <section className="card panel">
          <h2>Details</h2>
          <KV
            rows={[
              ['Hash', t.hash],
              ['Network', `${t.network.networkId} · chain ${t.network.evm_chain_id} · genesis ${shortHash(t.network.genesis_hash)}`],
              ['From', t.from],
              ['To', t.to ?? 'Contract creation'],
              t.contractAddress && ['Created contract', t.contractAddress],
              ['Function', t.function ?? (t.kind === 'deploy' ? 'constructor' : 'Not decoded')],
              ['Decoded arguments', t.decodedArgs ? JSON.stringify(t.decodedArgs) : null],
              ['Value', t.valueRaw === null ? null : `${groupDigits(t.valueRaw)} raw base units${t.valueTokens ? ` = ${t.valueTokens}` : ''}`],
              ['Block', t.blockNumber ? groupDigits(t.blockNumber) : 'Not included'],
              ['Block hash', t.blockHash],
              ['Gas used', t.gasUsed ? groupDigits(t.gasUsed) : null],
              ['Effective gas price', t.effectiveGasPriceRaw ? `${groupDigits(t.effectiveGasPriceRaw)} raw base units` : null],
              ['Actual fee', t.feeRaw ? `${groupDigits(t.feeRaw)} raw base units (gas used × effective price)${t.feeTokens ? ` = ${t.feeTokens}` : ''}` : 'Unavailable until a receipt reports gas and price'],
              ['Storage deposit', t.storageDeposit?.status === 'estimated' ? `${t.storageDeposit.kind} ${groupDigits(t.storageDeposit.amountRaw)} native base units (pre-signing dry-run estimate)` : `Unavailable: ${t.storageDeposit?.reason ?? 'no compatible source'}`],
              ['Finality', 'Unknown — no verified finality adapter'],
              ['Units', t.unitNote],
              ['Input', t.input ? (t.input.length > 420 ? `${t.input.slice(0, 420)}… (${(t.input.length - 2) / 2} bytes)` : t.input) : null],
              t.error && ['Wallet message', t.error],
            ]}
          />
        </section>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20, minWidth: 0 }}>
          <section className="card panel">
            <div className="panel-row">
              <h2>Observed timeline</h2>
              <span className="dim" style={{ fontSize: 12 }}>
                Only what PalletDock observed, with observation time
              </span>
            </div>
            <div className="timeline">
              {t.observations.map((o: any, i: number) => (
                <div key={i}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 500 }}>{STAGE_LABEL[o.stage] ?? o.stage}</div>
                    <small>{o.detail}</small>
                  </div>
                  <time>{when(o.observed_at).slice(5, 19)}</time>
                </div>
              ))}
            </div>
          </section>
          <section className="card panel">
            <h2>Decoded events</h2>
            {decoded.length ? (
              decoded.map((l: any) => (
                <div key={l.id} className="card" style={{ background: '#111214', padding: '12px 14px', marginBottom: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div className="mono" style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', fontSize: 12.5 }}>
                    <span>{l.event_signature ?? (l.status === 'unknown_event' ? 'Unknown event' : 'Not decoded')}</span>
                    <span className="dim">
                      log {l.log_index} · {l.status} {l.abi_version ? `· ABI v${l.abi_version}` : ''}
                    </span>
                  </div>
                  <Pre>{l.args ? pretty(l.args) : `${l.decode_error ?? ''}\ntopics: ${JSON.stringify(l.topics)}\ndata: ${l.data}`}</Pre>
                </div>
              ))
            ) : (
              <p className="dim" style={{ margin: 0, fontSize: 13, lineHeight: 1.5 }}>
                {t.kind === 'deploy' ? 'Contract creation emits no tracked event.' : t.status.indexing === 'no_events' ? 'The receipt contains no logs.' : 'No indexed record for this transaction yet. Events appear after an indexer covering this contract passes its block.'}
              </p>
            )}
            {t.logs.some((l: any) => !l.canonical) && <p className="dim" style={{ margin: '8px 0 0', fontSize: 12 }}>Some records for this hash are kept as orphaned history after a reorganization.</p>}
          </section>
          <section className="card" style={{ minWidth: 0 }}>
            <div className="card-head">
              <h2>Raw receipt</h2>
              <span className="mono">eth_getTransactionReceipt</span>
            </div>
            {t.receipt ? (
              <Pre max={380}>{pretty(t.receipt)}</Pre>
            ) : t.trackingStatus === 'history_pruned' ? (
              <p className="card-empty">The receipt body was not retained, and the node no longer serves it (pruned history). Inclusion and execution above come from earlier observations.</p>
            ) : (
              <p className="card-empty">No receipt is available yet. This is not proof that the transaction failed.</p>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
