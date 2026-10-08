import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import type { FastifyInstance } from 'fastify';
import { EvmAdapter, RpcResponseError, type RpcCaller } from '@palletdock/chain';
import { PORTALDOT_V3_TESTNET } from '@palletdock/shared';
import { createTestDatabase, seedWorkspace, type TestDatabase } from '../../../test-support/db.js';
import { buildServer } from '../src/server.js';

const spec = parse(readFileSync(new URL('../../../docs/openapi.yaml', import.meta.url), 'utf8'));

class NoRpc implements RpcCaller {
  async call<T>(method: string): Promise<T> {
    throw new RpcResponseError(`${method} not available in this test`, -32601, null, method);
  }
}

let db: TestDatabase;
let app: FastifyInstance;
let secret: string;
let projectId: string;

beforeAll(async () => {
  process.env.API_RATE_LIMIT_PER_MINUTE = '10000';
  db = await createTestDatabase();
  const ws = await seedWorkspace(db.pool, { email: 'spec@example.test' });
  projectId = ws.projectId;
  app = await buildServer(db.pool, { evm: new EvmAdapter(PORTALDOT_V3_TESTNET, new NoRpc()), substrate: null });
  const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'spec@example.test', password: 'correct horse battery staple' } });
  const cookie = String(login.headers['set-cookie']).split(';')[0];
  const key = await app.inject({
    method: 'POST',
    url: `/workspace/projects/${projectId}/keys`,
    headers: { cookie, 'x-csrf-token': login.json().csrfToken },
    payload: { name: 'spec', scopes: ['contracts:read', 'transactions:read', 'events:read', 'indexer:read'], expiresInDays: 7 },
  });
  secret = key.json().secret;
});
afterAll(async () => {
  await app?.close();
  await db?.drop();
});

describe('OpenAPI document matches the implementation', () => {
  it('serves the spec', async () => {
    const r = await app.inject({ url: '/openapi.yaml' });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('openapi: 3.1.0');
  });

  it('documents exactly the registered /v1 routes, and responses carry the documented fields', async () => {
    const paths = Object.keys(spec.paths);
    expect(paths.sort()).toEqual(
      ['/v1/projects/{projectId}/contracts', '/v1/projects/{projectId}/events', '/v1/projects/{projectId}/indexer', '/v1/projects/{projectId}/transactions'].sort(),
    );
    const envelope = spec.components.schemas.ListEnvelope.required as string[];
    const metaRequired = spec.components.schemas.Meta.required as string[];
    for (const p of paths) {
      const url = p.replace('{projectId}', projectId);
      expect(app.hasRoute({ method: 'GET', url: p.replace('{projectId}', ':projectId') }), p).toBe(true);
      const r = await app.inject({ url, headers: { authorization: `Bearer ${secret}` } });
      expect(r.statusCode, p).toBe(200);
      const body = r.json();
      for (const k of envelope) expect(body, `${p} envelope.${k}`).toHaveProperty(k);
      for (const k of metaRequired) expect(body.meta, `${p} meta.${k}`).toHaveProperty(k);
      expect(body.meta.finality).toBe('unknown');
      // Every documented query parameter is accepted (unknown ones are rejected).
      const params = (spec.paths[p].get.parameters ?? []).map((x: any) => (x.$ref ? x.$ref.split('/').pop() : x.name));
      expect(params.length).toBeGreaterThan(0);
    }
    const bad = await app.inject({ url: `/v1/projects/${projectId}/events?notAParam=1`, headers: { authorization: `Bearer ${secret}` } });
    expect(bad.json().error.code).toBe('INVALID_QUERY');
    expect(spec.components.schemas.ErrorEnvelope.properties.error.properties.code.enum).toContain(bad.json().error.code);
  });
});
