/**
 * Temporary playground workspace limits. Public guest creation is off unless
 * PALLETDOCK_PLAYGROUND_ENABLED=1. Every limit is enforced on the server; the
 * values are read from the environment on each use so a misconfiguration fails
 * at startup (buildServer validates once) and tests can vary them.
 */
import type { PlaygroundTemplateId } from '@palletdock/contracts';

/** An already deployed copy of a template contract that every playground visitor can use. */
export interface SharedContract {
  address: string;
  deployBlock: string;
  deployTxHash: string | null;
}

export interface GuestConfig {
  enabled: boolean;
  /** Fixed workspace and session lifetime; never extended by activity. */
  lifetimeMinutes: number;
  /** Unexpired guest workspaces allowed at once across the deployment. */
  capacity: number;
  /** Guest workspaces one visitor address may start per hour. */
  startsPerHour: number;
  maxContracts: number;
  maxSources: number;
  maxKeys: number;
  /** Mutating or RPC-backed workspace requests per guest workspace. */
  maxActions: number;
  /** Shared template contracts, so visitors can skip deployment (its storage deposit). */
  shared: Partial<Record<PlaygroundTemplateId, SharedContract>>;
}

const SHARED_ENV: Record<PlaygroundTemplateId, string> = {
  storage: 'PALLETDOCK_PLAYGROUND_SHARED_STORAGE',
  payments: 'PALLETDOCK_PLAYGROUND_SHARED_PAYMENTS',
  erc20: 'PALLETDOCK_PLAYGROUND_SHARED_ERC20',
  erc721: 'PALLETDOCK_PLAYGROUND_SHARED_ERC721',
};

/** `0x<address>:<deployBlock>` with an optional `:0x<deployTxHash>`. */
function sharedContract(env: Record<string, string | undefined>, name: string): SharedContract | null {
  const raw = (env[name] ?? '').trim();
  if (!raw) return null;
  const m = /^(0x[0-9a-fA-F]{40}):(0|[1-9][0-9]{0,18})(?::(0x[0-9a-fA-F]{64}))?$/.exec(raw);
  if (!m) throw new Error(`${name} must be 0x<contract address>:<deployment block>, optionally followed by :0x<deployment transaction hash>.`);
  return { address: m[1].toLowerCase(), deployBlock: m[2], deployTxHash: m[3]?.toLowerCase() ?? null };
}

function int(env: Record<string, string | undefined>, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  const n = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  return n;
}

export function resolveGuestConfig(env: Record<string, string | undefined> = process.env): GuestConfig {
  const flag = (env.PALLETDOCK_PLAYGROUND_ENABLED ?? '0').trim();
  if (!['0', '1'].includes(flag)) throw new Error('PALLETDOCK_PLAYGROUND_ENABLED must be 0 or 1.');
  return {
    enabled: flag === '1',
    lifetimeMinutes: int(env, 'PALLETDOCK_PLAYGROUND_LIFETIME_MINUTES', 360, 15, 1440),
    capacity: int(env, 'PALLETDOCK_PLAYGROUND_CAPACITY', 100, 1, 10_000),
    startsPerHour: int(env, 'PALLETDOCK_PLAYGROUND_STARTS_PER_HOUR', 3, 1, 100),
    maxContracts: int(env, 'PALLETDOCK_PLAYGROUND_MAX_CONTRACTS', 2, 1, 10),
    maxSources: int(env, 'PALLETDOCK_PLAYGROUND_MAX_INDEXER_SOURCES', 1, 1, 5),
    maxKeys: int(env, 'PALLETDOCK_PLAYGROUND_MAX_READ_KEYS', 1, 1, 5),
    maxActions: int(env, 'PALLETDOCK_PLAYGROUND_MAX_ACTIONS', 150, 10, 5_000),
    shared: Object.fromEntries(
      Object.entries(SHARED_ENV).flatMap(([id, name]) => {
        const s = sharedContract(env, name);
        return s ? [[id, s]] : [];
      }),
    ),
  };
}
