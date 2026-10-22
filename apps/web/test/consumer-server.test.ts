import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FetchLike } from '../lib/consumer/core';
import { consumerIsPublic, consumerState, loadConsumerConfig, ownerSession, publicConfig, sharedConsumerState, type ConsumerConfig, type StateResponse } from '../lib/consumer/server';

const PROJECT = '3570d90a-c165-4041-aee3-c93f174f1d0a';
const KEY = 'pd_live_abc123.verysecretpart_1234567890';
const missingFile = path.join(tmpdir(), 'palletdock-no-such-consumer.json');

describe('consumer configuration stays server-side', () => {
  it('reads env first, then the config file, and is absent when neither exists', async () => {
    const fromEnv = await loadConsumerConfig({ PALLETDOCK_CONSUMER_PROJECT_ID: PROJECT, PALLETDOCK_CONSUMER_READ_KEY: KEY, PALLETDOCK_CONSUMER_CONFIG: missingFile });
    expect(fromEnv).toMatchObject({ projectId: PROJECT, source: 'env', event: 'NumberChanged', apiUrl: 'http://127.0.0.1:4101' });

    const dir = mkdtempSync(path.join(tmpdir(), 'pd-consumer-'));
    const file = path.join(dir, 'consumer.json');
    writeFileSync(file, JSON.stringify({ projectId: PROJECT, readKey: KEY, apiUrl: 'http://127.0.0.1:4199', contract: '0xdd982913cb04f9e438437e2137ba1452e4b211ed' }));
    const fromFile = await loadConsumerConfig({ PALLETDOCK_CONSUMER_CONFIG: file });
    expect(fromFile).toMatchObject({ source: 'file', apiUrl: 'http://127.0.0.1:4199' });

    expect(await loadConsumerConfig({ PALLETDOCK_CONSUMER_CONFIG: missingFile })).toBeNull();
  });

  it('rejects malformed values', async () => {
    await expect(loadConsumerConfig({ PALLETDOCK_CONSUMER_PROJECT_ID: 'nope', PALLETDOCK_CONSUMER_READ_KEY: KEY })).rejects.toThrow(/project UUID/);
    await expect(loadConsumerConfig({ PALLETDOCK_CONSUMER_PROJECT_ID: PROJECT, PALLETDOCK_CONSUMER_READ_KEY: 'abc' })).rejects.toThrow(/read key/);
  });

  it('exposes only the key prefix, never the key, including in error messages', async () => {
    const cfg = (await loadConsumerConfig({ PALLETDOCK_CONSUMER_PROJECT_ID: PROJECT, PALLETDOCK_CONSUMER_READ_KEY: KEY }))!;
    expect(JSON.stringify(publicConfig(cfg))).not.toContain('verysecretpart');
    expect(publicConfig(cfg).keyPrefix).toBe('pd_live_abc123');
    const echoing: FetchLike = async () => ({ status: 500, json: async () => ({ error: { code: 'INTERNAL', message: `upstream saw ${KEY}` } }) });
    const r = await consumerState(cfg, echoing);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain('verysecretpart');
    expect(JSON.stringify(r)).toContain('[redacted]');
  });
});

describe('owner session check', () => {
  const answer = (status: number) => (async () => new Response('{}', { status })) as unknown as typeof fetch;
  it('accepts only a signed-in owner and tells an unreachable API apart from anonymous', async () => {
    expect(await ownerSession(null, 'http://api.test', answer(200))).toBe('anonymous');
    expect(await ownerSession('pd_session=x', 'http://api.test', answer(200))).toBe('owner');
    expect(await ownerSession('pd_session=x', 'http://api.test', answer(401))).toBe('anonymous');
    const down = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    expect(await ownerSession('pd_session=x', 'http://api.test', down)).toBe('unreachable');
  });
});

describe('public consumer access', () => {
  it('is off by default and accepts only an explicit 1', () => {
    expect(consumerIsPublic({})).toBe(false);
    expect(consumerIsPublic({ PALLETDOCK_CONSUMER_PUBLIC: '0' })).toBe(false);
    expect(consumerIsPublic({ PALLETDOCK_CONSUMER_PUBLIC: 'true' })).toBe(false);
    expect(consumerIsPublic({ PALLETDOCK_CONSUMER_PUBLIC: '1' })).toBe(true);
  });
});

describe('shared reads for public viewers', () => {
  const config: ConsumerConfig = { apiUrl: 'http://api.test', projectId: PROJECT, readKey: KEY, event: 'NumberChanged', source: 'env' };
  const answer = (n: number): StateResponse => ({ ok: false, config: null, error: { code: 'X', message: String(n), status: null }, at: new Date(0).toISOString() });

  it('serves many concurrent viewers from one upstream read per window, then reads again', async () => {
    // Every public viewer polls every 5 s; without sharing, a handful of viewers exceeds the API's per-IP limit.
    let reads = 0;
    let now = 1_000;
    const read = async () => answer(++reads);
    const cache = new Map();
    const opts = { ttlMs: 4_000, now: () => now, read, cache };
    const first = await Promise.all(Array.from({ length: 20 }, () => sharedConsumerState(config, opts)));
    expect(reads).toBe(1);
    expect(new Set(first.map((r) => (r.ok ? '' : r.error.message)))).toEqual(new Set(['1']));
    now += 3_999;
    await sharedConsumerState(config, opts);
    expect(reads).toBe(1);
    now += 2;
    const later = await sharedConsumerState(config, opts);
    expect(reads).toBe(2);
    expect(later.ok ? '' : later.error.message).toBe('2');
  });

  it('keeps separate entries per configured project, contract, and event', async () => {
    let reads = 0;
    const opts = { ttlMs: 4_000, now: () => 0, read: async () => answer(++reads), cache: new Map() };
    await sharedConsumerState(config, opts);
    await sharedConsumerState({ ...config, event: 'Other' }, opts);
    await sharedConsumerState({ ...config, contract: '0xdd982913cb04f9e438437e2137ba1452e4b211ed' }, opts);
    expect(reads).toBe(3);
  });
});
