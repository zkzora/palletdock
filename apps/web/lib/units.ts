'use client';

import { useResource } from './use-resource';

/**
 * EVM unit policy as reported by the API: verified only when derived from the
 * runtime metadata of the active, verified network fingerprint.
 */
export type EvmUnitPolicy = { status: 'unverified'; reason: string } | { status: 'verified'; decimals: number; symbol: string; evidence: string };

export function useEvmUnitPolicy(): EvmUnitPolicy | null {
  const { data } = useResource<{ data: { evmUnitPolicy?: EvmUnitPolicy } }>('/workspace/network');
  return data?.data.evmUnitPolicy ?? null;
}

/** Short label for raw EVM amount inputs. Unknown policy reads as unverified. */
export function evmUnitLabel(policy: EvmUnitPolicy | null): string {
  return policy?.status === 'verified' ? `EVM base units · ${policy.decimals} decimals (${policy.symbol}, verified)` : 'raw EVM base units (denomination unverified)';
}

/** Longer explanation for unit rows. */
export function evmUnitExplanation(policy: EvmUnitPolicy | null): string {
  if (policy?.status === 'verified') return `EVM values use ${policy.decimals} decimals: ${policy.evidence}.`;
  return `The EVM denomination is not verified${policy ? `: ${policy.reason}` : '.'} Native tPOT decimals (14) are not applied to EVM values.`;
}
