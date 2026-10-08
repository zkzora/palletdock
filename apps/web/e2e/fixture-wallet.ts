import type { Page } from '@playwright/test';

/**
 * Test-only EIP-1193 provider injected by Playwright. It forwards requests to
 * the local fixture chain (Hardhat, unlocked accounts) and can simulate a user
 * rejecting the request. It is never part of the application bundle.
 */
export async function installFixtureWallet(page: Page, opts: { rpcUrl: string; account: string; chainId?: string }) {
  await page.addInitScript(
    ({ rpcUrl, account, chainId }) => {
      const listeners: Record<string, Array<(...a: unknown[]) => void>> = {};
      const state = { mode: 'approve' as 'approve' | 'reject', chainId, connected: false };
      (window as any).__pdWallet = state;
      const forward = async (method: string, params: unknown[] = []) => {
        const r = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }) });
        const j = await r.json();
        if (j.error) throw Object.assign(new Error(j.error.message), { code: j.error.code, data: j.error.data });
        return j.result;
      };
      (window as any).ethereum = {
        isPalletDockFixtureWallet: true,
        on(e: string, f: (...a: unknown[]) => void) {
          (listeners[e] ??= []).push(f);
        },
        removeListener(e: string, f: (...a: unknown[]) => void) {
          listeners[e] = (listeners[e] ?? []).filter((x) => x !== f);
        },
        async request({ method, params }: { method: string; params?: unknown[] }) {
          switch (method) {
            case 'eth_requestAccounts':
              state.connected = true;
              return [account];
            case 'eth_accounts':
              return state.connected ? [account] : [];
            case 'eth_chainId':
              return state.chainId;
            case 'wallet_switchEthereumChain':
              state.chainId = (params?.[0] as { chainId: string }).chainId;
              (listeners.chainChanged ?? []).forEach((f) => f(state.chainId));
              return null;
            case 'eth_sendTransaction':
              if (state.mode === 'reject') throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
              return forward(method, params);
            default:
              return forward(method, params);
          }
        },
      };
    },
    { rpcUrl: opts.rpcUrl, account: opts.account, chainId: opts.chainId ?? '0x190f1ca9' },
  );
}
