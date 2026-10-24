/**
 * Headers for a /backend request on its way to the API (see apps/api/src/client-ip.ts).
 * The API sees every proxied request as coming from this server, so the visitor's address
 * is forwarded with a shared secret; the API trusts the address only when the secret matches.
 * Visitor-supplied values for these headers are always dropped.
 */
export const CLIENT_IP_HEADER = 'x-palletdock-client-ip';
export const PROXY_SECRET_HEADER = 'x-palletdock-proxy-secret';

export function forwardHeaders(incoming: Headers, secret: string | undefined): Headers {
  const headers = new Headers(incoming);
  headers.delete(CLIENT_IP_HEADER);
  headers.delete(PROXY_SECRET_HEADER);
  if (!secret) return headers;
  // Set by the hosting platform for the connecting visitor (Vercel overwrites client-supplied values).
  const ip = incoming.get('x-real-ip')?.trim() || incoming.get('x-forwarded-for')?.split(',')[0]?.trim();
  if (!ip) return headers;
  headers.set(CLIENT_IP_HEADER, ip);
  headers.set(PROXY_SECRET_HEADER, secret);
  return headers;
}
