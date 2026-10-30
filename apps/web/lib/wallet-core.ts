/**
 * Framework-free wallet send logic (unit-tested). Classifies every outcome so
 * the UI can record it truthfully and never resubmits on ambiguity.
 */
import { NETWORK } from './network';

export const PORTALDOT_CHAIN_ID_HEX = NETWORK.chainIdHex;

export interface Eip1193 {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, fn: (...args: any[]) => void): void;
  removeListener?(event: string, fn: (...args: any[]) => void): void;
}

// Wallets that also set isMetaMask for compatibility, checked before it.
const OTHER_WALLETS: [flag: string, name: string][] = [
  ['isRabby', 'Rabby'],
  ['isBraveWallet', 'Brave Wallet'],
  ['isCoinbaseWallet', 'Coinbase Wallet'],
  ['isOkxWallet', 'OKX Wallet'],
  ['isOKExWallet', 'OKX Wallet'],
  ['isTrust', 'Trust Wallet'],
  ['isPhantom', 'Phantom'],
  ['isZerion', 'Zerion'],
  ['isTalisman', 'Talisman'],
  ['isSubWallet', 'SubWallet'],
  ['isFrame', 'Frame'],
];

/** Best-effort name of the injected wallet: 'MetaMask', another known wallet, or null when it does not say. */
export function detectWallet(eth: Eip1193 | null): string | null {
  if (!eth) return null;
  const flags = eth as unknown as Record<string, unknown>;
  for (const [flag, name] of OTHER_WALLETS) if (flags[flag] === true) return name;
  return flags.isMetaMask === true ? 'MetaMask' : null;
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

/** Network parameters for wallet_addEthereumChain. Wallets require 18 decimals for EVM native currency metadata. */
export const PORTALDOT_ADD_CHAIN_PARAMS = {
  chainId: PORTALDOT_CHAIN_ID_HEX,
  chainName: NETWORK.walletName,
  rpcUrls: [NETWORK.rpcUrl],
  nativeCurrency: { name: NETWORK.symbol, symbol: NETWORK.symbol, decimals: 18 },
};

/** Wallets report "unknown chain" as 4902, nested in data/originalError, or only in the message. */
export function isUnknownChainError(e: unknown): boolean {
  const x = e as { code?: unknown; message?: unknown; data?: { code?: unknown; originalError?: { code?: unknown } } };
  if (x?.code === 4902 || x?.data?.code === 4902 || x?.data?.originalError?.code === 4902) return true;
  return /unrecognized chain|unknown chain|wallet_addEthereumChain|chain .* not (been )?added|no chain/i.test(String(x?.message ?? ''));
}

export type SwitchResult =
  | { ok: true; added: boolean }
  | { ok: false; reason: 'rejected' | 'rpc_unreachable' | 'add_failed' | 'switch_failed' | 'still_wrong_chain'; message: string };

const RPC_FAILURE_RE = /fetch|chain ?id|rpc|network error|could not|timeout|timed out|failed to|502|bad gateway|unreachable/i;

/**
 * Switch the wallet to Portaldot V3; if the wallet does not know the chain,
 * ask it to add the network (the wallet itself shows the prompt). Wallets
 * validate the RPC while adding, so an unreachable RPC is reported as such.
 */
export async function switchOrAddChain(provider: Eip1193): Promise<SwitchResult> {
  let added = false;
  try {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: PORTALDOT_CHAIN_ID_HEX }] });
  } catch (e) {
    if (errCode(e) === 4001) return { ok: false, reason: 'rejected', message: 'Network switch was rejected in the wallet.' };
    if (!isUnknownChainError(e)) return { ok: false, reason: 'switch_failed', message: errMessage(e) };
    try {
      await provider.request({ method: 'wallet_addEthereumChain', params: [PORTALDOT_ADD_CHAIN_PARAMS] });
      added = true;
    } catch (e2) {
      if (errCode(e2) === 4001) return { ok: false, reason: 'rejected', message: `Adding ${NETWORK.label} was rejected in the wallet.` };
      const msg = errMessage(e2);
      if (RPC_FAILURE_RE.test(msg)) {
        return {
          ok: false,
          reason: 'rpc_unreachable',
          message: `The wallet could not add ${NETWORK.label} because it could not reach the RPC (${PORTALDOT_ADD_CHAIN_PARAMS.rpcUrls[0]}). Wallets check the RPC before adding a network. Try again when the Portaldot RPC responds. Wallet said: ${msg}`,
        };
      }
      return { ok: false, reason: 'add_failed', message: `The wallet could not add the network: ${msg}` };
    }
  }
  const now = String(await provider.request({ method: 'eth_chainId' }).catch(() => '')).toLowerCase();
  if (now !== PORTALDOT_CHAIN_ID_HEX) {
    return { ok: false, reason: 'still_wrong_chain', message: added ? `The network was added but the wallet did not switch to it. Select ${NETWORK.walletName} in the wallet.` : `The wallet is still on chain ${now || 'unknown'}.` };
  }
  return { ok: true, added };
}

export type ConnectResult =
  | { ok: true; account: string | null; chainId: string | null }
  | { ok: false; reason: 'rejected' | 'pending' | 'timeout' | 'error'; message: string };

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<'timeout'>((r) => (t = setTimeout(() => r('timeout'), ms)))]).finally(() => t && clearTimeout(t));
}

/**
 * Ask the wallet for account access without waiting forever. A wallet that is
 * locked, still loading, or stuck on an unreachable network RPC often never
 * answers; the caller gets an actionable message instead of an endless spinner.
 */
export async function connectWithTimeout(provider: Eip1193, timeoutMs = 45_000): Promise<ConnectResult> {
  try {
    const accs = await withTimeout(provider.request({ method: 'eth_requestAccounts' }) as Promise<string[]>, timeoutMs);
    if (accs === 'timeout') {
      return {
        ok: false,
        reason: 'timeout',
        message: `The wallet did not answer within ${Math.round(timeoutMs / 1000)} s. Open the wallet extension: unlock it, and if it is stuck loading ("Initializing"), check the selected network. A Portaldot V3 network saved with the retired RPC (feso-apps.xyz) never loads; edit its RPC URL to https://test-evm-rpc-v3.portaldot.dev or switch to another network, then try again.`,
      };
    }
    const chain = await withTimeout(provider.request({ method: 'eth_chainId' }) as Promise<string>, 10_000).catch(() => 'timeout' as const);
    return { ok: true, account: accs?.[0]?.toLowerCase() ?? null, chainId: chain === 'timeout' ? null : String(chain).toLowerCase() };
  } catch (e) {
    const code = errCode(e);
    if (code === 4001) return { ok: false, reason: 'rejected', message: 'Connection request was rejected in the wallet.' };
    if (code === -32002) return { ok: false, reason: 'pending', message: 'A connection request is already open in your wallet. Open the wallet extension and approve or reject it there.' };
    return { ok: false, reason: 'error', message: errMessage(e) };
  }
}
