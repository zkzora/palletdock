import type { PortaldotNetworkConfig } from '@palletdock/shared';
import { EvmAdapter, type EvmIdentity } from './evm.js';
import { RpcResponseError } from './json-rpc.js';
import { SubstrateAdapter, type SubstrateIdentity } from './substrate.js';

export type CapabilityState = 'supported' | 'unsupported' | 'check_failed';

export interface ProbeResult<T> {
  status: 'responded' | 'failed';
  latencyMs: number;
  observedAt: string;
  value: T | null;
  error: string | null;
}

export async function timedProbe<T>(fn: () => Promise<T>): Promise<ProbeResult<T>> {
  const started = performance.now();
  try {
    return {
      status: 'responded',
      latencyMs: Math.round(performance.now() - started),
      observedAt: new Date().toISOString(),
      value: await fn(),
      error: null,
    };
  } catch (error) {
    return {
      status: 'failed',
      latencyMs: Math.round(performance.now() - started),
      observedAt: new Date().toISOString(),
      value: null,
      error: (error as Error).message,
    };
  }
}

export function capabilityFromError(error: unknown): CapabilityState {
  return error instanceof RpcResponseError && error.code === -32601 ? 'unsupported' : 'check_failed';
}

export async function probeEvm(network: PortaldotNetworkConfig, adapter = new EvmAdapter(network)): Promise<ProbeResult<EvmIdentity>> {
  return timedProbe(() => adapter.identity());
}

export async function probeSubstrate(network: PortaldotNetworkConfig): Promise<ProbeResult<SubstrateIdentity>> {
  const started = performance.now();
  let adapter: SubstrateAdapter | null = null;
  try {
    adapter = await SubstrateAdapter.connect(network);
    const value = await adapter.identity();
    return {
      status: 'responded',
      latencyMs: Math.round(performance.now() - started),
      observedAt: new Date().toISOString(),
      value,
      error: null,
    };
  } catch (error) {
    return {
      status: 'failed',
      latencyMs: Math.round(performance.now() - started),
      observedAt: new Date().toISOString(),
      value: null,
      error: (error as Error).message,
    };
  } finally {
    await adapter?.disconnect().catch(() => {});
  }
}
