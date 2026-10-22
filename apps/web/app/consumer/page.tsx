'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { EMPTY_STATE, deriveView, fmtAge, reconcile, trackingTag, type ApiEvent, type ConsumerView, type ReadOutcome } from '@/lib/consumer/core';
import type { PublicConsumerConfig, StateResponse } from '@/lib/consumer/server';
import { NETWORK } from '@/lib/network';
import { shortHash } from '@/lib/format';
import './consumer.css';

/**
 * Consumer demo: plays the part of an application that reads PalletDock's
 * public /v1 API. The read key stays on the server (/consumer/state); this page
 * only sees derived data. Read-only: it triggers nothing on chain.
 */

const POLL_MS = 5_000;
const MAX_BACKOFF_MS = 60_000;

const LEVEL_LABEL: Record<ConsumerView['level'], string> = {
  fresh: 'Up to date',
  lagging: 'Behind',
  stale: 'Possibly out of date',
  error: 'Indexer error',
  unknown: 'Coverage unknown',
  unavailable: 'API unavailable',
};

export default function ConsumerPage() {
  const [state, apply] = useReducer(reconcile, EMPTY_STATE);
  const [config, setConfig] = useState<PublicConsumerConfig | null>(null);
  const [blocked, setBlocked] = useState<{ code: string; message: string } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [nextAt, setNextAt] = useState<number | null>(null);
  const failures = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const poll = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    let outcome: ReadOutcome | null = null;
    let stop = false;
    try {
      const r = await fetch('/consumer/state', { cache: 'no-store' });
      const body = (await r.json()) as StateResponse;
      if (body.ok) {
        outcome = { ok: true, snapshot: body.snapshot };
        setConfig(body.config);
        setBlocked(null);
      } else if (['UNAUTHORIZED', 'NOT_CONFIGURED', 'BAD_CONFIG'].includes(body.error.code)) {
        setBlocked(body.error);
        stop = body.error.code === 'UNAUTHORIZED';
      } else {
        if (body.config) setConfig(body.config);
        outcome = { ok: false, error: body.error, at: body.at };
      }
    } catch (e) {
      outcome = { ok: false, error: { code: 'CONSUMER_SERVER_UNREACHABLE', message: (e as Error).message }, at: new Date().toISOString() };
    }
    if (outcome) {
      apply(outcome);
      failures.current = outcome.ok ? 0 : failures.current + 1;
    }
    if (stop) return setNextAt(null);
    // Bounded backoff while reads fail; steady interval while they succeed.
    const delay = failures.current ? Math.min(MAX_BACKOFF_MS, POLL_MS * 2 ** (failures.current - 1)) : POLL_MS;
    setNextAt(Date.now() + delay);
    timer.current = setTimeout(() => void poll(), delay);
  }, []);

  useEffect(() => {
    void poll();
    const tick = setInterval(() => setNow(Date.now()), 1_000);
    return () => {
      clearInterval(tick);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [poll]);

  const view = deriveView(state, now, { contract: config?.contract ?? undefined });
  const genesisMatches = view.network ? view.network.genesisHash.toLowerCase() === NETWORK.genesisHash : null;

  return (
    <div className="cs-page">
      <header className="cs-header">
        <div className="cs-header-inner">
          <Link href="/" aria-label="PalletDock home" className="cs-brand">
            <Image src="/palletdock-logo.png" alt="PalletDock" width={2172} height={724} style={{ width: 'auto', height: 34, filter: 'invert(1)', margin: '-6px' }} />
          </Link>
          <span className="cs-tag mono">Consumer demo</span>
          <Link href="/app" className="cs-link">
            Workspace
          </Link>
        </div>
      </header>

      <main className="cs-main">
        <section className="cs-intro">
          <h1>Storage reader</h1>
          <p className="muted">
            This page plays the part of your application. It reads <span className="mono">{config?.event ?? 'NumberChanged'}</span> events from PalletDock&apos;s public read API with a server-side read key
            {config ? (
              <>
                {' '}
                (<span className="mono">{config.keyPrefix}…</span>, project <span className="mono">{shortHash(config.projectId, 8, 4)}</span>)
              </>
            ) : null}
            , and shows what it can and cannot conclude. It never reads the database or the workspace endpoints, and it sends nothing on chain.
          </p>
        </section>

        {blocked ? (
          <section className="cs-card cs-blocked" data-testid="consumer-blocked">
            <strong>{blocked.code === 'UNAUTHORIZED' ? 'Sign in required' : 'Not configured'}</strong>
            <p className="muted">{blocked.message}</p>
            {blocked.code === 'UNAUTHORIZED' ? (
              <Link className="button" href="/login">
                Sign in
              </Link>
            ) : (
              <p className="muted mono cs-small">Create a read key (events:read, indexer:read, transactions:read) in the workspace, then put it in .data/consumer.json on the server.</p>
            )}
          </section>
        ) : (
          <>
            <section className={`cs-status is-${view.level}`} data-testid="consumer-status" data-level={view.level} aria-live="polite">
              <div className="cs-status-head">
                <span className="cs-level mono">{LEVEL_LABEL[view.level]}</span>
                <strong>{view.headline}</strong>
              </div>
              {view.reasons.length > 0 && (
                <ul className="cs-reasons">
                  {view.reasons.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              )}
              <p className="cs-small muted mono">
                {view.lastGoodAt ? `Last good read ${view.lastGoodAt}${view.ageMs !== null ? ` (${fmtAge(view.ageMs)} ago)` : ''}` : 'No successful read yet'}
                {nextAt ? ` · next read in ${Math.max(0, Math.ceil((nextAt - now) / 1000))} s` : ''}
              </p>
              <button type="button" className="button secondary cs-refresh" onClick={() => void poll()}>
                Refresh now
              </button>
            </section>

            <section className="cs-grid">
              <div className="cs-card cs-value">
                <span className="eyebrow">Latest observed value</span>
                <strong className="mono" data-testid="consumer-value">
                  {view.latest?.value ?? '—'}
                </strong>
                <span className="muted cs-small">
                  {view.latest ? (view.latest.previousValue !== null ? `was ${view.latest.previousValue} before this event` : 'from the latest event') : (view.emptyMessage ?? 'No event read yet.')}
                </span>
                {view.level !== 'fresh' && view.latest && <span className="cs-warn cs-small">Shown with the caveat above; it may not be the current on-chain value.</span>}
              </div>

              <div className="cs-card">
                <span className="eyebrow">Event behind it</span>
                {view.latest ? <EventFacts e={view.latest.event} /> : <p className="muted cs-small">{view.emptyMessage ?? 'Nothing read yet.'}</p>}
              </div>

              <div className="cs-card">
                <span className="eyebrow">Network</span>
                {view.network ? (
                  <dl className="cs-kv">
                    <Row k="Network" v={view.network.networkId} />
                    <Row k="EVM chain" v={view.network.evmChainId} />
                    <Row k="Genesis" v={shortHash(view.network.genesisHash, 12, 6)} />
                    <Row k="Fingerprint" v={shortHash(view.network.fingerprintId, 8, 4)} />
                    <Row k="Identity" v={genesisMatches ? 'Portaldot V3 Testnet genesis' : 'Not the Portaldot V3 Testnet genesis (fixture or another network)'} />
                  </dl>
                ) : (
                  <p className="muted cs-small">Not reported.</p>
                )}
              </div>

              <div className="cs-card">
                <span className="eyebrow">Coverage and freshness</span>
                {view.coverage ? (
                  <dl className="cs-kv">
                    <Row k="Indexed blocks" v={`${view.coverage.fromBlock} – ${view.coverage.toBlock}`} />
                    <Row k="Checkpoint hash" v={shortHash(view.coverage.blockHash, 12, 6)} />
                    <Row k="Checkpoint at" v={`${view.coverage.committedAt} (${fmtAge(view.coverage.ageMs)} ago)`} />
                    <Row k="Rollbacks" v={state.epochs !== null ? `reorg epoch ${state.epochs} (rollbacks the indexer has applied)` : 'unknown'} />
                    <Row k="Finality" v={view.finality} />
                  </dl>
                ) : (
                  <dl className="cs-kv">
                    <Row k="Coverage" v="Not reported" />
                    <Row k="Finality" v={view.finality} />
                  </dl>
                )}
                {view.transactionCondition && <p className="cs-small cs-cond">{view.transactionCondition}</p>}
              </div>
            </section>

            <section className="cs-card">
              <div className="cs-row-head">
                <span className="eyebrow">Events in this snapshot</span>
                <span className="muted cs-small mono">{state.events.length} unique by identity</span>
              </div>
              {state.events.length ? (
                <ol className="cs-events" data-testid="consumer-events">
                  {[...state.events].reverse().map((e) => (
                    <li key={`${e.blockHash}|${e.transactionHash}|${e.logIndex}`} className="mono" data-testid="consumer-event-row">
                      <span>#{e.blockNumber}</span>
                      <span>{e.event ? `${e.event.args.previousValue ?? '?'} → ${e.event.args.newValue ?? '?'}` : e.decodeStatus}</span>
                      <span className="dim">
                        {shortHash(e.transactionHash, 10, 6)} · log {e.logIndex}
                        {trackingTag(state.transactions?.[e.transactionHash.toLowerCase()]) ? ` · ${trackingTag(state.transactions?.[e.transactionHash.toLowerCase()])}` : ''}
                      </span>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="muted cs-small">{view.emptyMessage ?? 'Nothing read yet.'}</p>
              )}
            </section>

            {state.notes.length > 0 && (
              <section className="cs-card">
                <span className="eyebrow">Reconciliation log</span>
                <ul className="cs-notes" data-testid="consumer-notes">
                  {state.notes.map((n) => (
                    <li key={n.at + n.text}>
                      <span className="mono dim">{n.at.slice(11, 19)}</span> {n.text}
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}

        <section className="cs-trust muted cs-small">
          Trust model: these values are what PalletDock&apos;s indexer recorded from the RPC node, with the coverage and checkpoint it reports. They are not a cryptographic proof, finality is not verified, and history the node has already pruned
          cannot always be re-read.
        </section>
      </main>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <dt>{k}</dt>
      <dd className="mono">{v}</dd>
    </div>
  );
}

function EventFacts({ e }: { e: ApiEvent }) {
  return (
    <dl className="cs-kv">
      <Row k="Event" v={e.event ? `${e.event.name}(${Object.entries(e.event.args).map(([k, v]) => `${k}=${String(v)}`).join(', ')})` : e.decodeStatus} />
      <Row k="Block" v={e.blockNumber} />
      <Row k="Block hash" v={e.blockHash} />
      <Row k="Transaction" v={e.transactionHash} />
      <Row k="Log index" v={String(e.logIndex)} />
      <Row k="Contract" v={e.contractAddress} />
      <Row k="Indexed at" v={e.indexedAt} />
    </dl>
  );
}
