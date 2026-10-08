/**
 * Lossless quantity helpers. Raw chain quantities are carried as decimal
 * strings; bigint never passes through Number.
 */

const DEC_RE = /^(0|[1-9][0-9]*)$/;
const HEX_RE = /^0x[0-9a-fA-F]+$/;

export function isDecimalString(v: unknown): v is string {
  return typeof v === 'string' && DEC_RE.test(v);
}

/** Convert an RPC hex quantity (or bigint / decimal string) to a decimal string. */
export function toDecimalString(v: string | bigint | number | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') {
    if (v < 0n) throw new Error('Negative quantity');
    return v.toString(10);
  }
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v) || v < 0) throw new Error('Unsafe numeric quantity');
    return String(v);
  }
  if (HEX_RE.test(v)) return BigInt(v).toString(10);
  if (v === '0x') return '0';
  if (DEC_RE.test(v)) return v;
  throw new Error(`Not a quantity: ${v}`);
}

/** Parse a block number filter string to bigint; null when empty. */
export function parseBlockNumber(v: string | undefined | null): bigint | null {
  if (v === undefined || v === null || v === '') return null;
  if (!DEC_RE.test(v)) throw new Error('Block numbers must be non-negative decimal integers');
  return BigInt(v);
}

/**
 * Format a raw integer amount with a decimals scale. Only call this when the
 * scale is verified for the source of the value (e.g. native balances with the
 * runtime tokenDecimals). Returns an exact decimal string, no rounding.
 */
export function formatUnitsExact(raw: string | bigint, decimals: number): string {
  const v = typeof raw === 'bigint' ? raw : BigInt(raw);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = abs % base;
  let fracStr = decimals ? frac.toString().padStart(decimals, '0').replace(/0+$/, '') : '';
  return (neg ? '-' : '') + whole.toString() + (fracStr ? '.' + fracStr : '');
}

/** Group digits of a decimal string for display without converting to Number. */
export function groupDigits(dec: string | null | undefined): string {
  if (dec === null || dec === undefined || dec === '') return '';
  const [i, f] = dec.split('.');
  const g = i.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return f ? g + '.' + f : g;
}

/**
 * EVM unit policy. The guide documents 14 native decimals but does not specify
 * the EVM facade's denomination. Until a verified probe records it, EVM
 * balances/values/fees are shown raw with an explicit "unit unverified" label.
 */
export type EvmUnitPolicy =
  | { status: 'unverified'; reason: string }
  | { status: 'verified'; decimals: number; evidence: string };

export const DEFAULT_EVM_UNIT_POLICY: EvmUnitPolicy = {
  status: 'unverified',
  reason:
    'The EVM RPC denomination has not been verified against native balances. Raw base-unit quantities are shown; no decimal conversion is applied.',
};

export function describeEvmAmount(raw: string | null, policy: EvmUnitPolicy = DEFAULT_EVM_UNIT_POLICY): string {
  if (raw === null) return 'Unavailable';
  if (policy.status === 'verified') return `${formatUnitsExact(raw, policy.decimals)} (EVM units, ${policy.decimals} decimals verified)`;
  return `${groupDigits(raw)} raw EVM base units · display conversion unavailable`;
}

/** JSON.stringify replacer that encodes bigint as decimal strings. */
export function bigintReplacer(_k: string, v: unknown): unknown {
  return typeof v === 'bigint' ? v.toString(10) : v;
}

export function stringifyLossless(v: unknown, space?: number): string {
  return JSON.stringify(v, bigintReplacer, space);
}
