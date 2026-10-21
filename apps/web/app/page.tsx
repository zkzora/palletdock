'use client';

import Image from 'next/image';
import Link from 'next/link';
import './landing.css';
import { useHeroParallax, useScrolledHeader, useSpotlight } from '@/components/motion';
import { ProductShowcase } from '@/components/landing/product-showcase';
import { OutlineFigures } from '@/components/landing/outline-figures';
import { FeatureStories } from '@/components/landing/feature-story';
import { ClosingCta } from '@/components/landing/closing-cta';
import { SiteFooter } from '@/components/site-footer';

const REPO_URL = process.env.NEXT_PUBLIC_PALLETDOCK_REPO_URL ?? 'https://github.com/zkzora/palletdock';

const implemented = [
  'Single-owner sign-in with hashed password, CSRF-protected sessions, rate-limited login',
  'Projects: create, search, switch, edit, export (no secrets), archive and controlled restore',
  'EVM wallet signing in the browser; no server keys, no seed phrase input',
  'Runtime account mapping through reviveApi.accountId, with block and runtime provenance',
  'Network identity fingerprint pinned from genesis hash and EVM chain ID',
  'Monitoring: timestamped RPC probes, worker heartbeat, indexer lag, and API error counts',
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
          <div className="container hero-content" style={{ paddingBlock: '88px 72px', display: 'flex', flexDirection: 'column', gap: 28 }}>
            <div className="eyebrow enter" style={i(0)}>
              Developer workspace for Portaldot
            </div>
            <h1 className="enter" style={{ ...i(1), margin: 0, maxWidth: 900, fontSize: 'clamp(38px,6vw,64px)', fontWeight: 600, letterSpacing: '-.03em', lineHeight: 1.04, textWrap: 'balance' }}>
              Deploy, index and monitor Portaldot contracts in one workspace.
            </h1>
            <p className="muted enter" style={{ ...i(2), margin: 0, maxWidth: 680, fontSize: 17, lineHeight: 1.6 }}>
              Organize contracts by project, call them from Contract Studio, follow each transaction to its indexed event, query the results over an API, and watch RPC probes, on the Portaldot EVM layer.
            </p>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
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
            <div className="notice" style={{ maxWidth: 780 }}>
              <span>
                <strong>Self-hosted, independent tooling.</strong> PalletDock is not an official Portaldot product and has not been independently audited yet.
              </span>
            </div>
          </div>
        </section>

        <ProductShowcase />
        <OutlineFigures />
        <FeatureStories />

        <section id="scope" className="ld-scope" aria-labelledby="scope-title">
          <div className="container">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div className="eyebrow">Scope</div>
              <h2 id="scope-title" className="section-title">
                What is built, and what is not.
              </h2>
            </div>
            <div className="ld-ledger">
              <div className="is-built">
                <h3>Implemented</h3>
                <ul>
                  {implemented.map((x) => (
                    <li key={x}>{x}</li>
                  ))}
                </ul>
              </div>
              <div className="is-planned">
                <h3>Planned, not built</h3>
                <ul>
                  {planned.map((x) => (
                    <li key={x}>{x}</li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </section>

        <ClosingCta />
      </main>
      <SiteFooter />
    </div>
  );
}
