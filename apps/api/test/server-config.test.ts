import { describe, expect, it } from 'vitest';
import { listenOptions } from '../src/listen.js';

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
