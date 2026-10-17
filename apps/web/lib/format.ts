/** Display helpers. Chain quantities arrive as decimal strings and are never parsed through Number. */

export function shortHash(h: string | null | undefined, head = 10, tail = 6): string {
  if (!h) return '';
  return h.length > head + tail + 1 ? `${h.slice(0, head)}…${h.slice(-tail)}` : h;
}

export function shortAddr(a: string | null | undefined): string {
  return shortHash(a, 6, 4);
}

export function groupDigits(dec: string | null | undefined): string {
  if (dec === null || dec === undefined || dec === '') return '';
  const neg = dec.startsWith('-');
  const [i, f] = (neg ? dec.slice(1) : dec).split('.');
  const g = i.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '-' : '') + (f ? `${g}.${f}` : g);
}

export function rawUnits(dec: string | null | undefined): string {
  if (dec === null || dec === undefined) return 'Unavailable';
  return `${groupDigits(dec)} raw base units`;
}

/** Exact native-unit formatting (only for native Substrate amounts with verified decimals). */
export function formatNative(raw: string, decimals = 14, symbol = 'tPOT'): string {
  const v = BigInt(raw);
  const base = 10n ** BigInt(decimals);
  const frac = (v % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${groupDigits((v / base).toString())}${frac ? '.' + frac : ''} ${symbol}`;
}

export function when(ts: string | null | undefined): string {
  if (!ts) return '—';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

export function ago(ts: string | null | undefined): string {
  if (!ts) return 'never';
  const s = Math.round((Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 0) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function pretty(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x), 2);
}

export function withProject(href: string, projectId: string | null | undefined): string {
  if (!projectId) return href;
  return href + (href.includes('?') ? '&' : '?') + `project=${projectId}`;
}
