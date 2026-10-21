'use client';

import { Activity, Braces, Check, ChevronDown, Gauge, KeyRound, PanelsTopLeft, Pause, Play, Settings, TerminalSquare } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { prefersReducedMotion, useInView } from '@/components/motion';
import { NETWORK } from '@/lib/network';
import { Lifecycle, lifecycleStates } from './lifecycle';

/**
 * Interactive, illustrative PalletDock workspace. Every value here is example
 * data: addresses and hashes are masked, nothing comes from a live network.
 */

const MASK = '0x••••…••••';
const ADVANCE_MS = 5600;

const STAGES = [
  { n: '01', title: 'Create or import a contract', body: 'Validate a compiled artifact, or import a deployed address after a runtime code check and ABI validation.', nav: 'Contracts', row: 0 },
  { n: '02', title: 'Submit from your wallet', body: 'Review the function, arguments, and fee estimate, then sign and broadcast in your own browser wallet.', nav: 'Transactions', row: 1 },
  { n: '03', title: 'Follow execution and indexing', body: 'Inclusion, execution, finality, and indexing are recorded as separate facts. Unknown stays unknown.', nav: 'Transactions', row: 1 },
  { n: '04', title: 'Query indexed events', body: 'Read decoded events over the project API with a scoped, revocable read key.', nav: 'API', row: 2 },
] as const;

const NAV = [
  ['Overview', PanelsTopLeft],
  ['Contracts', Braces],
  ['Transactions', Activity],
  ['Indexer', Gauge],
  ['API', KeyRound],
  ['Monitoring', TerminalSquare],
  ['Settings', Settings],
] as const;

type Tone = 'success' | 'info' | 'idle';

function activity(stage: number): Array<{ kind: string; target: string; meta: string; status: string; tone: Tone }> {
  return [
    { kind: 'Import', target: 'PalletDockStorage', meta: 'ABI v1 · runtime code found', status: 'Imported', tone: 'success' },
    {
      kind: 'Call',
      target: 'store(42)',
      meta: 'PalletDockStorage · your wallet',
      status: ['Not prepared', 'Awaiting wallet', 'Waiting for checkpoint', 'Indexed'][stage],
      tone: stage === 0 ? 'idle' : stage === 3 ? 'success' : 'info',
    },
    { kind: 'Event', target: 'NumberChanged', meta: 'PalletDockStorage · log 0', status: stage === 3 ? 'Queryable' : 'Not indexed yet', tone: stage === 3 ? 'success' : 'idle' },
    { kind: 'Deploy', target: 'PalletDockToken', meta: 'ERC-20 sample', status: 'No event expected', tone: 'idle' },
  ];
}

export function ProductShowcase() {
  const [stage, setStage] = useState(0);
  const [autoplay, setAutoplay] = useState(false);
  const [reduced, setReduced] = useState(true);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [sectionRef, inView] = useInView<HTMLElement>();
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    const r = prefersReducedMotion();
    setReduced(r);
    setAutoplay(!r);
    const onVis = () => setHidden(document.hidden);
    onVis();
    document.addEventListener('visibilitychange', onVis);
    // Follow the setting while the page is open: turning reduced motion on stops the
    // tour at once and removes its control; turning it off brings the control back paused.
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const onMotion = (e: MediaQueryListEvent) => {
      setReduced(e.matches);
      if (e.matches) setAutoplay(false);
    };
    mq?.addEventListener('change', onMotion);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      mq?.removeEventListener('change', onMotion);
    };
  }, []);

  const running = autoplay && !reduced && inView && !hovered && !focused && !hidden;
  const select = (i: number) => {
    setStage(i);
    setAutoplay(false);
  };
  const onKey = (e: React.KeyboardEvent, i: number) => {
    const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const next = (i + d + STAGES.length) % STAGES.length;
    select(next);
    buttons.current[next]?.focus();
  };
  const s = STAGES[stage];

  return (
    <section
      ref={sectionRef}
      id="workflow"
      aria-labelledby="showcase-title"
      className="ld-showcase"
      onPointerEnter={(e) => e.pointerType === 'mouse' && setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={(e) => {
        // Keyboard focus pauses the tour; the play/pause control itself does not.
        const t = e.target as HTMLElement;
        setFocused(t.matches(':focus-visible') && !t.classList.contains('ld-autoplay'));
      }}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setFocused(false)}
    >
      <div className="container ld-showcase-inner">
        <div className="ld-showcase-head">
          <div>
            <div className="eyebrow">Workflow</div>
            <h2 id="showcase-title" className="section-title">One contract, followed from deployment to an API query.</h2>
          </div>
          {!reduced && (
            <button type="button" className="ld-autoplay" onClick={() => setAutoplay((a) => !a)} aria-label={autoplay ? 'Pause the preview tour' : 'Play the preview tour'}>
              {autoplay ? <Pause size={14} aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}
              <span className="mono">{autoplay ? 'Pause tour' : 'Play tour'}</span>
            </button>
          )}
        </div>

        <div className="ld-stages" role="group" aria-label="Preview stages">
          {STAGES.map((x, i) => (
            <button
              key={x.n}
              ref={(el) => {
                buttons.current[i] = el;
              }}
              type="button"
              className="ld-stage"
              aria-pressed={stage === i}
              aria-controls="showcase-preview"
              onClick={() => select(i)}
              onKeyDown={(e) => onKey(e, i)}
            >
              <span className="mono ld-stage-n">{x.n}</span>
              <span className="ld-stage-t">{x.title}</span>
              {stage === i && autoplay && !reduced && (
                <span
                  key={`p${stage}`}
                  className="ld-stage-progress"
                  aria-hidden="true"
                  style={{ animationDuration: `${ADVANCE_MS}ms`, animationPlayState: running ? 'running' : 'paused' }}
                  onAnimationEnd={() => setStage((v) => (v + 1) % STAGES.length)}
                />
              )}
            </button>
          ))}
        </div>
        <p className="ld-stage-body muted">{s.body}</p>

        <div id="showcase-preview" className="ld-preview" data-stage={stage}>
          <span className="ld-illustrative mono">Interactive preview · illustrative data, not live network activity</span>

          {/* Wide screens: the full workspace frame (icon rail sidebar below 1280px). Hidden below 1080px. */}
          <div className="ld-frame" aria-hidden="true">
            <div className="ld-frame-bar">
              <span className="ld-crumb">
                <span className="dim">storage-demo</span>
                <span className="ld-slash">/</span>
                <strong>{s.nav}</strong>
              </span>
              <span className="ld-chip mono">
                {NETWORK.label} <span className="dim">{NETWORK.chainIdHex}</span>
              </span>
            </div>
            <div className="ld-frame-body">
              <aside className="ld-side">
                <div className="ld-project">
                  <span className="ld-project-mark mono">SD</span>
                  <span className="ld-project-name">
                    storage-demo
                    <small className="mono dim">{NETWORK.label}</small>
                  </span>
                  <ChevronDown size={14} className="dim ld-project-caret" />
                </div>
                <nav className="ld-side-nav">
                  {NAV.map(([label, Icon]) => (
                    <span key={label} className={`ld-side-link ${label === s.nav ? 'is-active' : ''}`}>
                      <Icon size={15} />
                      <span className="ld-side-label">{label}</span>
                    </span>
                  ))}
                </nav>
                <div className="ld-side-foot mono dim">
                  {NETWORK.label}
                  <br />
                  EVM chain {NETWORK.chainId}
                </div>
              </aside>

              <div className="ld-main">
                <div className="ld-main-head">
                  <div>
                    <span className="eyebrow">Project overview</span>
                    <h3>storage-demo</h3>
                  </div>
                  <div className="ld-metrics">
                    {[
                      ['Contracts', '2'],
                      ['Indexer sources', '1'],
                      ['Read keys', '1'],
                      ['Finality', 'Not confirmed'],
                    ].map(([k, v]) => (
                      <div key={k} className="ld-metric">
                        <span className="mono dim">{k}</span>
                        <strong>{v}</strong>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="ld-table">
                  <div className="ld-table-head mono">
                    <span>Kind</span>
                    <span>Target</span>
                    <span>Status</span>
                  </div>
                  {activity(stage).map((r, i) => (
                    <div key={r.kind + r.target} className={`ld-row ${i === s.row ? 'is-focus' : ''}`}>
                      <span className="mono dim">{r.kind}</span>
                      <span className="ld-row-target">
                        <strong className="mono">{r.target}</strong>
                        <small className="dim">{r.meta}</small>
                      </span>
                      <span className={`ld-status tone-${r.tone}`}>{r.status}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="ld-float">
                <DetailPanel stage={stage} />
              </div>
            </div>
          </div>

          {/* Below 1080px: one focused, readable panel instead of a squeezed desktop frame. */}
          <div className="ld-mobile">
            <div className="ld-mobile-context mono">
              <span className="dim">storage-demo /</span> {s.nav}
              <span className="ld-chip">{NETWORK.label}</span>
            </div>
            <DetailPanel stage={stage} />
          </div>
        </div>
      </div>
    </section>
  );
}

function DetailPanel({ stage }: { stage: number }) {
  return (
    <div key={stage} className="ld-panel">
      {stage === 0 && (
        <>
          <PanelHead title="Import contract" tag="Contracts" />
          <KV rows={[['Address', MASK], ['Runtime code', 'Found at address'], ['ABI', 'PalletDockStorage.json · v1'], ['Events', 'NumberChanged']]} />
          <ul className="ld-checks">
            {['Address format', 'Runtime code present', 'ABI structure valid'].map((c) => (
              <li key={c}>
                <Check size={13} aria-hidden="true" /> {c}
              </li>
            ))}
          </ul>
          <p className="ld-note">A code check does not prove ownership or that the ABI matches the bytecode.</p>
          <span className="ld-fake-button">Import contract</span>
        </>
      )}
      {stage === 1 && (
        <>
          <PanelHead title="Review write" tag="Wallet request" />
          <KV rows={[['Function', 'store(uint256)'], ['newValue', '42'], ['From', `Your wallet · ${MASK}`], ['Network', `${NETWORK.label} · ${NETWORK.chainId}`], ['Fee', 'Estimated before signing']]} />
          <p className="ld-note">PalletDock prepares the request. Your wallet signs and broadcasts it; no key reaches the server.</p>
          <span className="ld-fake-button">Open wallet to sign</span>
        </>
      )}
      {stage === 2 && (
        <>
          <PanelHead title="Transaction" tag={MASK} />
          <Lifecycle states={lifecycleStates(3)} compact />
          <p className="ld-note">Finality is not claimed until a verified adapter links EVM blocks to native finality.</p>
        </>
      )}
      {stage === 3 && (
        <>
          <PanelHead title="Read API" tag="events:read" />
          <pre className="ld-code">
            <span className="c-k">GET</span> /v1/projects/<span className="c-v">{'{projectId}'}</span>/events{'\n'}
            {'    '}?event=<span className="c-s">NumberChanged</span>
            {'\n'}
            <span className="c-d">Authorization: Bearer $PALLETDOCK_READ_KEY</span>
          </pre>
          <pre className="ld-code">
            {'{\n  "data": [{\n    "event": {\n      "name": '}
            <span className="c-s">&quot;NumberChanged&quot;</span>
            {',\n      "args": { "newValue": '}
            <span className="c-s">&quot;42&quot;</span>
            {' }\n    },\n    "decodeStatus": "decoded",\n    "finality": '}
            <span className="c-w">&quot;unknown&quot;</span>
            {'\n  }],\n  "nextCursor": null\n}'}
          </pre>
        </>
      )}
    </div>
  );
}

function PanelHead({ title, tag }: { title: string; tag: string }) {
  return (
    <div className="ld-panel-head">
      <strong>{title}</strong>
      <span className="ld-chip mono">{tag}</span>
    </div>
  );
}

function KV({ rows }: { rows: Array<[string, string]> }) {
  return (
    <dl className="ld-kv">
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt className="mono">{k}</dt>
          <dd className="mono">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
