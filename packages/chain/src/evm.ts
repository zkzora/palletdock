import { getAddress, isAddress, type Hex } from 'viem';
import { toDecimalString, type PortaldotNetworkConfig } from '@palletdock/shared';
import { JsonRpcClient, RpcResponseError, type RpcCaller } from './json-rpc.js';

export interface EvmIdentity {
  chainId: number;
  chainIdHex: Hex;
  /** EVM block 0 hash; null when the node has pruned the state needed to serve it. */
  genesisHash: Hex | null;
  genesisNote: string | null;
  latestBlockNumber: string;
  latestBlockHash: Hex;
  clientVersion: string | null;
}

export interface EvmBlockHeader {
  number: string;
  hash: Hex;
  parentHash: Hex;
  timestamp: string;
}

export interface EvmLog {
  address: string;
  topics: Hex[];
  data: Hex;
  blockNumber: string;
  blockHash: Hex;
  transactionHash: Hex;
  transactionIndex: number;
  logIndex: number;
  removed: boolean;
}

export interface EvmReceipt {
  transactionHash: Hex;
  blockNumber: string;
  blockHash: Hex;
  from: string;
  to: string | null;
  contractAddress: string | null;
  status: 'success' | 'reverted' | 'unknown';
  gasUsed: string;
  effectiveGasPrice: string | null;
  actualFee: string | null;
  logs: EvmLog[];
  raw: Record<string, unknown>;
}

export interface EvmCallRequest {
  from?: string;
  to: string;
  data?: Hex;
  value?: Hex;
}

export interface EvmLogFilter {
  address: string;
  fromBlock: string | bigint;
  toBlock: string | bigint;
  topics?: Array<Hex | Hex[] | null>;
}

function requiredHex(value: unknown, field: string, bytes?: number): Hex {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value) || (bytes !== undefined && value.length !== 2 + bytes * 2)) {
    throw new Error(`RPC response has invalid ${field}`);
  }
  return value as Hex;
}

function requiredData(value: unknown, field: string): Hex {
  if (typeof value !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(value)) throw new Error(`RPC response has invalid ${field}`);
  return value as Hex;
}

function requiredQuantity(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`RPC response has invalid ${field}`);
  const quantity = toDecimalString(value);
  if (quantity === null) throw new Error(`RPC response has missing ${field}`);
  return quantity;
}

function rpcIndex(value: unknown, field: string): number {
  const exact = BigInt(requiredQuantity(value, field));
  if (exact > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`RPC response ${field} exceeds the supported index range`);
  return Number(exact);
}

function address(value: unknown, field: string): string {
  if (typeof value !== 'string' || !isAddress(value, { strict: false })) throw new Error(`RPC response has invalid ${field}`);
  return getAddress(value);
}

export function toBlockTag(value: string | bigint): string {
  if (typeof value === 'bigint') {
    if (value < 0n) throw new Error('Block number cannot be negative');
    return `0x${value.toString(16)}`;
  }
  if (['latest', 'earliest', 'pending', 'safe', 'finalized'].includes(value)) return value;
  if (/^(0|[1-9][0-9]*)$/.test(value)) return `0x${BigInt(value).toString(16)}`;
  if (/^0x[0-9a-fA-F]+$/.test(value)) return value;
  throw new Error(`Invalid block tag: ${value}`);
}

export class EvmAdapter {
  readonly rpc: RpcCaller;

  constructor(
    public readonly network: PortaldotNetworkConfig,
    rpc?: RpcCaller,
  ) {
    this.rpc = rpc ?? new JsonRpcClient(network.evmRpcUrl);
  }

  async identity(): Promise<EvmIdentity> {
    const [chainIdValue, genesis, latest, clientVersion] = await Promise.all([
      this.rpc.call<string>('eth_chainId'),
      // Pruned Revive eth-rpc nodes answer block 0 with a JSON-RPC error ("State already discarded").
      // That is not an identity failure; transport errors still are.
      this.rpc.call<Record<string, unknown>>('eth_getBlockByNumber', ['0x0', false]).catch((e: unknown) => {
        if (e instanceof RpcResponseError) return { __unavailable: e.message.split('\n')[0].slice(0, 300) } as Record<string, unknown>;
        throw e;
      }),
      this.rpc.call<Record<string, unknown>>('eth_getBlockByNumber', ['latest', false]),
      this.rpc.call<string>('web3_clientVersion').catch(() => null),
    ]);
    const chainIdHex = requiredHex(chainIdValue, 'chainId');
    const chainIdBig = BigInt(chainIdHex);
    if (chainIdBig > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('EVM chain ID exceeds the supported numeric range');
    const chainId = Number(chainIdBig);
    if (chainId !== this.network.evmChainId) {
      throw new Error(`EVM network identity mismatch: expected chain ID ${this.network.evmChainId}, received ${chainId}`);
    }
    return {
      chainId,
      chainIdHex,
      genesisHash: genesis && '__unavailable' in genesis ? null : requiredHex(genesis?.hash, 'genesis block hash', 32),
      genesisNote: genesis && '__unavailable' in genesis ? `EVM block 0 unavailable from this node: ${String(genesis.__unavailable)}` : null,
      latestBlockNumber: requiredQuantity(latest?.number, 'latest block number'),
      latestBlockHash: requiredHex(latest?.hash, 'latest block hash', 32),
      clientVersion,
    };
  }

  async blockNumber(): Promise<string> {
    return requiredQuantity(await this.rpc.call<string>('eth_blockNumber'), 'block number');
  }

  async blockHeader(block: string | bigint): Promise<EvmBlockHeader | null> {
    const raw = await this.rpc.call<Record<string, unknown> | null>('eth_getBlockByNumber', [toBlockTag(block), false]);
    if (raw === null) return null;
    return {
      number: requiredQuantity(raw.number, 'block number'),
      hash: requiredHex(raw.hash, 'block hash', 32),
      parentHash: requiredHex(raw.parentHash, 'parent hash', 32),
      timestamp: requiredQuantity(raw.timestamp, 'block timestamp'),
    };
  }

  async codeAt(contractAddress: string, block: string | bigint = 'latest'): Promise<Hex> {
    if (!isAddress(contractAddress, { strict: false })) throw new Error('Invalid contract address');
    const code = await this.rpc.call<unknown>('eth_getCode', [getAddress(contractAddress), toBlockTag(block)]);
    if (typeof code !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(code)) throw new Error('RPC response has invalid contract code');
    return code as Hex;
  }

  async hasRuntimeCode(contractAddress: string, block: string | bigint = 'latest'): Promise<boolean> {
    return (await this.codeAt(contractAddress, block)) !== '0x';
  }

  async call(request: EvmCallRequest, block: string | bigint = 'latest'): Promise<Hex> {
    this.validateCallRequest(request);
    const value = await this.rpc.call<unknown>('eth_call', [request, toBlockTag(block)]);
    if (typeof value !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(value)) throw new Error('RPC response has invalid call data');
    return value as Hex;
  }

  /** Estimate gas; `to` may be omitted for contract creation. */
  async estimateGas(request: Omit<EvmCallRequest, 'to'> & { to?: string }): Promise<string> {
    this.validateCallRequest(request, true);
    return requiredQuantity(await this.rpc.call<unknown>('eth_estimateGas', [request]), 'gas estimate');
  }

  async gasPrice(): Promise<string> {
    return requiredQuantity(await this.rpc.call<unknown>('eth_gasPrice'), 'gas price');
  }

  async receipt(transactionHash: string): Promise<EvmReceipt | null> {
    requiredHex(transactionHash, 'transaction hash', 32);
    const raw = await this.rpc.call<Record<string, unknown> | null>('eth_getTransactionReceipt', [transactionHash]);
    if (raw === null) return null;
    const gasUsed = requiredQuantity(raw.gasUsed, 'gas used');
    const effectiveGasPrice = raw.effectiveGasPrice == null ? null : requiredQuantity(raw.effectiveGasPrice, 'effective gas price');
    const statusRaw = raw.status == null ? null : requiredQuantity(raw.status, 'receipt status');
    return {
      transactionHash: requiredHex(raw.transactionHash, 'transaction hash', 32),
      blockNumber: requiredQuantity(raw.blockNumber, 'receipt block number'),
      blockHash: requiredHex(raw.blockHash, 'receipt block hash', 32),
      from: address(raw.from, 'sender'),
      to: raw.to == null ? null : address(raw.to, 'recipient'),
      contractAddress: raw.contractAddress == null ? null : address(raw.contractAddress, 'contract address'),
      status: statusRaw === '1' ? 'success' : statusRaw === '0' ? 'reverted' : 'unknown',
      gasUsed,
      effectiveGasPrice,
      actualFee: effectiveGasPrice === null ? null : (BigInt(gasUsed) * BigInt(effectiveGasPrice)).toString(10),
      logs: Array.isArray(raw.logs) ? raw.logs.map((log) => normalizeLog(log)) : [],
      raw,
    };
  }

  async logs(filter: EvmLogFilter): Promise<EvmLog[]> {
    if (!isAddress(filter.address, { strict: false })) throw new Error('Invalid log contract address');
    const raw = await this.rpc.call<unknown>('eth_getLogs', [
      {
        address: getAddress(filter.address),
        fromBlock: toBlockTag(filter.fromBlock),
        toBlock: toBlockTag(filter.toBlock),
        ...(filter.topics ? { topics: filter.topics } : {}),
      },
    ]);
    if (!Array.isArray(raw)) throw new Error('RPC response has invalid logs result');
    return raw.map(normalizeLog);
  }

  private validateCallRequest(request: Omit<EvmCallRequest, 'to'> & { to?: string }, allowCreate = false): void {
    if (request.to === undefined ? !allowCreate : !isAddress(request.to, { strict: false })) throw new Error('Invalid call destination');
    if (request.from && !isAddress(request.from, { strict: false })) throw new Error('Invalid call sender');
    if (request.data && !/^0x([0-9a-fA-F]{2})*$/.test(request.data)) throw new Error('Invalid call data');
    if (request.value && !/^0x[0-9a-fA-F]+$/.test(request.value)) throw new Error('Invalid call value');
  }
}

function normalizeLog(value: unknown): EvmLog {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('RPC response has an invalid log entry');
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.topics)) throw new Error('RPC response has invalid log topics');
  return {
    address: address(raw.address, 'log address'),
    topics: raw.topics.map((topic, i) => requiredHex(topic, `log topic ${i}`, 32)),
    data: requiredData(raw.data, 'log data'),
    blockNumber: requiredQuantity(raw.blockNumber, 'log block number'),
    blockHash: requiredHex(raw.blockHash, 'log block hash', 32),
    transactionHash: requiredHex(raw.transactionHash, 'log transaction hash', 32),
    transactionIndex: rpcIndex(raw.transactionIndex, 'log transaction index'),
    logIndex: rpcIndex(raw.logIndex, 'log index'),
    removed: raw.removed === true,
  };
}
