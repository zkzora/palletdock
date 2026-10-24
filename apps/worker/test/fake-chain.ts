import { createHash } from 'node:crypto';
import { hexToBytes, keccak256, toHex, type Hex } from 'viem';
import { RpcResponseError, RpcTransportError, type RpcCaller } from '@palletdock/chain';

export interface FakeLog {
  address: string;
  topics: string[];
  data: string;
  txHash?: string;
}

interface Block {
  number: number;
  hash: string;
  parentHash: string;
  timestamp: number;
  logs: FakeLog[];
}

const h = (s: string) => '0x' + createHash('sha256').update(s).digest('hex');

/** Ethereum 2048-bit logs bloom over each log's address and topics. */
function bloomOf(logs: FakeLog[]): Hex {
  const bloom = new Uint8Array(256);
  for (const l of logs) {
    for (const item of [l.address, ...l.topics]) {
      const d = hexToBytes(keccak256(item as Hex));
      for (const i of [0, 2, 4]) {
        const bit = ((d[i] << 8) | d[i + 1]) & 2047;
        bloom[255 - Math.floor(bit / 8)] |= 1 << bit % 8;
      }
    }
  }
  return toHex(bloom);
}

/**
 * Deterministic in-memory EVM JSON-RPC used for indexer tests. It is a test
 * fixture only and is never wired into the running worker.
 */
export class FakeChain implements RpcCaller {
  blocks: Block[] = [];
  maxLogRange = Infinity;
  /** Simulate a state-pruning node: headers below this height cannot be served. */
  prunedBelow = 0;
  calls: string[] = [];
  private failures: Array<() => Error> = [];
  onGetLogs?: (from: number, to: number) => Promise<void> | void;
  /** Per block: how many more eth_getLogs calls omit its logs (a node whose log index lags its head). */
  private hiddenLogs = new Map<number, number>();
  /** Per block: bloom entries that have no matching log (a bloom false positive). */
  bloomOnly = new Map<number, FakeLog[]>();
  private salt = 0;

  constructor(height: number) {
    for (let i = 0; i <= height; i++) this.push([]);
  }

  private push(logs: FakeLog[]) {
    const n = this.blocks.length;
    const parent = n === 0 ? '0x' + '00'.repeat(32) : this.blocks[n - 1].hash;
    this.blocks.push({ number: n, hash: h(`block:${n}:${this.salt}:${parent}`), parentHash: parent, timestamp: 1_700_000_000 + n * 6, logs });
  }

  get head() {
    return this.blocks.length - 1;
  }

  /** Append a block containing the given logs. Returns its number. */
  mine(logs: FakeLog[] = []): number {
    this.push(logs);
    return this.head;
  }

  mineEmpty(count: number) {
    for (let i = 0; i < count; i++) this.push([]);
  }

  /** Replace blocks from `fromNumber` onward with a new branch of the same or given length. */
  reorg(fromNumber: number, replacement: FakeLog[][]) {
    this.salt++;
    this.blocks = this.blocks.slice(0, fromNumber);
    for (const logs of replacement) this.push(logs);
  }

  /** The next `times` eth_getLogs calls covering this block return none of its logs. */
  delayLogs(block: number, times: number) {
    this.hiddenLogs.set(block, times);
  }

  failNext(count: number, make: () => Error = () => new RpcTransportError('RPC connection closed before response', 'network', 'fake')) {
    for (let i = 0; i < count; i++) this.failures.push(make);
  }

  async call<T>(method: string, params: readonly unknown[] = []): Promise<T> {
    this.calls.push(method);
    const f = this.failures.shift();
    if (f) throw f();
    switch (method) {
      case 'eth_chainId':
        return '0x190f1ca9' as T;
      case 'eth_blockNumber':
        return ('0x' + this.head.toString(16)) as T;
      case 'eth_getBlockByNumber': {
        const tag = params[0] as string;
        const n = tag === 'latest' ? this.head : Number(BigInt(tag));
        if (n < this.prunedBelow) throw new RpcResponseError(`Cannot construct OnlineClientAtBlock: UnknownBlock: State already discarded for block ${n}`, -32000, null, method);
        const b = this.blocks[n];
        if (!b) return null as T;
        return { number: '0x' + b.number.toString(16), hash: b.hash, parentHash: b.parentHash, timestamp: '0x' + b.timestamp.toString(16), logsBloom: bloomOf([...b.logs, ...(this.bloomOnly.get(n) ?? [])]) } as T;
      }
      case 'eth_getLogs': {
        const q = params[0] as { address: string; fromBlock: string; toBlock: string; topics?: (string[] | string | null)[] };
        const from = Number(BigInt(q.fromBlock));
        const to = Number(BigInt(q.toBlock));
        if (to - from + 1 > this.maxLogRange) throw new RpcResponseError('query exceeds max block range', -32005, null, method);
        await this.onGetLogs?.(from, to);
        const t0 = q.topics?.[0];
        const allowed = t0 == null ? null : (Array.isArray(t0) ? t0 : [t0]).map((x) => x.toLowerCase());
        const out: unknown[] = [];
        for (let n = from; n <= Math.min(to, this.head); n++) {
          const b = this.blocks[n];
          const hidden = this.hiddenLogs.get(n) ?? 0;
          if (hidden > 0) {
            this.hiddenLogs.set(n, hidden - 1);
            continue;
          }
          b.logs.forEach((l, i) => {
            if (l.address.toLowerCase() !== q.address.toLowerCase()) return;
            if (allowed && !allowed.includes((l.topics[0] ?? '').toLowerCase())) return;
            out.push({
              address: l.address,
              topics: l.topics,
              data: l.data,
              blockNumber: '0x' + n.toString(16),
              blockHash: b.hash,
              transactionHash: l.txHash ?? h(`tx:${b.hash}:${i}`),
              transactionIndex: '0x' + i.toString(16),
              logIndex: '0x' + i.toString(16),
              removed: false,
            });
          });
        }
        return out as T;
      }
      default:
        throw new RpcResponseError(`Method ${method} not found`, -32601, null, method);
    }
  }
}
