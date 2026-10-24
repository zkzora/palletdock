import { describe, expect, it } from 'vitest';
import { PORTALDOT_V3_TESTNET } from '@palletdock/shared';
import { EvmAdapter, toBlockTag } from '../src/evm.js';
import type { RpcCaller } from '../src/json-rpc.js';

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
      latestBlockNumber: '9007199254740993',
      latestBlockHash: H32_B,
      clientVersion: 'test-client',
    });
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

describe('EvmAdapter.logs', () => {
  it('accepts empty log data and keeps indexes exact', async () => {
    const rpc = new FakeRpc({
      eth_getLogs: [
        {
          address: '0x5fbdb2315678afecb367f032d93f642f64180aa3',
          topics: [H32],
          data: '0x',
          blockNumber: '0x10',
          blockHash: H32_B,
          transactionHash: H32,
          transactionIndex: '0x0',
          logIndex: '0x2',
        },
      ],
    });
    const [log] = await new EvmAdapter(PORTALDOT_V3_TESTNET, rpc).logs({ address: '0x5FbDB2315678afecb367f032d93F642f64180aa3', fromBlock: 0n, toBlock: 16n });
    expect(log).toMatchObject({ data: '0x', blockNumber: '16', logIndex: 2, removed: false });
  });

  it('rejects odd-length log data', async () => {
    const rpc = new FakeRpc({ eth_getLogs: [{ address: '0x5fbdb2315678afecb367f032d93f642f64180aa3', topics: [], data: '0x1', blockNumber: '0x1', blockHash: H32, transactionHash: H32, transactionIndex: '0x0', logIndex: '0x0' }] });
    await expect(new EvmAdapter(PORTALDOT_V3_TESTNET, rpc).logs({ address: '0x5FbDB2315678afecb367f032d93F642f64180aa3', fromBlock: 0n, toBlock: 1n })).rejects.toThrow('invalid log data');
  });
});
