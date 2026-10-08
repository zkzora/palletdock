import { describe, expect, it } from 'vitest';
import { sendWithProvider, type Eip1193 } from '../lib/wallet-core';

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
