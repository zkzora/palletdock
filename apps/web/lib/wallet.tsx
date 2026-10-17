'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { NETWORK } from '@/lib/network';

/**
 * Browser wallet (EIP-1193) connection. PalletDock never holds keys or seed
 * phrases: every chain write is signed and broadcast by the user's wallet
 * after review. Connecting a wallet does not grant workspace data access.
 */

export const PORTALDOT_CHAIN = {
  chainIdHex: NETWORK.chainIdHex,
  chainId: NETWORK.chainId,
  chainName: NETWORK.walletName,
  rpcUrls: [NETWORK.rpcUrl],
  nativeCurrency: { name: NETWORK.symbol, symbol: NETWORK.symbol, decimals: 18 },
};

declare global {
  interface Window {
    ethereum?: Eip1193;
  }
}

import { connectWithTimeout, sendWithProvider, switchOrAddChain, type Eip1193, type SendOutcome, type SwitchResult } from './wallet-core';
export type { SendOutcome } from './wallet-core';

interface WalletValue {
  available: boolean;
  account: string | null;
  chainId: string | null;
  onPortaldot: boolean;
  connecting: boolean;
  error: string;
  connect(): Promise<void>;
  disconnect(): void;
  switchNetwork(): Promise<SwitchResult>;
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
    const r = await connectWithTimeout(provider);
    if (r.ok) {
      setAccount(r.account);
      setChainId(r.chainId);
    } else setError(r.message);
    setConnecting(false);
  }, [provider]);

  const switchNetwork = useCallback(async (): Promise<SwitchResult> => {
    if (!provider) return { ok: false, reason: 'switch_failed', message: 'No browser wallet is available.' };
    setError('');
    const r = await switchOrAddChain(provider);
    setChainId(String(await provider.request({ method: 'eth_chainId' }).catch(() => '')).toLowerCase() || null);
    if (!r.ok) setError(r.message);
    return r;
  }, [provider]);

  const send = useCallback<WalletValue['send']>((tx, timeoutMs) => (provider ? sendWithProvider(provider, tx, timeoutMs) : Promise.resolve({ outcome: 'failed_before_broadcast', error: 'No browser wallet is available.' })), [provider]);

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
