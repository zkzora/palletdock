'use client';

import Image from 'next/image';
import Link from 'next/link';
import { Reveal, useHeroParallax, useScrolledHeader, useSpotlight, useTilt } from '@/components/motion';

const REPO_URL = process.env.NEXT_PUBLIC_PALLETDOCK_REPO_URL ?? 'https://github.com/zkzora/palletdock';

const workflow = [
  ['01', 'Create a project', 'Keep contracts, keys, indexer sources, and logs inside one network-scoped workspace.'],
  ['02', 'Deploy or import', 'Deploy a validated artifact from your browser wallet, or import a deployed address after a runtime code check.'],
  ['03', 'Read and write', 'ABI-driven forms. Every write is reviewed with fee and deposit estimates, then approved in your wallet.'],
  ['04', 'Track the outcome', 'Submission, inclusion, execution, finality, and indexing are recorded as separate facts. Unknown stays unknown.'],
  ['05', 'Index the event', 'Bounded eth_getLogs ranges, atomic checkpoints, reorg rollback, and raw-log retention by a separate worker.'],
  ['06', 'Query the API', 'Project-scoped read keys and stable cursors, with coverage, freshness, and explicit unknown finality in every response.'],
];

const capabilities: Array<[string, string]> = [
  ['Contract Studio', 'Artifact validation, bundled Storage / ERC-20 / ERC-721 samples, import with code checks, ABI versions, reads, wallet-reviewed writes, custom error decoding.'],
  ['Indexer', 'Leased, fenced worker with adaptive ranges, backoff, header ancestry checks, reorg rollback, and a visible recovery state.'],
  ['Read API', 'GET contracts, transactions, events, and indexer coverage with scoped, expiring, revocable keys and a live playground.'],
  ['Monitoring', 'Timestamped RPC probes, worker heartbeat, indexer lag, and API error counts from recorded requests.'],
];

const implemented = [
  'Single-owner sign-in with hashed password, CSRF-protected sessions, rate-limited login',
  'Projects: create, search, switch, edit, export (no secrets), archive and controlled restore',
  'EVM wallet signing in the browser; no server keys, no seed phrase input',
  'Runtime account mapping through reviveApi.accountId, with block and runtime provenance',
  'Network identity fingerprint pinned from genesis hash and EVM chain ID',
];
const planned = [
  'Native (SS58) signing and native event indexing',
  'Native Assets / Uniques / Nfts management',
  'A verified finality adapter (finality is shown as unknown today)',
  'Source verification, execution tracing, team roles, billing',
];

export default function LandingPage() {
  const header = useScrolledHeader<HTMLElement>();
  const hero = useHeroParallax<HTMLElement>();
  const tilt = useTilt<HTMLDivElement>();
  const spotlight = useSpotlight<HTMLElement>();
  const i = (n: number) => ({ '--i': n }) as React.CSSProperties;
  return (
    <div style={{ minHeight: '100vh' }}>
      <header ref={header} className="scrolled-header" style={{ position: 'sticky', top: 0, zIndex: 20, borderBottom: '1px solid var(--border)', background: 'rgba(14,15,17,.9)', backdropFilter: 'blur(8px)' }}>
        <div className="container" style={{ height: 60, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
          <Link href="/" aria-label="PalletDock home">
            <Image src="/palletdock-logo.png" alt="PalletDock" width={2172} height={724} priority style={{ width: 'auto', height: 46, filter: 'invert(1)', margin: '-8px' }} />
          </Link>
          <nav className="landing-nav" aria-label="Page" style={{ display: 'flex', alignItems: 'center', gap: 22, fontSize: 13, flexWrap: 'wrap' }}>
            <a href="#workflow" className="muted landing-link nav-secondary" style={{ textDecoration: 'none' }}>
              Workflow
            </a>
            <a href="#scope" className="muted landing-link nav-secondary" style={{ textDecoration: 'none' }}>
              Scope
            </a>
            <Link href="/docs" className="muted nav-secondary" style={{ textDecoration: 'none' }}>
              Docs
            </Link>
            <Link href="/faq" className="muted nav-secondary" style={{ textDecoration: 'none' }}>
              FAQ
            </Link>
            <Link href="/login" className="button" style={{ minHeight: 34, paddingInline: 14 }}>
              Open workspace
            </Link>
          </nav>
        </div>
      </header>
      <main ref={spotlight}>
        <section ref={hero} className="hero-wrap">
        <div className="hero-art" aria-hidden="true">
          <Image src="/palletdock-hero-v1.png" alt="" fill priority sizes="100vw" />
        </div>
        <div className="hero-grid" aria-hidden="true" />
        <div className="hero-glow" aria-hidden="true" />
        <div className="container hero-content" style={{ paddingBlock: '88px 64px', display: 'flex', flexDirection: 'column', gap: 28 }}>
          <div className="eyebrow enter" style={i(0)}>Developer workspace for Portaldot</div>
          <h1 className="enter" style={{ ...i(1), margin: 0, maxWidth: 900, fontSize: 'clamp(38px,6vw,64px)', fontWeight: 600, letterSpacing: '-.03em', lineHeight: 1.04, textWrap: 'balance' }}>
            Deploy, index and monitor Portaldot contracts in one workspace.
          </h1>
          <p className="muted enter" style={{ ...i(2), margin: 0, maxWidth: 680, fontSize: 17, lineHeight: 1.6 }}>
            Organize contracts by project, call them from Contract Studio, follow each transaction to its indexed event, query the results over an API, and watch RPC probes, on the Portaldot V3 Testnet EVM layer.
          </p>
          <div className="enter" style={{ ...i(3), display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <Link href="/login" className="button arrow-link">
              Open the workspace <span className="arrow" aria-hidden="true">→</span>
            </Link>
            <Link href="/docs" className="button secondary">
              Read the docs
            </Link>
            <a href={REPO_URL} className="button ghost">
              Repository
            </a>
          </div>
          <div className="notice enter" style={{ ...i(4), maxWidth: 780 }}>
            <span>
              <strong>Testnet MVP, self-hosted.</strong> The workflows below are implemented and tested against a local fixture chain, and the network identity is verified live on Portaldot V3 Testnet. The wallet-signed deployment run on the live testnet is still pending. Not audited, not production-ready, no mainnet support. PalletDock is independent tooling, not an official Portaldot product.
            </span>
          </div>
        </div>
        </section>

        <section aria-label="Product preview" className="container enter" style={{ ...i(5), paddingBottom: 96 }}>
          <div ref={tilt} className="card tilt" style={{ overflow: 'hidden', background: '#111214' }}>
            <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', color: 'var(--dim)', fontSize: 12.5 }}>
              <span>
                Project workspace <span style={{ color: '#55595f', paddingInline: 8 }}>/</span>
                <strong style={{ color: 'var(--foreground)' }}>Overview</strong>
              </span>
              <span className="badge">
                Portaldot V3 Testnet <span className="mono dim">0x190f1ca9</span>
              </span>
            </div>
            <div style={{ padding: 22, display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(170px,1fr))' }}>
              {[
                ['01 · Contracts', 'Deploy or import', 'Artifacts and ABI versions'],
                ['02 · Transactions', 'Five statuses', 'Submission → indexing'],
                ['03 · Indexer', 'Checkpointed', 'Coverage and reorg handling'],
                ['04 · API', 'Scoped keys', 'Stable cursors'],
                ['05 · Monitoring', 'Recorded', 'Probes, lag, errors'],
              ].map(([k, v, n]) => (
                <div key={k} className="spot flat" style={{ minHeight: 118, padding: 16, border: '1px solid var(--border)', margin: '0 -1px -1px 0', display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <span className="mono dim" style={{ fontSize: 11 }}>
                    {k}
                  </span>
                  <strong style={{ fontSize: 16 }}>{v}</strong>
                  <span className="muted" style={{ marginTop: 'auto', display: 'flex', gap: 7, alignItems: 'center', fontSize: 12.5 }}>
                    {n}
                  </span>
                </div>
              ))}
            </div>
            <div className="dim" style={{ padding: '10px 18px', borderTop: '1px solid var(--border)', fontSize: 12 }}>
              Illustration of the workspace layout. No live data is shown on this page.
            </div>
          </div>
        </section>

        <section id="workflow" style={{ borderTop: '1px solid var(--border)' }}>
          <div className="container" style={{ paddingBlock: 88, display: 'flex', flexDirection: 'column', gap: 36 }}>
            <Reveal style={{ maxWidth: 650, display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div className="eyebrow reveal">Workflow</div>
              <h2 className="section-title reveal" style={i(1)}>One contract, followed from deployment to an application query.</h2>
              <p className="muted reveal" style={{ ...i(2), margin: 0, lineHeight: 1.6 }}>
                Each step uses the records the previous one created, and keeps the network, block, transaction, and freshness context the next one needs.
              </p>
            </Reveal>
            <Reveal as="ol" style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(250px,100%),1fr))', borderTop: '1px solid var(--border)', borderLeft: '1px solid var(--border)' }}>
              {workflow.map(([n, t, b], k) => (
                <li key={n} className="reveal spot flat" style={{ ...i(k), minHeight: 180, padding: 22, borderRight: '1px solid var(--border)', borderBottom: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <span className="mono dim" style={{ fontSize: 12 }}>
                    {n}
                  </span>
                  <strong style={{ fontSize: 16 }}>{t}</strong>
                  <span className="muted" style={{ fontSize: 13.5, lineHeight: 1.55 }}>
                    {b}
                  </span>
                </li>
              ))}
            </Reveal>
          </div>
        </section>

        <section id="capabilities" style={{ borderTop: '1px solid var(--border)' }}>
          <div className="container" style={{ paddingBlock: 88, display: 'flex', flexDirection: 'column', gap: 36 }}>
            <Reveal style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div className="eyebrow reveal">Capabilities</div>
              <h2 className="section-title reveal" style={i(1)}>Status you can trace back to a record.</h2>
            </Reveal>
            <Reveal style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(260px,100%),1fr))', gap: 20 }}>
              {capabilities.map(([t, b], k) => (
                <article className="card spot reveal" key={t} style={{ ...i(k), padding: 22, display: 'flex', flexDirection: 'column', gap: 16 }}>
                  <h3 style={{ margin: 0, fontSize: 17 }}>{t}</h3>
                  <p className="muted" style={{ margin: 0, lineHeight: 1.6 }}>
                    {b}
                  </p>
                  <span className="badge" style={{ alignSelf: 'flex-start', marginTop: 'auto' }}>
                    Implemented
                  </span>
                </article>
              ))}
            </Reveal>
          </div>
        </section>

        <section id="scope" style={{ borderTop: '1px solid var(--border)' }}>
          <div className="container" style={{ paddingBlock: 88, display: 'flex', flexDirection: 'column', gap: 32 }}>
            <Reveal style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div className="eyebrow reveal">Scope</div>
              <h2 className="section-title reveal" style={i(1)}>What is built, and what is not.</h2>
            </Reveal>
            <Reveal style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(320px,100%),1fr))', gap: 20 }}>
              <article className="card spot reveal" style={{ padding: 22 }}>
                <h3 style={{ margin: '0 0 12px', fontSize: 16 }}>Implemented</h3>
                <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 8, color: '#c4c8ce', lineHeight: 1.5, fontSize: 14 }}>
                  {implemented.map((x) => (
                    <li key={x}>{x}</li>
                  ))}
                </ul>
              </article>
              <article className="card spot reveal" style={{ ...i(1), padding: 22, borderStyle: 'dashed' }}>
                <h3 style={{ margin: '0 0 12px', fontSize: 16 }}>Planned, not built</h3>
                <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 8, color: '#c4c8ce', lineHeight: 1.5, fontSize: 14 }}>
                  {planned.map((x) => (
                    <li key={x}>{x}</li>
                  ))}
                </ul>
              </article>
            </Reveal>
            <div className="card spot" style={{ padding: 28, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
              <div>
                <h3 style={{ margin: 0, fontSize: 18 }}>Run it on your machine</h3>
                <p className="muted" style={{ margin: '6px 0 0' }}>Self-hosted: PostgreSQL, API, worker, and web app. Setup takes a few commands.</p>
              </div>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <Link href="/docs/getting-started" className="button arrow-link">
                  Setup guide <span className="arrow" aria-hidden="true">→</span>
                </Link>
                <Link href="/login" className="button secondary">
                  Open workspace
                </Link>
              </div>
            </div>
          </div>
        </section>
      </main>
      <footer style={{ borderTop: '1px solid var(--border)' }}>
        <div className="container" style={{ paddingBlock: 24, display: 'flex', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', color: 'var(--dim)', fontSize: 12.5 }}>
          <span>
            PalletDock · independent developer tooling · <Link href="/docs">Docs</Link> · <Link href="/faq">FAQ</Link> · <Link href="/roadmap">Roadmap</Link> · <Link href="/support">Support</Link> · <a href={REPO_URL}>Repository</a>
          </span>
          <span className="mono">Portaldot V3 Testnet · EVM chain 420420777 · Portaldot is not Polkadot</span>
        </div>
      </footer>
    </div>
  );
}
