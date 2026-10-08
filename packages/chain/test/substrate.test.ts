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
