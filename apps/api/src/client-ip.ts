import { isIP } from 'node:net';
import type { FastifyRequest } from 'fastify';
import { safeEqualStr } from '@palletdock/db';

/** Set by the web app's proxy on /backend requests (apps/web/proxy.ts). */
export const CLIENT_IP_HEADER = 'x-palletdock-client-ip';
export const PROXY_SECRET_HEADER = 'x-palletdock-proxy-secret';

/** Secret shared with the web app's proxy, or null when no proxy forwards visitor addresses. */
export function proxySecret(env: Record<string, string | undefined> = process.env): string | null {
  const secret = env.PALLETDOCK_PROXY_SECRET ?? '';
  if (!secret) return null;
  if (secret.length < 32) throw new Error('PALLETDOCK_PROXY_SECRET must contain at least 32 characters.');
  return secret;
}

/**
 * The visitor's address for rate limits. Browser requests reach the API through the web app's
 * /backend proxy, so they all arrive from the hosting provider's servers; the proxy forwards the
 * visitor's address together with the shared secret, and only then is that address trusted.
 * Otherwise (direct API calls, no secret configured, wrong secret) it is the connection address.
 */
export function clientIp(request: FastifyRequest, secret: string | null): string {
  if (secret) {
    const given = request.headers[PROXY_SECRET_HEADER];
    const ip = request.headers[CLIENT_IP_HEADER];
    if (typeof given === 'string' && typeof ip === 'string' && isIP(ip) && safeEqualStr(given, secret)) return ip;
  }
  return request.ip;
}
