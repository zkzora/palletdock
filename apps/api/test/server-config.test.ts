import { describe, expect, it } from 'vitest';
import { listenOptions } from '../src/listen.js';
import { resolveSignupConfig } from '../src/registration.js';

describe('API listen configuration', () => {
  it('uses Railway PORT and a public bind address in production', () => {
    expect(listenOptions({ NODE_ENV: 'production', PORT: '43123' })).toEqual({ host: '0.0.0.0', port: 43123 });
  });

  it('keeps safe local defaults and lets explicit API settings win', () => {
    expect(listenOptions({ NODE_ENV: 'development' })).toEqual({ host: '127.0.0.1', port: 4100 });
    expect(listenOptions({ NODE_ENV: 'production', PORT: '43123', API_HOST: '::', API_PORT: '5100' })).toEqual({ host: '::', port: 5100 });
  });

  it('rejects invalid ports', () => {
    expect(() => listenOptions({ PORT: '0' })).toThrow(/valid TCP port/);
    expect(() => listenOptions({ PORT: 'not-a-port' })).toThrow(/valid TCP port/);
    expect(() => listenOptions({ PORT: '70000' })).toThrow(/valid TCP port/);
  });
});

describe('signup configuration', () => {
  it('is disabled by default', () => {
    expect(resolveSignupConfig({})).toMatchObject({ mode: 'disabled', enabled: false, inviteRequired: false });
  });

  it('requires a substantial invite code in invite mode', () => {
    expect(() => resolveSignupConfig({ PALLETDOCK_SIGNUP_MODE: 'invite', PALLETDOCK_SIGNUP_INVITE_CODE: 'short' })).toThrow(/at least 16/);
    expect(resolveSignupConfig({ PALLETDOCK_SIGNUP_MODE: 'invite', PALLETDOCK_SIGNUP_INVITE_CODE: 'long-enough-invite-code' })).toMatchObject({
      mode: 'invite',
      enabled: true,
      inviteRequired: true,
    });
  });

  it('accepts explicit open mode and rejects invalid modes and limits', () => {
    expect(resolveSignupConfig({ PALLETDOCK_SIGNUP_MODE: 'open' })).toMatchObject({ mode: 'open', enabled: true, inviteRequired: false });
    expect(() => resolveSignupConfig({ PALLETDOCK_SIGNUP_MODE: 'public' })).toThrow(/disabled, invite, or open/);
    expect(() => resolveSignupConfig({ PALLETDOCK_SIGNUP_RATE_LIMIT_PER_15_MINUTES: '0' })).toThrow(/integer from 1 to 100/);
  });
});
