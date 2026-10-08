'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

/**
 * Browser wallet (EIP-1193) connection. PalletDock never holds keys or seed
 * phrases: every chain write is signed and broadcast by the user's wallet
 * after review. Connecting a wallet does not grant workspace data access.
 */

export const PORTALDOT_CHAIN = {
  chainIdHex: '0x190f1ca9',
  chainId: 420420777,
  chainName: 'Portaldot V3 Testnet',
  rpcUrls: ['https://testnetv3-eth-rpc.feso-apps.xyz'],
  nativeCurrency: { name: 'tPOTv3', symbol: 'tPOTv3', decimals: 18 },
};

interface Eip1193 {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, fn: (...args: any[]) => void): void;
  removeListener?(event: string, fn: (...args: any[]) => void): void;
}

declare global {
  interface Window {
    ethereum?: Eip1193;
  }
}

export type SendOutcome =
  | { outcome: 'submitted'; hash: string }
  | { outcome: 'rejected'; error: string }
  | { outcome: 'wrong_network'; error: string }
  | { outcome: 'failed_before_broadcast'; error: string }
  | { outcome: 'unknown'; error: string; late?: Promise<string | null> };

interface WalletValue {
  available: boolean;
  account: string | null;
  chainId: string | null;
  onPortaldot: boolean;
  connecting: boolean;
  error: string;
  connect(): Promise<void>;
  disconnect(): void;
  switchNetwork(): Promise<boolean>;
  send(tx: { from: string; to?: string; data: string; value: string }, timeoutMs?: number): Promise<SendOutcome>;
  balanceRaw(): Promise<string | null>;
}

const WalletContext = createContext<WalletValue | null>(null);

export function useWallet(): WalletValue {
  const v = useContext(WalletContext);
  if (!v) throw new Error('Wallet context missing');
  return v;
}

function errCode(e: unknown): number | undefined {
  const c = (e as { code?: unknown })?.code;
  return typeof c === 'number' ? c : undefined;
}

function errMessage(e: unknown): string {
  return ((e as { message?: string })?.message ?? String(e)).split('\n')[0].slice(0, 300);
}

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [provider, setProvider] = useState<Eip1193 | null>(null);
  const [account, setAccount] = useState<string | null>(null);
  const [chainId, setChainId] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const eth = typeof window !== 'undefined' ? window.ethereum ?? null : null;
    setProvider(eth);
    if (!eth) return;
    const onAccounts = (accs: string[]) => setAccount(accs?.[0]?.toLowerCase() ?? null);
    const onChain = (id: string) => setChainId(String(id).toLowerCase());
    const onDisconnect = () => setAccount(null);
    eth.on?.('accountsChanged', onAccounts);
    eth.on?.('chainChanged', onChain);
    eth.on?.('disconnect', onDisconnect);
    // Restore an existing authorization silently (no prompt).
    eth.request({ method: 'eth_accounts' }).then((a) => onAccounts(a as string[])).catch(() => {});
    eth.request({ method: 'eth_chainId' }).then((c) => onChain(c as string)).catch(() => {});
    return () => {
      eth.removeListener?.('accountsChanged', onAccounts);
      eth.removeListener?.('chainChanged', onChain);
      eth.removeListener?.('disconnect', onDisconnect);
    };
  }, []);

  const connect = useCallback(async () => {
    if (!provider) {
      setError('No browser wallet was detected. Install an EVM wallet extension to sign transactions.');
      return;
    }
    setConnecting(true);
    setError('');
    try {
      const accs = (await provider.request({ method: 'eth_requestAccounts' })) as string[];
      setAccount(accs?.[0]?.toLowerCase() ?? null);
      setChainId(String(await provider.request({ method: 'eth_chainId' })).toLowerCase());
    } catch (e) {
      setError(errCode(e) === 4001 ? 'Connection request was rejected in the wallet.' : errMessage(e));
    } finally {
      setConnecting(false);
    }
  }, [provider]);

  const switchNetwork = useCallback(async () => {
    if (!provider) return false;
    try {
      await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: PORTALDOT_CHAIN.chainIdHex }] });
    } catch (e) {
      if (errCode(e) === 4902) {
        try {
          await provider.request({
            method: 'wallet_addEthereumChain',
            params: [{ chainId: PORTALDOT_CHAIN.chainIdHex, chainName: PORTALDOT_CHAIN.chainName, rpcUrls: PORTALDOT_CHAIN.rpcUrls, nativeCurrency: PORTALDOT_CHAIN.nativeCurrency }],
          });
        } catch (e2) {
          setError(errMessage(e2));
          return false;
        }
      } else {
        setError(errCode(e) === 4001 ? 'Network switch was rejected in the wallet.' : errMessage(e));
        return false;
      }
    }
    const now = String(await provider.request({ method: 'eth_chainId' })).toLowerCase();
    setChainId(now);
    return now === PORTALDOT_CHAIN.chainIdHex;
  }, [provider]);

  const send = useCallback<WalletValue['send']>(
    async (tx, timeoutMs = 180_000) => {
      if (!provider) return { outcome: 'failed_before_broadcast', error: 'No browser wallet is available.' };
      // Re-read the chain right before signing; never trust cached state.
      let current: string;
      try {
        current = String(await provider.request({ method: 'eth_chainId' })).toLowerCase();
      } catch (e) {
        return { outcome: 'failed_before_broadcast', error: errMessage(e) };
      }
      if (current !== PORTALDOT_CHAIN.chainIdHex) return { outcome: 'wrong_network', error: `Wallet is on chain ${current}; expected ${PORTALDOT_CHAIN.chainIdHex}.` };
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
            late: pending.then((h) => (typeof h === 'string' ? h : null)).catch(() => null),
          };
        }
        if (typeof r !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(r)) return { outcome: 'unknown', error: 'The wallet returned an unexpected result instead of a transaction hash.' };
        return { outcome: 'submitted', hash: r.toLowerCase() };
      } catch (e) {
        const code = errCode(e);
        if (code === 4001) return { outcome: 'rejected', error: 'Rejected in the wallet. Nothing was submitted.' };
        const msg = errMessage(e);
        if (/insufficient funds/i.test(msg)) return { outcome: 'failed_before_broadcast', error: `Insufficient funds for value plus fee: ${msg}` };
        // Any other error after the request reached the wallet is ambiguous.
        return { outcome: 'unknown', error: msg };
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
    [provider],
  );

  const balanceRaw = useCallback(async () => {
    if (!provider || !account) return null;
    try {
      return BigInt(String(await provider.request({ method: 'eth_getBalance', params: [account, 'latest'] }))).toString();
    } catch {
      return null;
    }
  }, [provider, account]);

  const value = useMemo<WalletValue>(
    () => ({
      available: !!provider,
      account,
      chainId,
      onPortaldot: chainId === PORTALDOT_CHAIN.chainIdHex,
      connecting,
      error,
      connect,
      disconnect: () => setAccount(null),
      switchNetwork,
      send,
      balanceRaw,
    }),
    [provider, account, chainId, connecting, error, connect, switchNetwork, send, balanceRaw],
  );
  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}
