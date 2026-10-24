import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createTestDatabase, type TestDatabase } from '../../../test-support/db.js';
import { CLIENT_IP_HEADER, PROXY_SECRET_HEADER, clientIp, proxySecret } from '../src/client-ip.js';
import { buildServer } from '../src/server.js';

const SECRET = 'proxy-secret-for-tests-0123456789abcdef';
const fakeRequest = (headers: Record<string, string>, ip = '10.0.0.1') => ({ headers, ip }) as unknown as FastifyRequest;

describe('visitor address behind the web proxy', () => {
  it('uses the forwarded address only with the shared secret and a valid IP', () => {
    expect(clientIp(fakeRequest({ [CLIENT_IP_HEADER]: '203.0.113.7', [PROXY_SECRET_HEADER]: SECRET }), SECRET)).toBe('203.0.113.7');
    expect(clientIp(fakeRequest({ [CLIENT_IP_HEADER]: '2001:db8::7', [PROXY_SECRET_HEADER]: SECRET }), SECRET)).toBe('2001:db8::7');
    expect(clientIp(fakeRequest({ [CLIENT_IP_HEADER]: '203.0.113.7', [PROXY_SECRET_HEADER]: 'wrong' }), SECRET)).toBe('10.0.0.1');
    expect(clientIp(fakeRequest({ [CLIENT_IP_HEADER]: '203.0.113.7' }), SECRET)).toBe('10.0.0.1');
    expect(clientIp(fakeRequest({ [CLIENT_IP_HEADER]: 'not-an-ip', [PROXY_SECRET_HEADER]: SECRET }), SECRET)).toBe('10.0.0.1');
    // Without a configured secret the header is never trusted.
    expect(clientIp(fakeRequest({ [CLIENT_IP_HEADER]: '203.0.113.7', [PROXY_SECRET_HEADER]: SECRET }), null)).toBe('10.0.0.1');
  });

  it('requires a long secret when one is set', () => {
    expect(proxySecret({})).toBeNull();
    expect(() => proxySecret({ PALLETDOCK_PROXY_SECRET: 'short' })).toThrow(/at least 32/);
    expect(proxySecret({ PALLETDOCK_PROXY_SECRET: SECRET })).toBe(SECRET);
  });
});

describe('per-visitor limits through the proxy (all requests share one connection address)', () => {
  let db: TestDatabase;
  let app: FastifyInstance;
  const saved = { ...process.env };

  beforeAll(async () => {
    process.env.PALLETDOCK_PROXY_SECRET = SECRET;
    process.env.PALLETDOCK_SIGNUP_MODE = 'invite';
    process.env.PALLETDOCK_SIGNUP_INVITE_CODE = 'invite-code-for-tests-0123';
    process.env.PALLETDOCK_SIGNUP_RATE_LIMIT_PER_15_MINUTES = '5';
    db = await createTestDatabase();
    app = await buildServer(db.pool, { substrate: null, devControls: false });
  });
  afterAll(async () => {
    await app?.close();
    await db?.drop();
    process.env = saved;
  });

  const via = (ip: string, secret = SECRET) => ({ [CLIENT_IP_HEADER]: ip, [PROXY_SECRET_HEADER]: secret });
  let n = 0;
  const login = (headers: Record<string, string>) =>
    app.inject({ method: 'POST', url: '/auth/login', headers, payload: { email: `nobody${++n}@example.test`, password: 'wrong password!!' } });
  const signup = (headers: Record<string, string>) =>
    app.inject({ method: 'POST', url: '/auth/signup', headers, payload: { email: `judge${++n}@example.test`, password: 'correct horse battery staple', inviteCode: 'not-the-code-0000' } });

  it('one visitor exhausting sign-in attempts does not lock out another visitor', async () => {
    for (let i = 0; i < 10; i++) expect((await login(via('198.51.100.1'))).statusCode).toBe(401);
    expect((await login(via('198.51.100.1'))).statusCode).toBe(429);
    expect((await login(via('198.51.100.2'))).statusCode).toBe(401);
  });

  it('a forwarded address without the right secret is ignored (counted as the connection address)', async () => {
    for (let i = 0; i < 10; i++) expect((await login(via(`198.51.100.${10 + i}`, 'forged-secret'))).statusCode).toBe(401);
    expect((await login(via('198.51.100.99', 'forged-secret'))).statusCode).toBe(429);
  });

  it('wrong registration codes are limited per visitor, not for everyone', async () => {
    for (let i = 0; i < 5; i++) expect((await signup(via('192.0.2.1'))).statusCode).toBe(401);
    expect((await signup(via('192.0.2.1'))).statusCode).toBe(429);
    expect((await signup(via('192.0.2.2'))).statusCode).toBe(401);
  });
});
