import { describe, expect, it } from 'vitest';
import { DEFAULT_EVM_UNIT_POLICY, describeEvmAmount, evmTokenAmount, evmUnitNote, evmUnitPolicyFromFingerprint, formatUnitsExact, groupDigits, isAllowedRpcUrl, parseBlockNumber, resolveNetwork, stringifyLossless, toDecimalString } from '../src/index.js';

describe('lossless quantities', () => {
  it('converts RPC hex quantities beyond Number.MAX_SAFE_INTEGER exactly', () => {
    expect(toDecimalString('0x20000000000001')).toBe('9007199254740993');
    expect(toDecimalString('0x' + 'f'.repeat(64))).toBe((2n ** 256n - 1n).toString());
    expect(toDecimalString('0x')).toBe('0');
    expect(() => toDecimalString(1.5)).toThrow();
    expect(() => toDecimalString('12a')).toThrow();
  });
  it('serializes bigint as decimal strings, never through Number', () => {
    expect(stringifyLossless({ v: 2n ** 70n })).toBe('{"v":"1180591620717411303424"}');
  });
  it('parses block filters strictly', () => {
    expect(parseBlockNumber('18446744073709551617')).toBe(18446744073709551617n);
    expect(parseBlockNumber('')).toBeNull();
    expect(() => parseBlockNumber('-1')).toThrow();
    expect(() => parseBlockNumber('1e3')).toThrow();
  });
});

describe('unit conversions', () => {
  it('formats native 14-decimal amounts exactly', () => {
    expect(formatUnitsExact('123456789012345678', 14)).toBe('1234.56789012345678');
    expect(formatUnitsExact('100000000000000', 14)).toBe('1');
    expect(formatUnitsExact(1n, 14)).toBe('0.00000000000001');
  });
  it('does not apply native decimals to EVM amounts while the EVM unit is unverified', () => {
    expect(DEFAULT_EVM_UNIT_POLICY.status).toBe('unverified');
    expect(describeEvmAmount('123456789012345678')).toBe('123,456,789,012,345,678 raw EVM base units · display conversion unavailable');
    expect(describeEvmAmount(null)).toBe('Unavailable');
    expect(groupDigits('1000000.25')).toBe('1,000,000.25');
  });
});

describe('EVM unit policy from the verified network fingerprint', () => {
  const fp = {
    id: '3fc49db4-0049-448c-82cf-889d71335ed6',
    status: 'active',
    token_symbol: 'tPOT',
    token_decimals: 14,
    spec_version: '3002',
    last_verified_at: '2026-10-21T15:00:00Z',
    evidence: { substrate: { nativeToEthRatio: '10000' } },
  };
  it('derives EVM decimals from native tokenDecimals and revive.nativeToEthRatio', () => {
    const policy = evmUnitPolicyFromFingerprint(fp);
    expect(policy).toMatchObject({ status: 'verified', decimals: 18, symbol: 'tPOT' });
    expect(policy.status === 'verified' && policy.evidence).toContain('revive.nativeToEthRatio 10000');
    expect(policy.status === 'verified' && policy.evidence).toContain('3fc49db4');
    expect(evmUnitNote(policy)).toMatch(/^Fee, value and gas price are EVM base units with 18 decimals \(tPOT\)/);
    // The live store(42) fee from 2026-10-21, exactly.
    expect(evmTokenAmount('3856912452799144200', policy)).toBe('3.8569124527991442 tPOT');
  });
  it('stays unverified unless the fingerprint is active and the metadata is usable', () => {
    for (const bad of [
      null,
      { ...fp, status: 'mismatch' },
      { ...fp, status: 'superseded' },
      { ...fp, token_decimals: null },
      { ...fp, evidence: {} },
      { ...fp, evidence: { substrate: { nativeToEthRatio: null } } },
      { ...fp, evidence: { substrate: { nativeToEthRatio: '1500' } } },
    ]) {
      const policy = evmUnitPolicyFromFingerprint(bad);
      expect(policy.status).toBe('unverified');
      expect(evmUnitNote(policy)).toMatch(/^Fee, value and gas price are raw EVM base units\. Denomination unverified: /);
      expect(evmTokenAmount('3856912452799144200', policy)).toBeNull();
    }
    expect(evmUnitNote(evmUnitPolicyFromFingerprint({ ...fp, evidence: { substrate: { nativeToEthRatio: '1500' } } }))).toContain('not a power of ten');
  });
});

describe('RPC allowlist', () => {
  it('rejects SSRF-prone targets', () => {
    expect(isAllowedRpcUrl('https://test-evm-rpc-v3.portaldot.dev')).toBe(true);
    expect(isAllowedRpcUrl('http://test-evm-rpc-v3.portaldot.dev')).toBe(false);
    expect(isAllowedRpcUrl('https://169.254.169.254/latest')).toBe(false);
    expect(isAllowedRpcUrl('https://testnetv3-eth-rpc.feso-apps.xyz')).toBe(false); // retired endpoint
    expect(isAllowedRpcUrl('https://portaldot.dev.evil.example')).toBe(false);
    expect(isAllowedRpcUrl('https://evil.example/portaldot.dev')).toBe(false);
    expect(isAllowedRpcUrl('https://user:pw@test-evm-rpc-v3.portaldot.dev')).toBe(false);
    expect(isAllowedRpcUrl('http://127.0.0.1:8545')).toBe(false);
    expect(isAllowedRpcUrl('http://127.0.0.1:8545', { allowLoopback: true })).toBe(true);
  });
  it('only permits loopback overrides outside production', () => {
    expect(() => resolveNetwork({ PORTALDOT_EVM_RPC_URL: 'http://127.0.0.1:8545' })).toThrow(/allowlisted/);
    expect(resolveNetwork({ PORTALDOT_EVM_RPC_URL: 'http://127.0.0.1:8545', PALLETDOCK_ALLOW_LOOPBACK_RPC: '1' }).evmRpcUrl).toBe('http://127.0.0.1:8545');
    expect(() => resolveNetwork({ PORTALDOT_EVM_RPC_URL: 'http://127.0.0.1:8545', PALLETDOCK_ALLOW_LOOPBACK_RPC: '1', NODE_ENV: 'production' })).toThrow();
  });
});
