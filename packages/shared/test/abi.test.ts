import { describe, expect, it } from 'vitest';
import { encodeFunctionData } from 'viem';
import { readFileSync } from 'node:fs';
import { UnsupportedTypeError, ValidationError, coerceAbiValue, coerceArgs, parseAbiText, validateAbi, validateArtifact } from '../src/abi.js';

const storage = JSON.parse(readFileSync(new URL('../../contracts/artifacts/PalletDockStorage.json', import.meta.url), 'utf8'));

describe('artifact validation', () => {
  it('accepts the bundled Hardhat-style artifact with creation bytecode', () => {
    const v = validateArtifact(storage);
    expect(v.bytecodeKind).toBe('evm');
    expect(v.contractName).toBe('PalletDockStorage');
    expect(v.creationBytecode.startsWith('0x')).toBe(true);
  });
  it('accepts solc and Foundry layouts', () => {
    expect(validateArtifact({ abi: storage.abi, evm: { bytecode: { object: storage.bytecode.slice(2) } } }).creationBytecode).toBe(storage.bytecode);
    expect(validateArtifact({ abi: storage.abi, bytecode: { object: storage.bytecode, linkReferences: {} } }).creationBytecode).toBe(storage.bytecode);
  });
  it('rejects missing, runtime-only, unlinked, and malformed bytecode', () => {
    expect(() => validateArtifact({ abi: storage.abi })).toThrow(/no creation bytecode/);
    expect(() => validateArtifact({ abi: storage.abi, deployedBytecode: storage.deployedBytecode })).toThrow(/runtime/);
    expect(() => validateArtifact({ abi: storage.abi, bytecode: storage.deployedBytecode, deployedBytecode: storage.deployedBytecode })).toThrow(/runtime bytecode/);
    expect(() => validateArtifact({ abi: storage.abi, bytecode: '0x6080__$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa$__00' })).toThrow(/placeholders/);
    expect(() => validateArtifact({ abi: storage.abi, bytecode: '0x60', linkReferences: { 'a.sol': { L: [] } } })).toThrow(/link references/);
    expect(() => validateArtifact({ abi: storage.abi, bytecode: '0x6zz' })).toThrow(/hex/);
  });
  it('detects PolkaVM blobs', () => {
    expect(validateArtifact({ abi: storage.abi, bytecode: '0x50564d0000' }).bytecodeKind).toBe('polkavm');
  });
});

describe('ABI validation', () => {
  it('rejects invalid shapes and signatures', () => {
    expect(() => validateAbi({})).toThrow(ValidationError);
    expect(() => validateAbi([])).toThrow(/empty/);
    expect(() => validateAbi([{ type: 'function', name: '9bad', inputs: [] }])).toThrow(/invalid name/);
    expect(() => validateAbi([{ type: 'function', name: 'f', inputs: [{ type: 'uint7' }] }])).toThrow(/invalid type/);
    expect(() => validateAbi([{ type: 'function', name: 'f', inputs: [{ type: 'bytes33' }] }])).toThrow(/invalid type/);
    expect(() => validateAbi([{ type: 'function', name: 'f', inputs: [{ type: 'tuple' }] }])).toThrow(/invalid type/);
    expect(validateAbi([{ type: 'function', name: 'f', inputs: [{ type: 'tuple[2][]', components: [{ type: 'uint256' }] }], outputs: [] }])).toHaveLength(1);
    expect(() => validateAbi([{ type: 'weird' }])).toThrow(/unknown type/);
    expect(() => parseAbiText('not json')).toThrow(/not valid JSON/);
    expect(parseAbiText(JSON.stringify({ abi: storage.abi }))).toHaveLength(storage.abi.length);
  });
});

describe('argument coercion', () => {
  it('handles integers losslessly with range checks', () => {
    expect(coerceAbiValue({ type: 'uint256' }, '115792089237316195423570985008687907853269984665640564039457584007913129639935')).toBe(2n ** 256n - 1n);
    expect(() => coerceAbiValue({ type: 'uint256' }, '-1')).toThrow(/out of range/);
    expect(() => coerceAbiValue({ type: 'uint8' }, '256')).toThrow(/out of range/);
    expect(coerceAbiValue({ type: 'int8' }, '-128')).toBe(-128n);
    expect(() => coerceAbiValue({ type: 'uint256' }, 2 ** 60)).toThrow(/as strings/);
    expect(() => coerceAbiValue({ type: 'uint256' }, '1.5')).toThrow(/whole number/);
  });
  it('handles addresses, bools, bytes, arrays, and tuples', () => {
    const addr = coerceAbiValue({ type: 'address' }, '0x7a3f09c2d4e81b6a5f3c90e7d12b48a6e0f9c315') as string;
    expect(addr.toLowerCase()).toBe('0x7a3f09c2d4e81b6a5f3c90e7d12b48a6e0f9c315');
    expect(addr).not.toBe(addr.toLowerCase()); // checksummed
    expect(() => coerceAbiValue({ type: 'address' }, '0x123')).toThrow(/20-byte/);
    expect(coerceAbiValue({ type: 'bool' }, 'true')).toBe(true);
    expect(() => coerceAbiValue({ type: 'bytes4' }, '0x1234')).toThrow(/exactly 4 bytes/);
    expect(coerceAbiValue({ type: 'uint256[]' }, '["1","2"]')).toEqual([1n, 2n]);
    expect(() => coerceAbiValue({ type: 'uint256[2]' }, '["1"]')).toThrow(/exactly 2/);
    const tuple = { type: 'tuple', components: [{ name: 'a', type: 'uint256' }, { name: 'b', type: 'bool' }] } as const;
    expect(coerceAbiValue(tuple, '{"a":"5","b":true}')).toEqual({ a: 5n, b: true });
    expect(coerceAbiValue(tuple, '["5",false]')).toEqual([5n, false]);
  });
  it('refuses unsupported types instead of encoding them incorrectly', () => {
    expect(() => coerceAbiValue({ type: 'function' }, '0x')).toThrow(UnsupportedTypeError);
    expect(() => coerceAbiValue({ type: 'fixed128x18' }, '1')).toThrow(UnsupportedTypeError);
  });
  it('produces calldata viem accepts', () => {
    const fn = storage.abi.find((e: { name?: string }) => e.name === 'store');
    const args = coerceArgs(fn.inputs, ['42']);
    expect(encodeFunctionData({ abi: [fn], functionName: 'store', args: args as [bigint] })).toBe('0x6057361d000000000000000000000000000000000000000000000000000000000000002a');
  });
});
