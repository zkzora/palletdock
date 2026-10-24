import { describe, expect, it } from 'vitest';
import { CLIENT_IP_HEADER, PROXY_SECRET_HEADER, forwardHeaders } from '../lib/proxy-headers';

const SECRET = 'proxy-secret-for-tests-0123456789abcdef';

describe('headers forwarded from /backend to the API', () => {
  it('adds the visitor address and the shared secret when configured', () => {
    const h = forwardHeaders(new Headers({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1', cookie: 'pd_session=x' }), SECRET);
    expect(h.get(CLIENT_IP_HEADER)).toBe('203.0.113.7');
    expect(h.get(PROXY_SECRET_HEADER)).toBe(SECRET);
    expect(h.get('cookie')).toBe('pd_session=x'); // everything else passes through unchanged
  });

  it('prefers x-real-ip when the platform sets it', () => {
    const h = forwardHeaders(new Headers({ 'x-real-ip': '198.51.100.4', 'x-forwarded-for': '203.0.113.7' }), SECRET);
    expect(h.get(CLIENT_IP_HEADER)).toBe('198.51.100.4');
  });

  it('never passes visitor-supplied values for these headers through', () => {
    const spoofed = new Headers({ [CLIENT_IP_HEADER]: '1.2.3.4', [PROXY_SECRET_HEADER]: 'guess', 'x-forwarded-for': '203.0.113.7' });
    const withSecret = forwardHeaders(spoofed, SECRET);
    expect(withSecret.get(CLIENT_IP_HEADER)).toBe('203.0.113.7');
    expect(withSecret.get(PROXY_SECRET_HEADER)).toBe(SECRET);
    const without = forwardHeaders(spoofed, undefined);
    expect(without.get(CLIENT_IP_HEADER)).toBeNull();
    expect(without.get(PROXY_SECRET_HEADER)).toBeNull();
  });

  it('sends no secret when the visitor address is unknown', () => {
    const h = forwardHeaders(new Headers(), SECRET);
    expect(h.get(CLIENT_IP_HEADER)).toBeNull();
    expect(h.get(PROXY_SECRET_HEADER)).toBeNull();
  });
});
