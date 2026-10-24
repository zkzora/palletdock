import { encodeAbiParameters, encodeEventTopics, keccak256, toHex, type Abi, type Hex } from 'viem';
import { RpcResponseError, RpcTransportError, type RpcCaller } from '@palletdock/chain';

export const CONTRACT = '0x5FbDB2315678afecb367f032d93F642f64180aa3';

export const STORAGE_ABI = [
  {
    type: 'event',
    name: 'ValueStored',
    inputs: [
      { name: 'setter', type: 'address', indexed: true },
      { name: 'value', type: 'uint256', indexed: false },
    ],
  },
  { type: 'function', name: 'store', stateMutability: 'nonpayable', inputs: [{ name: 'value', type: 'uint256' }], outputs: [] },
] as const satisfies Abi;

export const SETTER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
export const VALUE_STORED_TOPIC = encodeEventTopics({ abi: STORAGE_ABI, eventName: 'ValueStored' })[0] as Hex;

export interface FakeLog {
  topics: Hex[];
  data: Hex;
  address?: string;
}

export function valueStored(value: bigint): FakeLog {
  return {
    topics: encodeEventTopics({ abi: STORAGE_ABI, eventName: 'ValueStored', args: { setter: SETTER } }) as Hex[],
    data: encodeAbiParameters([{ type: 'uint256' }], [value]),
  };
}

interface Block {
  number: bigint;
  hash: Hex;
  parentHash: Hex;
  logs: FakeLog[];
}

/**
 * Deterministic in-memory chain served over the RpcCaller interface. Supports
 * forks (`reorg`), transport failures, range limits and per-call hooks.
 */
export class FakeChain implements RpcCaller {
  blocks: Block[] = [];
  calls: Array<{ method: string; params: readonly unknown[] }> = [];
  failNext = 0;
  maxLogRange: bigint | null = null;
  /** Height reported by eth_blockNumber; defaults to the tip. Lets tests simulate a lagging node. */
  reportedHead: bigint | null = null;
  onGetLogs?: () => void | Promise<void>;
  private salt = 0;

  constructor(height: number, logs: Record<number, FakeLog[]> = {}) {
    for (let n = 0; n <= height; n++) this.push(logs[n] ?? []);
  }

  get head(): bigint {
    return BigInt(this.blocks.length - 1);
  }

  push(logs: FakeLog[] = []): void {
    const number = BigInt(this.blocks.length);
    const parentHash = number === 0n ? (`0x${'00'.repeat(32)}` as Hex) : this.blocks[Number(number) - 1].hash;
    this.blocks.push({ number, parentHash, hash: keccak256(toHex(`${this.salt}:${number}:${parentHash}`)), logs });
  }

  /** Replace every block from `from` upward with a new branch of the same or given height. */
  reorg(from: number, logs: Record<number, FakeLog[]> = {}, height = Number(this.head)): void {
    this.salt++;
    this.blocks = this.blocks.slice(0, from);
    for (let n = from; n <= height; n++) this.push(logs[n] ?? []);
  }

  hashAt(n: number): Hex {
    return this.blocks[n].hash;
  }

  async call<T>(method: string, params: readonly unknown[] = []): Promise<T> {
    this.calls.push({ method, params });
    if (this.failNext > 0) {
      this.failNext--;
      throw new RpcTransportError(`RPC ${method} returned HTTP 502`, 'http', method, 502);
    }
    switch (method) {
      case 'eth_blockNumber':
        return toHex(this.reportedHead ?? this.head) as T;
      case 'eth_getBlockByNumber': {
        const block = this.blocks[Number(BigInt(params[0] as string))];
        if (!block) return null as T;
        return { number: toHex(block.number), hash: block.hash, parentHash: block.parentHash, timestamp: toHex(1_700_000_000n + block.number * 6n) } as T;
      }
      case 'eth_getLogs': {
        const filter = params[0] as { address: string; fromBlock: Hex; toBlock: Hex; topics?: Array<Hex[] | Hex | null> };
        const from = BigInt(filter.fromBlock);
        const to = BigInt(filter.toBlock);
        if (this.maxLogRange !== null && to - from + 1n > this.maxLogRange) {
          throw new RpcResponseError(`query exceeds max block range ${this.maxLogRange}`, -32005, null, method);
        }
        const topic0 = filter.topics?.[0];
        const wanted = topic0 == null ? null : (Array.isArray(topic0) ? topic0 : [topic0]).map((t) => t.toLowerCase());
        const out: unknown[] = [];
        for (let n = from; n <= to && n <= this.head; n++) {
          const block = this.blocks[Number(n)];
          block.logs.forEach((log, i) => {
            if ((log.address ?? CONTRACT).toLowerCase() !== filter.address.toLowerCase()) return;
            if (wanted && !wanted.includes(log.topics[0]?.toLowerCase())) return;
            out.push({
              address: (log.address ?? CONTRACT).toLowerCase(),
              topics: log.topics,
              data: log.data,
              blockNumber: toHex(n),
              blockHash: block.hash,
              transactionHash: keccak256(toHex(`tx:${block.hash}:${i}`)),
              transactionIndex: toHex(i),
              logIndex: toHex(i),
              removed: false,
            });
          });
        }
        await this.onGetLogs?.();
        return out as T;
      }
      default:
        throw new Error(`FakeChain does not implement ${method}`);
    }
  }
}
