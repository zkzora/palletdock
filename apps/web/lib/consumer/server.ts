import path from 'node:path';
import { ConsumerApiError, readSnapshot, type FetchLike, type Snapshot } from './core';

/**
 * Server-only part of the consumer demo. The read key lives in server env or a
 * gitignored file and is used only here; responses carry derived data and the
 * key's public prefix, never the key. Import this module only from route handlers.
 */

export interface ConsumerConfig {
  apiUrl: string;
  projectId: string;
  readKey: string;
  event: string;
  contract?: string;
  source: 'env' | 'file';
}

export interface PublicConsumerConfig {
  projectId: string;
  event: string;
  contract: string | null;
  apiOrigin: string;
  keyPrefix: string;
  source: 'env' | 'file';
}

/** Environment-like map (process.env or a test object). */
type Env = Record<string, string | undefined>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^pd_live_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** API the web app itself talks to (same default as next.config.ts). */
export function workspaceApiUrl(env: Env = process.env): string {
  return env.PALLETDOCK_API_URL ?? 'http://127.0.0.1:4101';
}

/** Public access is opt-in and affects only the read-only consumer demo. */
export function consumerIsPublic(env: Env = process.env): boolean {
  return env.PALLETDOCK_CONSUMER_PUBLIC === '1';
}

/** The config path is only known at runtime, so keep this read out of build-time file tracing. */
async function readConfigFile(file: string): Promise<string> {
  const { readFile } = await import(/* turbopackIgnore: true */ 'node:fs/promises');
  return readFile(file, 'utf8');
}

export function defaultConfigPath(env: Env = process.env): string {
  return env.PALLETDOCK_CONSUMER_CONFIG ?? path.resolve(process.cwd(), '../../.data/consumer.json');
}

/** Env (PALLETDOCK_CONSUMER_PROJECT_ID + PALLETDOCK_CONSUMER_READ_KEY) wins; otherwise the config file. Null when not configured. */
export async function loadConsumerConfig(env: Env = process.env): Promise<ConsumerConfig | null> {
  let raw: Record<string, unknown> | null = null;
  let source: 'env' | 'file' = 'env';
  if (env.PALLETDOCK_CONSUMER_PROJECT_ID && env.PALLETDOCK_CONSUMER_READ_KEY) {
    raw = { projectId: env.PALLETDOCK_CONSUMER_PROJECT_ID, readKey: env.PALLETDOCK_CONSUMER_READ_KEY, event: env.PALLETDOCK_CONSUMER_EVENT, contract: env.PALLETDOCK_CONSUMER_CONTRACT };
  } else {
    try {
      raw = JSON.parse(await readConfigFile(defaultConfigPath(env)));
      source = 'file';
    } catch {
      return null;
    }
  }
  const apiUrl = String(raw?.apiUrl ?? env.PALLETDOCK_CONSUMER_API_URL ?? workspaceApiUrl(env));
  const projectId = String(raw?.projectId ?? '');
  const readKey = String(raw?.readKey ?? '');
  const contract = raw?.contract ? String(raw.contract) : undefined;
  if (!UUID.test(projectId)) throw new Error('Consumer config: projectId must be a project UUID.');
  if (!KEY.test(readKey)) throw new Error('Consumer config: readKey must be a PalletDock read key (pd_live_…).');
  if (contract && !ADDRESS.test(contract)) throw new Error('Consumer config: contract must be a 20-byte address.');
  if (!/^https?:\/\//.test(apiUrl)) throw new Error('Consumer config: apiUrl must be an http(s) URL.');
  return { apiUrl, projectId, readKey, event: raw?.event ? String(raw.event) : 'NumberChanged', contract, source };
}

export function publicConfig(c: ConsumerConfig): PublicConsumerConfig {
  return { projectId: c.projectId, event: c.event, contract: c.contract ?? null, apiOrigin: new URL(c.apiUrl).origin, keyPrefix: c.readKey.split('.')[0], source: c.source };
}

/**
 * Private demos follow the workspace's own auth and answer only a signed-in account session.
 * A temporary playground guest is authenticated too, but is not the operator: it reads as anonymous.
 */
export async function ownerSession(cookie: string | null, apiUrl: string, fetchImpl: typeof fetch = fetch): Promise<'owner' | 'anonymous' | 'unreachable'> {
  if (!cookie) return 'anonymous';
  try {
    const r = await fetchImpl(`${apiUrl.replace(/\/$/, '')}/auth/me`, { headers: { cookie }, signal: AbortSignal.timeout(10_000) });
    if (r.status !== 200) return 'anonymous';
    const body = (await r.json().catch(() => null)) as { session?: { kind?: string } } | null;
    return body?.session?.kind === 'account' ? 'owner' : 'anonymous';
  } catch {
    return 'unreachable';
  }
}

export type StateResponse =
  | { ok: true; config: PublicConsumerConfig; snapshot: Snapshot }
  | { ok: false; config: PublicConsumerConfig | null; error: { code: string; message: string; status: number | null }; at: string };

/** One read of the public /v1 API for the configured project. Never includes the key. */
export async function consumerState(config: ConsumerConfig, fetchImpl: FetchLike = fetch as unknown as FetchLike): Promise<StateResponse> {
  try {
    const snapshot = await readSnapshot({ apiUrl: config.apiUrl, projectId: config.projectId, readKey: config.readKey, event: config.event, contract: config.contract, fetch: fetchImpl });
    return { ok: true, config: publicConfig(config), snapshot };
  } catch (e) {
    const err = e instanceof ConsumerApiError ? e : new ConsumerApiError((e as Error).message, 'CONSUMER_ERROR', null);
    // Defence in depth: never echo the key, even if an upstream message contained it.
    const message = err.message.split(config.readKey).join('[redacted]');
    return { ok: false, config: publicConfig(config), error: { code: err.code, message, status: err.status }, at: new Date().toISOString() };
  }
}

type SharedOptions = { ttlMs?: number; now?: () => number; read?: (config: ConsumerConfig) => Promise<StateResponse>; cache?: Map<string, { at: number; state: Promise<StateResponse> }> };
const sharedCache = new Map<string, { at: number; state: Promise<StateResponse> }>();

/**
 * Public mode: every viewer polls, but all of them reach the API from this server's address, which the API
 * rate-limits per IP. Viewers inside one window share a single upstream read (in-flight requests included),
 * so the load on the API does not grow with the audience. Per server instance; the page polls every 5 s.
 */
export function sharedConsumerState(config: ConsumerConfig, o: SharedOptions = {}): Promise<StateResponse> {
  const { ttlMs = 4_000, now = Date.now, read = (c: ConsumerConfig) => consumerState(c), cache = sharedCache } = o;
  const key = [config.apiUrl, config.projectId, config.contract ?? '', config.event].join('|');
  const hit = cache.get(key);
  if (hit && now() - hit.at < ttlMs) return hit.state;
  const state = read(config);
  cache.set(key, { at: now(), state });
  return state;
}
