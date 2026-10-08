/**
 * Framework-free wallet send logic (unit-tested). Classifies every outcome so
 * the UI can record it truthfully and never resubmits on ambiguity.
 */
export const PORTALDOT_CHAIN_ID_HEX = '0x190f1ca9';

export interface Eip1193 {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, fn: (...args: any[]) => void): void;
  removeListener?(event: string, fn: (...args: any[]) => void): void;
}

export type SendOutcome =
  | { outcome: 'submitted'; hash: string }
  | { outcome: 'rejected'; error: string }
  | { outcome: 'wrong_network'; error: string }
  | { outcome: 'failed_before_broadcast'; error: string }
  | { outcome: 'unknown'; error: string; late?: Promise<string | null> };

function errCode(e: unknown): number | undefined {
  const c = (e as { code?: unknown })?.code;
  return typeof c === 'number' ? c : undefined;
}

export function errMessage(e: unknown): string {
  return ((e as { message?: string })?.message ?? String(e)).split('\n')[0].slice(0, 300);
}

export async function sendWithProvider(
  provider: Eip1193,
  tx: { from: string; to?: string; data: string; value: string },
  timeoutMs = 180_000,
): Promise<SendOutcome> {
  // Re-read the chain right before signing; never trust cached state.
  let current: string;
  try {
    current = String(await provider.request({ method: 'eth_chainId' })).toLowerCase();
  } catch (e) {
    return { outcome: 'failed_before_broadcast', error: errMessage(e) };
  }
  if (current !== PORTALDOT_CHAIN_ID_HEX) return { outcome: 'wrong_network', error: `Wallet is on chain ${current}; expected ${PORTALDOT_CHAIN_ID_HEX}.` };
  const accs = (await provider.request({ method: 'eth_accounts' }).catch(() => [])) as string[];
  if (!accs.map((a) => a.toLowerCase()).includes(tx.from.toLowerCase())) return { outcome: 'failed_before_broadcast', error: 'The reviewed sender is no longer the selected wallet account.' };
  const params: Record<string, string> = { from: tx.from, data: tx.data, value: tx.value };
  if (tx.to) params.to = tx.to;
  const pending = provider.request({ method: 'eth_sendTransaction', params: [params] }) as Promise<string>;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((r) => (timer = setTimeout(() => r('timeout'), timeoutMs)));
  try {
    const r = await Promise.race([pending, timeout]);
    if (r === 'timeout') {
      return {
        outcome: 'unknown',
        error: `No response from the wallet after ${Math.round(timeoutMs / 1000)} s. The transaction may still be broadcast.`,
        late: pending.then((h) => (typeof h === 'string' && /^0x[0-9a-fA-F]{64}$/.test(h) ? h.toLowerCase() : null)).catch(() => null),
      };
    }
    if (typeof r !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(r)) return { outcome: 'unknown', error: 'The wallet returned an unexpected result instead of a transaction hash.' };
    return { outcome: 'submitted', hash: r.toLowerCase() };
  } catch (e) {
    if (errCode(e) === 4001) return { outcome: 'rejected', error: 'Rejected in the wallet. Nothing was submitted.' };
    const msg = errMessage(e);
    if (/insufficient funds/i.test(msg)) return { outcome: 'failed_before_broadcast', error: `Insufficient funds for value plus fee: ${msg}` };
    // Any other error after the request reached the wallet is ambiguous.
    return { outcome: 'unknown', error: msg };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
