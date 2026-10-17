import { describe, expect, it } from 'vitest';
import { PORTALDOT_V3_TESTNET } from '@palletdock/shared';
import { EvmAdapter, toBlockTag } from '../src/evm.js';
import { RpcResponseError, RpcTransportError, type RpcCaller } from '../src/json-rpc.js';

const H32 = `0x${'11'.repeat(32)}` as const;
const H32_B = `0x${'22'.repeat(32)}` as const;

class FakeRpc implements RpcCaller {
  constructor(private readonly responses: Record<string, unknown>) {}
  async call<T>(method: string): Promise<T> {
    if (!(method in this.responses)) throw new Error(`Unexpected method ${method}`);
    return this.responses[method] as T;
  }
}

describe('EvmAdapter', () => {
  it('verifies identity and keeps block quantities lossless', async () => {
    const adapter = new EvmAdapter(
      PORTALDOT_V3_TESTNET,
      new FakeRpc({
        eth_chainId: PORTALDOT_V3_TESTNET.evmChainIdHex,
        eth_getBlockByNumber: { number: '0x20000000000001', hash: H32_B },
        web3_clientVersion: 'test-client',
      }),
    );
    // Supply distinct genesis/latest blocks because identity performs the same RPC method twice.
    let blockCall = 0;
    (adapter.rpc as FakeRpc).call = async <T>(method: string): Promise<T> => {
      if (method === 'eth_chainId') return PORTALDOT_V3_TESTNET.evmChainIdHex as T;
      if (method === 'web3_clientVersion') return 'test-client' as T;
      if (method === 'eth_getBlockByNumber') return (++blockCall === 1 ? { hash: H32 } : { number: '0x20000000000001', hash: H32_B }) as T;
      throw new Error(`Unexpected method ${method}`);
    };
    await expect(adapter.identity()).resolves.toEqual({
      chainId: 420420777,
      chainIdHex: '0x190f1ca9',
      genesisHash: H32,
      genesisNote: null,
      latestBlockNumber: '9007199254740993',
      latestBlockHash: H32_B,
      clientVersion: 'test-client',
    });
  });

  it('tolerates a pruned node that cannot serve EVM block 0, but not a transport failure', async () => {
    const pruned: RpcCaller = {
      async call<T>(method: string, params: readonly unknown[] = []): Promise<T> {
        if (method === 'eth_chainId') return PORTALDOT_V3_TESTNET.evmChainIdHex as T;
        if (method === 'web3_clientVersion') return 'eth-rpc/main' as T;
        if (method === 'eth_getBlockByNumber' && params[0] === '0x0') {
          throw new RpcResponseError('Cannot construct OnlineClientAtBlock: UnknownBlock: State already discarded', -32000, null, method);
        }
        if (method === 'eth_getBlockByNumber') return { number: '0x107f9', hash: H32_B } as T;
        throw new Error(`Unexpected method ${method}`);
      },
    };
    const id = await new EvmAdapter(PORTALDOT_V3_TESTNET, pruned).identity();
    expect(id).toMatchObject({ chainId: 420420777, genesisHash: null, latestBlockNumber: '67577' });
    expect(id.genesisNote).toMatch(/State already discarded/);

    const down: RpcCaller = {
      async call<T>(method: string, params: readonly unknown[] = []): Promise<T> {
        if (method === 'eth_getBlockByNumber' && params[0] === '0x0') throw new RpcTransportError('RPC returned HTTP 502', 'http', method, 502);
        return pruned.call<T>(method, params);
      },
    };
    await expect(new EvmAdapter(PORTALDOT_V3_TESTNET, down).identity()).rejects.toThrow(/502/);
  });

  it('rejects a wrong chain before it can be recorded as healthy', async () => {
    const rpc = new FakeRpc({
      eth_chainId: '0x1',
      eth_getBlockByNumber: { number: '0x1', hash: H32 },
      web3_clientVersion: 'wrong-chain',
    });
    await expect(new EvmAdapter(PORTALDOT_V3_TESTNET, rpc).identity()).rejects.toThrow('identity mismatch');
  });

  it('converts decimal block numbers to canonical RPC quantities', () => {
    expect(toBlockTag('0')).toBe('0x0');
    expect(toBlockTag('9007199254740993')).toBe('0x20000000000001');
    expect(toBlockTag('latest')).toBe('latest');
  });
});
