'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useWallet } from '@/lib/wallet';
import { groupDigits } from '@/lib/format';
import { KV, Modal, Notice } from '@/components/ui';
import { useWorkspace } from '@/components/workspace-shell';

export interface Prepared {
  transactionId: string;
  request: { from: string; to?: string; data: string; value: string; chainId: string };
  review: Record<string, any>;
}

export type FlowResult =
  | { kind: 'submitted'; transactionId: string; hash: string }
  | { kind: 'rejected' | 'wrong_network' | 'failed_before_broadcast'; transactionId: string; error: string }
  | { kind: 'unknown'; transactionId: string; error: string };

/** Render the server-side review (fee, deposit, args) exactly as prepared. */
export function ReviewRows({ prepared, extra }: { prepared: Prepared; extra?: Array<[string, React.ReactNode]> }) {
  const r = prepared.review;
  const fee = r.fee ?? {};
  const dep = r.storageDeposit ?? {};
  return (
    <KV
      rows={[
        ['Network', r.network],
        ['From (signer)', prepared.request.from],
        ['To', prepared.request.to ?? 'Contract creation (no recipient)'],
        ...(extra ?? []),
        ['Arguments', <span key="a">{JSON.stringify(r.args)}</span>],
        ['Value', `${groupDigits(r.valueRaw)} raw base units`],
        [
          'Fee estimate',
          fee.status === 'estimated' ? (
            <span key="f">
              gas {groupDigits(fee.gasLimitEstimate)} × price {fee.gasPriceRaw ? groupDigits(fee.gasPriceRaw) : 'unavailable'} = {fee.maxFeeRaw ? `${groupDigits(fee.maxFeeRaw)} raw base units` : 'unavailable'}
              <br />
              <span className="dim">{fee.note}</span>
            </span>
          ) : (
            <span key="f" className="warning-text">
              Estimate failed: {fee.error}
            </span>
          ),
        ],
        [
          'Storage deposit',
          dep.status === 'estimated' ? (
            <span key="d">
              {dep.kind === 'charge' ? 'Charge' : 'Refund'} {groupDigits(dep.amountRaw)} native base units · {dep.method} dry-run at {dep.blockHash?.slice(0, 12)}…
            </span>
          ) : (
            <span key="d" className="dim">
              Unavailable: {dep.reason}
            </span>
          ),
        ],
        ['Calldata', <span key="c">{prepared.request.data.length > 300 ? `${prepared.request.data.slice(0, 300)}… (${(prepared.request.data.length - 2) / 2} bytes)` : prepared.request.data}</span>],
        ['Finality', 'Unknown until a verified finality adapter exists; inclusion is not finality.'],
      ]}
    />
  );
}

export function SignDialog({
  title,
  prepared,
  request,
  projectId,
  onClose,
  onDone,
  extraRows,
}: {
  title: string;
  prepared: Prepared;
  request: <T>(path: string, init?: RequestInit) => Promise<T>;
  projectId: string;
  onClose(): void;
  onDone(r: FlowResult): void;
  extraRows?: Array<[string, React.ReactNode]>;
}) {
  const wallet = useWallet();
  const { fixture } = useWorkspace();
  const [phase, setPhase] = useState<'review' | 'waiting'>('review');
  const [err, setErr] = useState('');
  const [balance, setBalance] = useState<string | null>(null);
  const accountChanged = !!wallet.account && wallet.account.toLowerCase() !== prepared.request.from.toLowerCase();

  // Balance check before asking for a signature: value plus the estimated maximum fee.
  // Unknown (wallet on another chain, RPC error) does not block; the wallet still checks.
  useEffect(() => {
    let live = true;
    if (wallet.account && wallet.onPortaldot && !accountChanged) wallet.balanceRaw().then((b) => live && setBalance(b));
    else setBalance(null);
    return () => {
      live = false;
    };
  }, [wallet, accountChanged]);
  const needed = BigInt(prepared.request.value || '0x0') + (prepared.review.fee?.maxFeeRaw ? BigInt(prepared.review.fee.maxFeeRaw) : 0n);
  const insufficient = balance !== null && BigInt(balance) < needed;

  async function record(outcome: string, body: Record<string, unknown>) {
    await request(`/workspace/projects/${projectId}/transactions/${prepared.transactionId}/submission`, { method: 'POST', body: JSON.stringify({ outcome, ...body }) });
  }

  async function sign() {
    setErr('');
    if (!wallet.account) {
      setErr('Connect a wallet first.');
      return;
    }
    if (wallet.account.toLowerCase() !== prepared.request.from.toLowerCase()) {
      setErr('The selected wallet account changed since this review was prepared. Close and review again.');
      return;
    }
    if (!wallet.onPortaldot) {
      const sw = await wallet.switchNetwork();
      if (!sw.ok) {
        await record('wrong_network', { error: sw.message }).catch(() => {});
        onDone({ kind: 'wrong_network', transactionId: prepared.transactionId, error: `${sw.message} Nothing was signed.` });
        return;
      }
    }
    setPhase('waiting');
    const r = await wallet.send({ from: prepared.request.from, to: prepared.request.to, data: prepared.request.data, value: prepared.request.value });
    try {
      if (r.outcome === 'submitted') {
        await record('submitted', { hash: r.hash });
        onDone({ kind: 'submitted', transactionId: prepared.transactionId, hash: r.hash });
      } else if (r.outcome === 'unknown') {
        await record('unknown', { error: r.error });
        // If the wallet answers late, attach the hash without resubmitting anything.
        r.late?.then((hash) => {
          if (hash) void record('submitted', { hash }).catch(() => {});
        });
        onDone({ kind: 'unknown', transactionId: prepared.transactionId, error: r.error });
      } else {
        await record(r.outcome, { error: r.error });
        onDone({ kind: r.outcome, transactionId: prepared.transactionId, error: r.error });
      }
    } catch (e) {
      onDone({ kind: 'unknown', transactionId: prepared.transactionId, error: `The wallet result could not be recorded: ${(e as Error).message}` });
    }
  }

  const feeFailed = prepared.review.fee?.status === 'failed';
  return (
    <Modal
      title={title}
      wide
      onClose={phase === 'waiting' ? () => {} : onClose}
      footer={
        phase === 'review' ? (
          <>
            <button className="button secondary" onClick={onClose}>
              Back
            </button>
            <button className="button" onClick={() => void sign()} disabled={!wallet.account || accountChanged || insufficient} data-autofocus>
              Request signature
            </button>
          </>
        ) : null
      }
    >
      {phase === 'review' ? (
        <>
          <div className="badge-row" style={{ marginTop: 0 }}>
            {fixture ? (
              <span className="chip" style={{ borderColor: '#3d3320', color: '#e6d3a8' }}>
                FIXTURE NETWORK transaction · local test chain, not Portaldot
              </span>
            ) : (
              <span className="chip" style={{ borderColor: '#5a4a2a', color: '#f3e2bb' }}>
                Real testnet transaction
              </span>
            )}
          </div>
          <p className="muted" style={{ margin: 0, fontSize: 13.5, lineHeight: 1.55 }}>
            Review the exact network, account, call, value, fee, and deposit. Your wallet shows the final request; nothing is submitted until you approve it there. A signed transaction cannot be reversed.
          </p>
          <div className="card panel" style={{ background: '#111214' }}>
            <ReviewRows prepared={prepared} extra={extraRows} />
          </div>
          {prepared.review.simulatedRevert && (
            <Notice tone="danger" title={`Simulation reverted: ${prepared.review.simulatedRevert.name}`}>
              {JSON.stringify(prepared.review.simulatedRevert.args)}. Submitting will likely fail and may still be charged a fee.
            </Notice>
          )}
          {feeFailed && !prepared.review.simulatedRevert && <Notice tone="warning" title="Fee estimate failed">The node could not estimate gas. The call may revert, or the RPC may be unavailable.</Notice>}
          {!wallet.account && <Notice tone="warning">Connect a wallet to sign.</Notice>}
          {accountChanged && (
            <Notice tone="warning" title="The wallet account changed">
              This review was prepared for {prepared.request.from}, but the wallet now selects {wallet.account}. Close and review again with the account you want to sign with.
            </Notice>
          )}
          {insufficient && (
            <Notice tone="danger" title="Not enough test tPOT">
              This account holds {groupDigits(balance!)} raw base units; this transaction needs at least {groupDigits(needed.toString())} (value plus the estimated maximum fee). Fund the account with test tPOT
              first (<Link href="/docs/funding">Funding</Link>). PalletDock does not send test tokens.
            </Notice>
          )}
          {err && <Notice tone="danger">{err}</Notice>}
        </>
      ) : (
        <div style={{ paddingBottom: 20 }}>
          <strong>Waiting for wallet approval</strong>
          <p className="muted" style={{ margin: '6px 0 0', fontSize: 13 }}>
            Approve or reject the request in your wallet. If the wallet does not answer, PalletDock records the result as unknown and will not resubmit.
          </p>
        </div>
      )}
    </Modal>
  );
}
