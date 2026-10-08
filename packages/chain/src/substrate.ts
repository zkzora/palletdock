import { ApiPromise, WsProvider } from '@polkadot/api';
import type { ApiOptions } from '@polkadot/api/types';
import { hexToU8a, u8aToHex } from '@polkadot/util';
import { encodeAddress } from '@polkadot/util-crypto';
import { getAddress, isAddress } from 'viem';
import type { PortaldotNetworkConfig } from '@palletdock/shared';

export interface SubstrateIdentity {
  genesisHash: string;
  bestBlockNumber: string;
  bestBlockHash: string;
  finalizedBlockHash: string;
  specName: string;
  specVersion: string;
  transactionVersion: string;
  ss58Format: number | null;
  tokenSymbols: string[];
  tokenDecimals: number[];
}

export interface AccountMapping {
  evmAddress: string;
  nativeAccountHex: string;
  nativeSs58: string;
  blockNumber: string;
  blockHash: string;
  specVersion: string;
  method: 'reviveApi.accountId';
}

export interface StorageDepositEstimate {
  status: 'estimated';
  kind: 'charge' | 'refund';
  amountRaw: string;
  unit: 'native base units';
  method: string;
  blockHash: string;
  specVersion: string;
  weightRequired: unknown;
  dispatchOk: boolean;
}

export interface UnavailableEstimate {
  status: 'unavailable';
  reason: string;
}

type CodecLike = {
  isSome?: boolean;
  unwrap?: () => CodecLike;
  toHex?: () => string;
  toU8a?: () => Uint8Array;
};

/** Decode the runtime call result without assuming whether metadata wraps it in Option. */
export function mappedAccountBytes(value: CodecLike): Uint8Array {
  if (value?.isSome === false) throw new Error('The runtime returned no native account mapping for this EVM address');
  const inner = value?.isSome === true && typeof value.unwrap === 'function' ? value.unwrap() : value;
  const bytes = typeof inner?.toU8a === 'function' ? inner.toU8a() : typeof inner?.toHex === 'function' ? hexToU8a(inner.toHex()) : null;
  if (!bytes || bytes.length !== 32) throw new Error(`reviveApi.accountId returned ${bytes?.length ?? 0} bytes; expected AccountId32`);
  return bytes;
}

export class SubstrateAdapter {
  private constructor(
    public readonly network: PortaldotNetworkConfig,
    public readonly api: ApiPromise,
  ) {}

  static async connect(network: PortaldotNetworkConfig, options: Partial<ApiOptions> = {}, timeoutMs = 15_000): Promise<SubstrateAdapter> {
    const provider = options.provider ?? new WsProvider(network.substrateRpcUrl, 5_000);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const api = await Promise.race([
        ApiPromise.create({ noInitWarn: true, ...options, provider }),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error(`Substrate connection timed out after ${timeoutMs} ms`)), timeoutMs);
        }),
      ]);
      await api.isReadyOrError;
      return new SubstrateAdapter(network, api);
    } catch (error) {
      await provider.disconnect().catch(() => {});
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  async disconnect(): Promise<void> {
    await this.api.disconnect();
  }

  async identity(): Promise<SubstrateIdentity> {
    const [best, finalizedHash, properties] = await Promise.all([
      this.api.rpc.chain.getHeader(),
      this.api.rpc.chain.getFinalizedHead(),
      this.api.rpc.system.properties(),
    ]);
    const runtime = this.api.runtimeVersion;
    const props = properties.toJSON() as { ss58Format?: number | null; tokenSymbol?: string[] | string | null; tokenDecimals?: number[] | number | null };
    const tokenSymbols = props.tokenSymbol == null ? [] : Array.isArray(props.tokenSymbol) ? props.tokenSymbol.map(String) : [String(props.tokenSymbol)];
    const tokenDecimals = props.tokenDecimals == null ? [] : Array.isArray(props.tokenDecimals) ? props.tokenDecimals.map(Number) : [Number(props.tokenDecimals)];
    const identity: SubstrateIdentity = {
      genesisHash: this.api.genesisHash.toHex(),
      bestBlockNumber: best.number.toString(),
      bestBlockHash: best.hash.toHex(),
      finalizedBlockHash: finalizedHash.toHex(),
      specName: runtime.specName.toString(),
      specVersion: runtime.specVersion.toString(),
      transactionVersion: runtime.transactionVersion.toString(),
      ss58Format: props.ss58Format == null ? null : Number(props.ss58Format),
      tokenSymbols,
      tokenDecimals,
    };
    if (identity.ss58Format !== null && identity.ss58Format !== this.network.ss58Format) {
      throw new Error(`Native network identity mismatch: expected SS58 ${this.network.ss58Format}, received ${identity.ss58Format}`);
    }
    if (identity.tokenSymbols.length && !identity.tokenSymbols.includes(this.network.nativeTokenSymbol)) {
      throw new Error(`Native network identity mismatch: expected token ${this.network.nativeTokenSymbol}, received ${identity.tokenSymbols.join(', ')}`);
    }
    if (identity.tokenDecimals.length && !identity.tokenDecimals.includes(this.network.nativeTokenDecimals)) {
      throw new Error(`Native network identity mismatch: expected ${this.network.nativeTokenDecimals} token decimals, received ${identity.tokenDecimals.join(', ')}`);
    }
    return identity;
  }

  async mapEvmAccount(evmAddress: string, atBlockHash?: string): Promise<AccountMapping> {
    if (!isAddress(evmAddress, { strict: false })) throw new Error('Enter a 20-byte EVM address');
    const blockHash = atBlockHash ?? (await this.api.rpc.chain.getFinalizedHead()).toHex();
    if (!/^0x[0-9a-fA-F]{64}$/.test(blockHash)) throw new Error('Invalid native block hash');
    const [at, header, runtime] = await Promise.all([
      this.api.at(blockHash),
      this.api.rpc.chain.getHeader(blockHash),
      this.api.rpc.state.getRuntimeVersion(blockHash),
    ]);
    const calls = at.call as unknown as Record<string, Record<string, (...args: unknown[]) => Promise<CodecLike>>>;
    const accountId = calls.reviveApi?.accountId;
    if (typeof accountId !== 'function') throw new Error('The connected runtime does not expose reviveApi.accountId');
    const bytes = mappedAccountBytes(await accountId(evmAddress));
    return {
      evmAddress: getAddress(evmAddress),
      nativeAccountHex: u8aToHex(bytes),
      nativeSs58: encodeAddress(bytes, this.network.ss58Format),
      blockNumber: header.number.toString(),
      blockHash,
      specVersion: runtime.specVersion.toString(),
      method: 'reviveApi.accountId',
    };
  }

  /**
   * Dry-run a Revive call or instantiation through the runtime API exposed by
   * current metadata and read the storage deposit it reports. Parameters are
   * mapped by name; an unrecognized signature yields "unavailable" rather than
   * a guessed encoding.
   */
  async dryRunStorageDeposit(req: {
    kind: 'call' | 'instantiate';
    originAccountHex: string;
    dest?: string;
    input: string;
    code?: string;
  }): Promise<StorageDepositEstimate | UnavailableEstimate> {
    try {
      const blockHash = (await this.api.rpc.chain.getFinalizedHead()).toHex();
      const at = await this.api.at(blockHash);
      const runtime = await this.api.rpc.state.getRuntimeVersion(blockHash);
      const calls = at.call as unknown as Record<string, Record<string, ((...args: unknown[]) => Promise<{ toJSON(): unknown }>) & { meta?: { params?: Array<{ name: { toString(): string } }> } }>>;
      const fn = calls.reviveApi?.[req.kind];
      if (typeof fn !== 'function') return { status: 'unavailable', reason: `The connected runtime does not expose reviveApi.${req.kind} in its metadata.` };
      const names = (fn.meta?.params ?? []).map((p) => p.name.toString().replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()));
      if (!names.length) return { status: 'unavailable', reason: `reviveApi.${req.kind} parameter metadata is unavailable.` };
      const byName: Record<string, unknown> = {
        origin: req.originAccountHex,
        dest: req.dest,
        value: 0,
        gasLimit: null,
        storageDepositLimit: null,
        inputData: req.input,
        data: req.input,
        code: req.code ? { Upload: req.code } : undefined,
        salt: null,
      };
      const args: unknown[] = [];
      for (const n of names) {
        if (!(n in byName) || byName[n] === undefined) return { status: 'unavailable', reason: `reviveApi.${req.kind} has an unrecognized parameter "${n}" (runtime ${runtime.specVersion.toString()}).` };
        args.push(byName[n]);
      }
      const out = (await fn(...args)).toJSON() as Record<string, any>;
      const sd = out?.storageDeposit ?? out?.storage_deposit;
      const kind = sd && ('charge' in sd || 'Charge' in sd) ? 'charge' : sd && ('refund' in sd || 'Refund' in sd) ? 'refund' : null;
      if (!kind) return { status: 'unavailable', reason: 'The dry-run result did not include a storage deposit field.' };
      const raw = sd.charge ?? sd.Charge ?? sd.refund ?? sd.Refund;
      const amountRaw = typeof raw === 'string' && raw.startsWith('0x') ? BigInt(raw).toString() : BigInt(String(raw)).toString();
      const result = out?.result ?? {};
      return {
        status: 'estimated',
        kind,
        amountRaw,
        unit: 'native base units',
        method: `reviveApi.${req.kind}`,
        blockHash,
        specVersion: runtime.specVersion.toString(),
        weightRequired: out?.weightRequired ?? out?.gasRequired ?? null,
        dispatchOk: 'ok' in result || 'Ok' in result,
      };
    } catch (e) {
      return { status: 'unavailable', reason: `Dry run failed: ${(e as Error).message.split('\n')[0]}` };
    }
  }
}
