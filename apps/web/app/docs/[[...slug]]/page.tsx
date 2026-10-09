'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { DOCS, DOC_GROUPS, type Block } from '@/lib/docs';
import { DocsShell, Inline, useWidth } from '@/components/docs-shell';

const P = { margin: 0, fontSize: 15, lineHeight: 1.7, color: '#c4c8ce', textWrap: 'pretty' } as const;

function langOf(b: Extract<Block, ['code', ...unknown[]]>): string {
  const l = b[2];
  if (l) return ({ bash: 'Shell', javascript: 'JavaScript', solidity: 'Solidity', json: 'JSON', text: 'Text' } as Record<string, string>)[l] ?? l;
  return b[1].includes('pragma solidity') ? 'Solidity' : 'JavaScript';
}

function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div style={{ borderRadius: 9, background: '#111214', border: '1px solid #25282d', overflow: 'hidden' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 8px 6px 14px', borderBottom: '1px solid #1f2125' }}>
        <span style={{ font: "500 11px 'JetBrains Mono',monospace", color: '#8a8f98' }}>{lang}</span>
        <button
          onClick={() => {
            navigator.clipboard?.writeText(code).catch(() => {});
            setCopied(true);
            setTimeout(() => setCopied(false), 1600);
          }}
          aria-label="Copy code"
          style={{ height: 26, padding: '0 10px', borderRadius: 6, border: '1px solid #2c2f35', background: '#1b1d21', fontSize: 12, cursor: 'pointer' }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre style={{ margin: 0, padding: '14px 16px', font: "400 12.5px/1.65 'JetBrains Mono',monospace", color: '#c4c8ce', overflow: 'auto' }}>{code}</pre>
    </div>
  );
}

function BlockView({ b, hid }: { b: Block; hid: string }) {
  switch (b[0]) {
    case 'h':
      return (
        <h2 id={hid} style={{ margin: '22px 0 0', paddingTop: 4, fontSize: 19, fontWeight: 600, letterSpacing: '-.01em', scrollMarginTop: 84 }}>
          {b[1]}
        </h2>
      );
    case 'p':
      return (
        <p style={P}>
          <Inline text={b[1]} />
        </p>
      );
    case 'note':
      return (
        <div style={{ padding: '12px 14px', borderRadius: 9, background: '#15171b', border: '1px solid #25282d', fontSize: 14, lineHeight: 1.6, color: '#c4c8ce' }}>
          <Inline text={b[1]} />
        </div>
      );
    case 'code':
      return <CodeBlock code={b[1]} lang={langOf(b)} />;
    case 'list':
      return (
        <ol style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 10 }}>
          {b[1].map((t, j) => (
            <li key={j} style={{ display: 'grid', gridTemplateColumns: '26px minmax(0,1fr)', gap: 8, fontSize: 15, lineHeight: 1.65, color: '#c4c8ce' }}>
              <span style={{ font: "500 12px/2 'JetBrains Mono',monospace", color: '#8a8f98' }}>{j + 1}</span>
              <span>
                <Inline text={t} />
              </span>
            </li>
          ))}
        </ol>
      );
    case 'bullets':
      return (
        <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {b[1].map((t, j) => (
            <li key={j} style={{ display: 'grid', gridTemplateColumns: '26px minmax(0,1fr)', gap: 8, fontSize: 15, lineHeight: 1.65, color: '#c4c8ce' }}>
              <span style={{ font: "500 12px/2 'JetBrains Mono',monospace", color: '#55595f' }}>—</span>
              <span>
                <Inline text={t} />
              </span>
            </li>
          ))}
        </ul>
      );
    case 'table':
      return (
        <div style={{ borderRadius: 9, border: '1px solid #25282d', overflow: 'hidden' }}>
          {b[1].map(([k, v]) => (
            <div key={k} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(220px,100%),1fr))', gap: '4px 16px', padding: '10px 14px', borderTop: '1px solid #1f2125', marginTop: -1, fontSize: 13.5 }}>
              <span style={{ color: '#9a9fa8' }}>{k}</span>
              <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 12.5, wordBreak: 'break-all' }}>{v}</span>
            </div>
          ))}
        </div>
      );
    case 'grid': {
      const [, head, rows] = b;
      const cols = `repeat(${head.length}, minmax(${head.length > 3 ? 110 : 140}px, 1fr))`;
      return (
        <div style={{ borderRadius: 9, border: '1px solid #25282d', overflowX: 'auto' }}>
          <div style={{ minWidth: head.length > 3 ? 560 : 0 }}>
            <div style={{ display: 'grid', gridTemplateColumns: cols, gap: 16, padding: '9px 14px', borderBottom: '1px solid #25282d', font: "500 10.5px 'JetBrains Mono',monospace", letterSpacing: '.08em', textTransform: 'uppercase', color: '#8a8f98' }}>
              {head.map((h) => (
                <span key={h}>{h}</span>
              ))}
            </div>
            {rows.map((r, j) => (
              <div key={j} style={{ display: 'grid', gridTemplateColumns: cols, gap: 16, padding: '10px 14px', borderTop: j ? '1px solid #1f2125' : 0, fontSize: 13.5, color: '#c4c8ce' }}>
                {r.map((c, k) => (
                  <span key={k} style={k === 0 || /^[\/A-Z0-9_]+$|[{}:]/.test(c) ? { fontFamily: "'JetBrains Mono',monospace", fontSize: 12.5, wordBreak: 'break-word', color: '#ecedee' } : { lineHeight: 1.5 }}>
                    {c}
                  </span>
                ))}
              </div>
            ))}
          </div>
        </div>
      );
    }
    case 'links':
      return (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(240px,100%),1fr))', gap: 12 }}>
          {b[1].map(([s, label, desc]) => (
            <Link key={s} href={`/docs/${s}`} className="docs-card" style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 16, borderRadius: 10, border: '1px solid #25282d', background: '#16181b', textDecoration: 'none' }}>
              <span style={{ fontSize: 14.5, fontWeight: 600, color: '#ecedee' }}>{label}</span>
              <span style={{ fontSize: 13, color: '#9a9fa8', lineHeight: 1.5 }}>{desc}</span>
            </Link>
          ))}
        </div>
      );
    case 'next':
      return null; // Previous/Next cards render at the end of every page.
  }
}

export default function DocsPage() {
  const params = useParams<{ slug?: string[] }>();
  const router = useRouter();
  const slug = (params.slug ?? []).join('/');
  const w = useWidth();
  const [q, setQ] = useState('');
  const doc = DOCS.find((d) => d.slug === slug);
  const di = doc ? DOCS.indexOf(doc) : -1;
  const prev = di > 0 ? DOCS[di - 1] : undefined;
  const next = di >= 0 ? DOCS[di + 1] : undefined;
  const href = (s: string) => `/docs${s ? `/${s}` : ''}`;

  const groups = useMemo(() => {
    const s = q.trim().toLowerCase();
    const match = DOCS.filter((d) => !s || (d.title + ' ' + (d.intro ?? '') + ' ' + JSON.stringify(d.blocks)).toLowerCase().includes(s));
    return DOC_GROUPS.map((name) => ({ name, items: match.filter((d) => d.group === name) })).filter((g) => g.items.length);
  }, [q]);

  let h = 0;
  const hids = doc ? doc.blocks.map((b) => (b[0] === 'h' ? `h-${h++}` : '')) : [];
  const toc = doc ? doc.blocks.map((b, i) => (b[0] === 'h' ? { text: b[1] as string, hid: hids[i] } : null)).filter(Boolean) as Array<{ text: string; hid: string }> : [];
  const sideOn = w >= 900;
  const tocOn = w >= 1180;

  return (
    <DocsShell>
      <div style={{ maxWidth: 1320, margin: '0 auto', padding: '0 24px', display: 'flex', gap: 40, alignItems: 'flex-start' }}>
        {sideOn && (
          <aside style={{ flex: '0 0 240px', position: 'sticky', top: 60, maxHeight: 'calc(100vh - 60px)', overflow: 'auto', padding: '28px 0 40px', display: 'flex', flexDirection: 'column', gap: 18 }}>
            <input value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search the docs" placeholder="Search the docs" style={{ flex: 'none', height: 34, padding: '0 12px', borderRadius: 7, border: '1px solid #34373d', background: '#0f1012', fontSize: 13, outline: 'none' }} />
            <nav aria-label="Documentation" style={{ flex: 'none', display: 'flex', flexDirection: 'column', gap: 18 }}>
              {groups.map((g) => (
                <div key={g.name} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span style={{ padding: '0 10px 6px', font: "500 10.5px 'JetBrains Mono',monospace", letterSpacing: '.08em', textTransform: 'uppercase', color: '#8a8f98' }}>{g.name}</span>
                  {g.items.map((d) => {
                    const on = d.slug === slug;
                    return (
                      <Link
                        key={d.slug}
                        href={href(d.slug)}
                        aria-current={on ? 'page' : undefined}
                        className="docs-nav-link"
                        style={{ display: 'block', width: '100%', padding: '7px 10px', borderRadius: 7, background: on ? '#1d1f23' : 'transparent', color: on ? '#ecedee' : '#b5b9c0', fontSize: 13.5, fontWeight: on ? 600 : 400, textDecoration: 'none' }}
                      >
                        {d.title}
                      </Link>
                    );
                  })}
                </div>
              ))}
            </nav>
            {!groups.length && <p style={{ margin: 0, padding: '0 10px', fontSize: 12.5, color: '#9a9fa8', lineHeight: 1.5 }}>No documentation matches this search. Try a network, module, or error name.</p>}
          </aside>
        )}

        <main style={{ flex: '1 1 auto', minWidth: 0, padding: '36px 0 96px', display: 'flex', justifyContent: 'center' }}>
          <article style={{ width: '100%', maxWidth: 740, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 16 }}>
            {!sideOn && (
              <label style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
                <span style={{ font: "500 10.5px 'JetBrains Mono',monospace", letterSpacing: '.08em', textTransform: 'uppercase', color: '#8a8f98' }}>Page</span>
                <select value={slug} onChange={(e) => router.push(href(e.target.value))} style={{ height: 38, padding: '0 10px', borderRadius: 7, border: '1px solid #34373d', background: '#0f1012', fontSize: 14 }}>
                  {DOCS.map((d) => (
                    <option key={d.slug} value={d.slug}>
                      {d.group} · {d.title}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {!doc ? (
              <>
                <h1 style={{ margin: 0, fontSize: 32, fontWeight: 600 }}>Page not found</h1>
                <p style={P}>
                  This documentation page does not exist. <Link href="/docs">Back to the docs home</Link>
                </p>
              </>
            ) : (
              <>
                <nav aria-label="Breadcrumb" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: '#8a8f98' }}>
                  <Link href="/docs" style={{ color: '#8a8f98', textDecoration: 'none' }}>
                    Docs
                  </Link>
                  <span style={{ color: '#55595f' }}>/</span>
                  <span style={{ color: '#b5b9c0' }}>{doc.group}</span>
                </nav>
                <h1 style={{ margin: 0, fontSize: 'clamp(28px,4vw,36px)', fontWeight: 600, letterSpacing: '-.022em', lineHeight: 1.12, textWrap: 'balance' }}>{doc.title}</h1>
                {doc.intro && (
                  <p style={{ ...P, fontSize: 17, color: '#b5b9c0' }}>
                    <Inline text={doc.intro} />
                  </p>
                )}
                {doc.meta?.length ? (
                  <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'auto minmax(0,1fr)', gap: '6px 16px', padding: '12px 16px', borderRadius: 9, background: '#15171b', border: '1px solid #25282d', fontSize: 13, lineHeight: 1.5 }}>
                    {doc.meta.map(([k, v]) => (
                      <div key={k} style={{ display: 'contents' }}>
                        <dt style={{ color: '#9a9fa8' }}>{k}</dt>
                        <dd style={{ margin: 0, color: '#c4c8ce' }}>
                          <Inline text={v} />
                        </dd>
                      </div>
                    ))}
                  </dl>
                ) : null}
                {doc.blocks.map((b, i) => (
                  <BlockView key={i} b={b} hid={hids[i]} />
                ))}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(240px,100%),1fr))', gap: 12, marginTop: 32, paddingTop: 24, borderTop: '1px solid #222429' }}>
                  {prev && (
                    <Link href={href(prev.slug)} className="docs-card" style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '14px 16px', borderRadius: 10, border: '1px solid #25282d', textDecoration: 'none' }}>
                      <span style={{ fontSize: 12, color: '#8a8f98' }}>Previous</span>
                      <span style={{ fontSize: 14, fontWeight: 600, color: '#ecedee' }}>{prev.title}</span>
                    </Link>
                  )}
                  {next && (
                    <Link href={href(next.slug)} className="docs-card" style={{ gridColumn: -2, display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4, padding: '14px 16px', borderRadius: 10, border: '1px solid #25282d', textAlign: 'right', textDecoration: 'none' }}>
                      <span style={{ fontSize: 12, color: '#8a8f98' }}>Next</span>
                      <span style={{ fontSize: 14, fontWeight: 600, color: '#ecedee' }}>{next.title}</span>
                    </Link>
                  )}
                </div>
              </>
            )}
          </article>
        </main>

        {tocOn && doc && (
          <aside aria-label="On this page" style={{ flex: '0 0 200px', position: 'sticky', top: 60, padding: '40px 0', display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ paddingBottom: 8, font: "500 10.5px 'JetBrains Mono',monospace", letterSpacing: '.08em', textTransform: 'uppercase', color: '#8a8f98' }}>On this page</span>
            {toc.map((t) => (
              <button
                key={t.hid}
                className="docs-toc-link"
                onClick={() => {
                  const el = document.getElementById(t.hid);
                  if (el) window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 80, behavior: 'smooth' });
                }}
                style={{ padding: '4px 0 4px 12px', border: 0, borderLeft: '1px solid #2c2f35', background: 'transparent', color: '#9a9fa8', fontSize: 13, lineHeight: 1.4, textAlign: 'left', cursor: 'pointer' }}
              >
                {t.text}
              </button>
            ))}
            {!toc.length && <span style={{ fontSize: 12.5, color: '#8a8f98' }}>No sections on this page.</span>}
          </aside>
        )}
      </div>
    </DocsShell>
  );
}
