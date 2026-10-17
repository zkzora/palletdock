import { describe, expect, it } from 'vitest';
import { mappedAccountBytes } from '../src/substrate.js';

describe('mappedAccountBytes', () => {
  it('unwraps an Option<AccountId32> without changing bytes', () => {
    const expected = Uint8Array.from({ length: 32 }, (_, i) => i);
    const actual = mappedAccountBytes({ isSome: true, unwrap: () => ({ toU8a: () => expected }) });
    expect(actual).toEqual(expected);
  });

  it('refuses missing and malformed mappings', () => {
    expect(() => mappedAccountBytes({ isSome: false })).toThrow('no native account mapping');
    expect(() => mappedAccountBytes({ toHex: () => '0x1234' })).toThrow('expected AccountId32');
  });
});

describe('parseChainProperties', () => {
  it('reads codec wrappers whose JSON form is an array (Portaldot V3 runtime)', async () => {
    const { parseChainProperties } = await import('../src/substrate.js');
    // Mimics a codec object that is not an Array but serialises to one.
    const wrapper = (v: unknown) => ({ toJSON: () => v });
    expect(parseChainProperties({ ss58Format: 42, tokenSymbol: wrapper(['tPOT']), tokenDecimals: wrapper([14]) })).toEqual({ ss58Format: 42, tokenSymbols: ['tPOT'], tokenDecimals: [14] });
    expect(parseChainProperties({ tokenSymbol: 'UNIT', tokenDecimals: 12 })).toEqual({ ss58Format: null, tokenSymbols: ['UNIT'], tokenDecimals: [12] });
    expect(parseChainProperties(null)).toEqual({ ss58Format: null, tokenSymbols: [], tokenDecimals: [] });
  });
});
