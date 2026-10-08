'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import { DOCS } from '@/lib/docs';

export default function DocsPage() {
  const params = useParams<{ slug?: string[] }>();
  const slug = (params.slug ?? []).join('/');
  const [q, setQ] = useState('');
  const doc = DOCS.find((d) => d.slug === slug);
  const idx = doc ? DOCS.indexOf(doc) : -1;
  const next = idx >= 0 ? DOCS[idx + 1] : undefined;
  const nav = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return DOCS;
    return DOCS.filter((d) => (d.title + ' ' + JSON.stringify(d.blocks)).toLowerCase().includes(s));
  }, [q]);

  return (
    <div style={{ minHeight: '100vh' }}>
      <header style={{ position: 'sticky', top: 0, zIndex: 20, borderBottom: '1px solid var(--border)', background: 'rgba(14,15,17,.92)', backdropFilter: 'blur(8px)' }}>
        <div className="container" style={{ height: 56, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
          <Link href="/" aria-label="PalletDock home">
            <Image src="/palletdock-logo.png" alt="PalletDock" width={2172} height={724} style={{ width: 'auto', height: 42, filter: 'invert(1)', margin: '-8px' }} />
          </Link>
          <Link href="/app" className="button" style={{ minHeight: 34, paddingInline: 14 }}>
            Open workspace
          </Link>
        </div>
      </header>
      <div className="container" style={{ paddingBlock: 32, display: 'flex', flexWrap: 'wrap', gap: 28, alignItems: 'flex-start' }}>
        <nav aria-label="Documentation" style={{ flex: '1 1 220px', maxWidth: 280, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <input className="input" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search the docs" placeholder="Search the docs" style={{ marginBottom: 10 }} />
          {nav.map((d) => (
            <Link
              key={d.slug}
              href={`/docs${d.slug ? `/${d.slug}` : ''}`}
              aria-current={d.slug === slug ? 'page' : undefined}
              style={{ display: 'flex', flexDirection: 'column', gap: 1, padding: '7px 10px', borderRadius: 7, textDecoration: 'none', background: d.slug === slug ? 'var(--surface-raised)' : 'transparent' }}
            >
              <span className="mono dim" style={{ fontSize: 10, letterSpacing: '.06em', textTransform: 'uppercase' }}>
                {d.group}
              </span>
              <span style={{ fontSize: 13.5, color: d.slug === slug ? 'var(--foreground)' : 'var(--muted)' }}>{d.title}</span>
            </Link>
          ))}
          {!nav.length && <p className="dim" style={{ margin: 0, padding: '6px 10px', fontSize: 12.5, lineHeight: 1.5 }}>No documentation matches this search. Try a network, module, or error name.</p>}
        </nav>
        <article style={{ flex: '999 1 420px', minWidth: 0, maxWidth: 760, display: 'flex', flexDirection: 'column', gap: 14 }}>
          {!doc ? (
            <>
              <h1 style={{ margin: 0, fontSize: 28 }}>Page not found</h1>
              <p className="muted">
                This documentation page does not exist. <Link href="/docs">Back to the docs home</Link>
              </p>
            </>
          ) : (
            <>
              <div className="eyebrow">{doc.group}</div>
              <h1 style={{ margin: 0, fontSize: 28, fontWeight: 600, letterSpacing: '-.015em', lineHeight: 1.15 }}>{doc.title}</h1>
              {doc.meta && (
                <div className="card" style={{ padding: '10px 14px', background: '#15171b', display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {doc.meta.map(([k, v]) => (
                    <div key={k} style={{ fontSize: 12.5, color: '#c4c8ce' }}>
                      <span className="dim">{k}: </span>
                      {v}
                    </div>
                  ))}
                </div>
              )}
              {doc.blocks.map((b, i) => {
                switch (b[0]) {
                  case 'h':
                    return <h2 key={i} style={{ margin: '12px 0 0', fontSize: 17, fontWeight: 600 }}>{b[1]}</h2>;
                  case 'p':
                    return <p key={i} style={{ margin: 0, fontSize: 14, lineHeight: 1.65, color: '#c4c8ce', textWrap: 'pretty' }}>{b[1]}</p>;
                  case 'note':
                    return <div key={i} className="notice" style={{ fontSize: 13 }}>{b[1]}</div>;
                  case 'code':
                    return <pre key={i} className="pre" style={{ whiteSpace: 'pre', wordBreak: 'normal' }}>{b[1]}</pre>;
                  case 'list':
                    return (
                      <ol key={i} style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 8 }}>
                        {b[1].map((t, j) => (
                          <li key={j} style={{ display: 'grid', gridTemplateColumns: '24px minmax(0,1fr)', gap: 8, fontSize: 14, lineHeight: 1.6, color: '#c4c8ce' }}>
                            <span className="mono dim" style={{ fontSize: 12, lineHeight: 1.9 }}>{String(j + 1).padStart(2, '0')}</span>
                            <span>{t}</span>
                          </li>
                        ))}
                      </ol>
                    );
                  case 'table':
                    return (
                      <div key={i} className="card" style={{ overflow: 'hidden' }}>
                        {b[1].map(([k, v], j) => (
                          <div key={j} style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1.3fr)', gap: 14, padding: '9px 14px', borderTop: j ? '1px solid #1f2125' : 0, fontSize: 13 }}>
                            <span className="dim">{k}</span>
                            <span className="mono" style={{ fontSize: 12.5, overflowWrap: 'anywhere' }}>{v}</span>
                          </div>
                        ))}
                      </div>
                    );
                  case 'links':
                    return (
                      <div key={i} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(220px,100%),1fr))', gap: 10 }}>
                        {b[1].map(([s, label, desc]) => (
                          <Link key={s} href={`/docs/${s}`} className="card" style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 4, textDecoration: 'none' }}>
                            <span style={{ fontSize: 14, fontWeight: 600 }}>{label}</span>
                            <span className="dim" style={{ fontSize: 12.5, lineHeight: 1.5 }}>{desc}</span>
                          </Link>
                        ))}
                      </div>
                    );
                }
              })}
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 14, paddingTop: 14, borderTop: '1px solid #222429' }}>
                {next && (
                  <Link href={`/docs/${next.slug}`} className="button secondary">
                    Next: {next.title}
                  </Link>
                )}
                <Link href="/app" className="button">
                  Open workspace
                </Link>
              </div>
            </>
          )}
        </article>
      </div>
    </div>
  );
}
