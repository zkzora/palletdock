import { describe, expect, it } from 'vitest';
import { isUnknownChainError, sendWithProvider, switchOrAddChain, type Eip1193 } from '../lib/wallet-core';

const FROM = '0x7a3f09c2d4e81b6a5f3c90e7d12b48a6e0f9c315';
const HASH = '0x' + 'ab'.repeat(32);

function provider(over: Partial<Record<string, (params?: unknown[]) => unknown>>): Eip1193 & { sent: number } {
  const p = {
    sent: 0,
    async request({ method, params }: { method: string; params?: unknown[] }) {
      if (method === 'eth_sendTransaction') p.sent++;
      const f = over[method];
      if (f) return f(params);
      if (method === 'eth_chainId') return '0x190f1ca9';
      if (method === 'eth_accounts') return [FROM];
      if (method === 'eth_sendTransaction') return HASH;
      throw new Error(`unexpected ${method}`);
    },
  };
  return p;
}

const tx = { from: FROM, to: '0x5fb2e1c4a0d93b7e8c61f4a2b9d07e35c8a1f402', data: '0x6057361d', value: '0x0' };

describe('wallet send classification', () => {
  it('returns the hash on approval', async () => {
    expect(await sendWithProvider(provider({}), tx)).toEqual({ outcome: 'submitted', hash: HASH });
  });

  it('blocks a wrong network before asking for a signature', async () => {
    const p = provider({ eth_chainId: () => '0x1' });
    const r = await sendWithProvider(p, tx);
    expect(r.outcome).toBe('wrong_network');
    expect(p.sent).toBe(0);
  });

  it('blocks when the reviewed sender is no longer selected', async () => {
    const p = provider({ eth_accounts: () => ['0x' + '11'.repeat(20)] });
    expect((await sendWithProvider(p, tx)).outcome).toBe('failed_before_broadcast');
    expect(p.sent).toBe(0);
  });

  it('classifies user rejection (4001) as rejected', async () => {
    const r = await sendWithProvider(provider({ eth_sendTransaction: () => Promise.reject(Object.assign(new Error('User rejected'), { code: 4001 })) }), tx);
    expect(r.outcome).toBe('rejected');
  });

  it('classifies insufficient funds as failed before broadcast', async () => {
    const r = await sendWithProvider(provider({ eth_sendTransaction: () => Promise.reject(new Error('insufficient funds for gas * price + value')) }), tx);
    expect(r.outcome).toBe('failed_before_broadcast');
  });

  it('treats other wallet errors as unknown, never as failure', async () => {
    const r = await sendWithProvider(provider({ eth_sendTransaction: () => Promise.reject(Object.assign(new Error('Internal JSON-RPC error'), { code: -32603 })) }), tx);
    expect(r.outcome).toBe('unknown');
  });

  it('times out as unknown and still captures a late hash without resubmitting', async () => {
    let resolveLate!: (h: string) => void;
    const p = provider({ eth_sendTransaction: () => new Promise<string>((r) => (resolveLate = r)) });
    const r = await sendWithProvider(p, tx, 30);
    expect(r.outcome).toBe('unknown');
    resolveLate(HASH);
    expect(await (r as { late: Promise<string | null> }).late).toBe(HASH);
    expect(p.sent).toBe(1);
  });

  it('treats a non-hash result as unknown', async () => {
    expect((await sendWithProvider(provider({ eth_sendTransaction: () => 'ok' }), tx)).outcome).toBe('unknown');
  });
});

/** Wallet that does not know Portaldot until wallet_addEthereumChain succeeds. */
function chainWallet(opts: { unknownError: unknown; addError?: unknown; switchAfterAdd?: boolean }) {
  let chain = '0x1';
  let known = false;
  const calls: string[] = [];
  const p: Eip1193 = {
    async request({ method, params }) {
      calls.push(method);
      if (method === 'eth_chainId') return chain;
      if (method === 'wallet_switchEthereumChain') {
        if (!known) throw opts.unknownError;
        chain = (params?.[0] as { chainId: string }).chainId;
        return null;
      }
      if (method === 'wallet_addEthereumChain') {
        if (opts.addError) throw opts.addError;
        known = true;
        if (opts.switchAfterAdd !== false) chain = (params?.[0] as { chainId: string }).chainId;
        return null;
      }
      throw new Error(`unexpected ${method}`);
    },
  };
  return { p, calls };
}

describe('switch or add Portaldot V3', () => {
  const variants: Array<[string, unknown]> = [
    ['code 4902', Object.assign(new Error('Unrecognized chain'), { code: 4902 })],
    ['nested originalError 4902', Object.assign(new Error('Internal JSON-RPC error.'), { code: -32603, data: { originalError: { code: 4902 } } })],
    ['message only', new Error('Unrecognized chain ID "0x190f1ca9". Try adding the chain using wallet_addEthereumChain first.')],
  ];
  for (const [name, err] of variants) {
    it(`adds the network when the wallet reports an unknown chain (${name})`, async () => {
      const { p, calls } = chainWallet({ unknownError: err });
      expect(isUnknownChainError(err)).toBe(true);
      expect(await switchOrAddChain(p)).toEqual({ ok: true, added: true });
      expect(calls).toContain('wallet_addEthereumChain');
    });
  }

  it('explains that an unreachable RPC blocks adding the network', async () => {
    const { p } = chainWallet({ unknownError: Object.assign(new Error('x'), { code: 4902 }), addError: new Error('Could not fetch chain ID. Is your RPC URL correct?') });
    const r = await switchOrAddChain(p);
    expect(r).toMatchObject({ ok: false, reason: 'rpc_unreachable' });
    expect((r as { message: string }).message).toMatch(/testnetv3-eth-rpc/);
  });

  it('reports a rejection of the add prompt', async () => {
    const { p } = chainWallet({ unknownError: Object.assign(new Error('x'), { code: 4902 }), addError: Object.assign(new Error('User rejected'), { code: 4001 }) });
    expect(await switchOrAddChain(p)).toMatchObject({ ok: false, reason: 'rejected' });
  });

  it('reports when the network was added but not selected', async () => {
    const { p } = chainWallet({ unknownError: Object.assign(new Error('x'), { code: 4902 }), switchAfterAdd: false });
    expect(await switchOrAddChain(p)).toMatchObject({ ok: false, reason: 'still_wrong_chain' });
  });

  it('does not try to add the chain for unrelated switch errors', async () => {
    const { p, calls } = chainWallet({ unknownError: Object.assign(new Error('Request already pending'), { code: -32002 }) });
    expect(await switchOrAddChain(p)).toMatchObject({ ok: false, reason: 'switch_failed' });
    expect(calls).not.toContain('wallet_addEthereumChain');
  });
});

