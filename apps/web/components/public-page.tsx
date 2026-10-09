'use client';

import { DocsShell, Inline } from '@/components/docs-shell';

/** Single-column public page (FAQ, Roadmap, Support) in the docs design. */
export function PublicPage({ eyebrow, title, intro, children }: { eyebrow: string; title: string; intro: string; children: React.ReactNode }) {
  return (
    <DocsShell section={eyebrow}>
      <main style={{ maxWidth: 820, margin: '0 auto', padding: '36px 24px 96px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <h1 style={{ margin: 0, fontSize: 'clamp(28px,4vw,36px)', fontWeight: 600, letterSpacing: '-.022em', lineHeight: 1.12 }}>{title}</h1>
        <p style={{ margin: 0, fontSize: 17, lineHeight: 1.65, color: '#b5b9c0' }}>
          <Inline text={intro} />
        </p>
        {children}
      </main>
    </DocsShell>
  );
}

export function Section({ title, children, id }: { title: string; children: React.ReactNode; id?: string }) {
  return (
    <section id={id} style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 14 }}>
      <h2 style={{ margin: 0, fontSize: 19, fontWeight: 600, letterSpacing: '-.01em' }}>{title}</h2>
      {children}
    </section>
  );
}

export function Para({ text }: { text: string }) {
  return (
    <p style={{ margin: 0, fontSize: 15, lineHeight: 1.7, color: '#c4c8ce' }}>
      <Inline text={text} />
    </p>
  );
}
