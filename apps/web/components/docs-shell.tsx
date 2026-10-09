'use client';

import Image from 'next/image';
import Link from 'next/link';
import { Fragment, useEffect, useState } from 'react';

/** Header, status strip, and footer from the PalletDock Docs design export. */
export function DocsShell({ children, section = 'Docs' }: { children: React.ReactNode; section?: string }) {
  const w = useWidth();
  return (
    <div style={{ minHeight: '100vh', background: 'var(--background)', fontSize: 15 }}>
      <header style={{ position: 'sticky', top: 0, zIndex: 10, background: 'rgba(14,15,17,.92)', backdropFilter: 'blur(8px)', borderBottom: '1px solid #222429' }}>
        <div style={{ maxWidth: 1320, margin: '0 auto', padding: '0 24px', height: 60, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, minWidth: 0 }}>
            <Link href="/" aria-label="PalletDock home" style={{ display: 'flex', textDecoration: 'none' }}>
              <Image src="/palletdock-logo.png" alt="PalletDock" width={2172} height={724} style={{ height: 46, width: 'auto', display: 'block', margin: '-8px -8px', filter: 'invert(1)' }} />
            </Link>
            <span style={{ width: 1, height: 18, background: '#2c2f35' }} />
            <span style={{ fontSize: 13.5, fontWeight: 500, color: '#b5b9c0' }}>{section}</span>
          </div>
          <nav aria-label="Site" style={{ display: 'flex', alignItems: 'center', gap: 20, fontSize: 13.5 }}>
            {w >= 640 && (
              <>
                <Link href="/" style={{ textDecoration: 'none', color: '#b5b9c0' }}>
                  Overview
                </Link>
                <Link href="/docs" style={{ textDecoration: 'none', color: '#b5b9c0' }}>
                  Docs
                </Link>
                <Link href="/faq" style={{ textDecoration: 'none', color: '#b5b9c0' }}>
                  FAQ
                </Link>
              </>
            )}
            <Link href="/app" style={{ display: 'inline-flex', alignItems: 'center', height: 32, padding: '0 14px', borderRadius: 7, background: '#ecedee', color: '#0e0f11', fontWeight: 600, fontSize: 13, textDecoration: 'none', whiteSpace: 'nowrap' }}>
              Open workspace
            </Link>
          </nav>
        </div>
      </header>
      <div style={{ borderBottom: '1px solid #222429', background: '#15161a' }}>
        <div style={{ maxWidth: 1320, margin: '0 auto', padding: '8px 24px', display: 'flex', alignItems: 'center', gap: 10, fontSize: 12.5, color: '#b5b9c0' }}>
          <span style={{ flex: 'none', font: "600 10px 'JetBrains Mono',monospace", letterSpacing: '.08em', padding: '2px 6px', borderRadius: 4, background: '#2a2d33', color: '#ecedee' }}>TESTNET MVP</span>
          <span>Network details describe Portaldot V3. Workspace and API pages describe the implemented PalletDock MVP; live testnet acceptance is pending.</span>
        </div>
      </div>
      {children}
      <footer style={{ borderTop: '1px solid #222429' }}>
        <div style={{ maxWidth: 1320, margin: '0 auto', padding: 24, display: 'flex', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', fontSize: 12.5, color: '#8a8f98' }}>
          <span>
            PalletDock · independent tooling. Its API is not an official Portaldot RPC specification. <Link href="/roadmap">Roadmap</Link> · <Link href="/support">Support</Link>
          </span>
          <span className="mono">Portaldot V3 Testnet · EVM chain 420420777</span>
        </div>
      </footer>
    </div>
  );
}

export function useWidth(): number {
  const [w, setW] = useState(1300);
  useEffect(() => {
    const on = () => setW(window.innerWidth);
    on();
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return w;
}

/** Inline renderer for `code`, **bold**, and [links](href). */
export function Inline({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const t = m[0];
    if (t.startsWith('`')) {
      parts.push(
        <code key={i++} style={{ padding: '1px 5px', borderRadius: 4, background: '#1b1d21', border: '1px solid #25282d', font: "400 .86em 'JetBrains Mono',monospace", color: '#ecedee', overflowWrap: 'anywhere' }}>
          {t.slice(1, -1)}
        </code>,
      );
    } else if (t.startsWith('**')) {
      parts.push(
        <strong key={i++} style={{ color: '#ecedee', fontWeight: 600 }}>
          {t.slice(2, -2)}
        </strong>,
      );
    } else {
      const mm = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(t)!;
      const href = mm[2];
      parts.push(
        href.startsWith('/') ? (
          <Link key={i++} href={href}>
            {mm[1]}
          </Link>
        ) : (
          <a key={i++} href={href} target="_blank" rel="noreferrer noopener">
            {mm[1]}
          </a>
        ),
      );
    }
    last = m.index + t.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts.map((p, k) => <Fragment key={k}>{p}</Fragment>)}</>;
}
