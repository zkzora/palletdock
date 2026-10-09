import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DOCS, DOC_GROUPS } from '../lib/docs';

/** Static app routes (directories under app/ that contain a page.tsx). */
function appRoutes(dir = path.join(import.meta.dirname, '..', 'app'), prefix = ''): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (!statSync(p).isDirectory()) continue;
    if (name.startsWith('[')) continue;
    const route = `${prefix}/${name}`;
    try {
      statSync(path.join(p, 'page.tsx'));
      out.push(route);
    } catch {
      /* no page here */
    }
    out.push(...appRoutes(p, route));
  }
  return out;
}

describe('documentation wiring', () => {
  const slugs = new Set(DOCS.map((d) => d.slug));
  const routes = new Set(['/', ...appRoutes()]);

  it('includes every page from the content kit routes', () => {
    for (const s of ['', 'getting-started', 'network', 'accounts', 'funding', 'deploy', 'contracts', 'assets', 'nfts', 'indexer', 'api', 'security', 'troubleshooting', 'glossary']) {
      expect(slugs.has(s), `missing /docs/${s}`).toBe(true);
    }
    expect(routes.has('/faq') && routes.has('/roadmap') && routes.has('/support')).toBe(true);
  });

  it('has unique slugs and known groups', () => {
    expect(slugs.size).toBe(DOCS.length);
    for (const d of DOCS) expect(DOC_GROUPS, d.slug).toContain(d.group);
  });

  it('every internal link resolves', () => {
    const bad: string[] = [];
    const check = (href: string, where: string) => {
      if (!href.startsWith('/')) return;
      const clean = href.split(/[?#]/)[0];
      if (clean.startsWith('/docs')) {
        const s = clean.replace(/^\/docs\/?/, '');
        if (!slugs.has(s)) bad.push(`${where} → ${href}`);
      } else if (!routes.has(clean)) bad.push(`${where} → ${href}`);
    };
    for (const d of DOCS) {
      const text = JSON.stringify([d.intro, d.meta, d.blocks]);
      for (const m of text.matchAll(/\]\((\/[^)]+)\)/g)) check(m[1], d.slug || 'home');
      for (const b of d.blocks) {
        if (b[0] === 'links') for (const [s] of b[1]) check(`/docs/${s}`, d.slug || 'home');
        if (b[0] === 'next') check(`/docs/${b[1]}`, d.slug || 'home');
      }
    }
    expect(bad).toEqual([]);
  });
});
