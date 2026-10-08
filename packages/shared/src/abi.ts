import {
  type Abi,
  type AbiEvent,
  type AbiFunction,
  type AbiParameter,
  isAddress,
  getAddress,
  toEventSelector,
  toFunctionSelector,
  isHex,
} from 'viem';
import { formatAbiItem } from 'viem/utils';

export const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;
export const MAX_ABI_ENTRIES = 1000;

export type BytecodeKind = 'evm' | 'polkavm';

export interface ValidatedArtifact {
  contractName: string | null;
  abi: Abi;
  creationBytecode: `0x${string}`;
  deployedBytecode: `0x${string}` | null;
  bytecodeKind: BytecodeKind;
  constructorInputs: readonly AbiParameter[];
  constructorPayable: boolean;
  compiler: Record<string, unknown> | null;
  warnings: string[];
}

export class ValidationError extends Error {
  constructor(
    message: string,
    public field?: string,
  ) {
    super(message);
    this.name = 'ValidationError';
  }
}

const ABI_TYPES = new Set(['function', 'event', 'error', 'constructor', 'fallback', 'receive']);

const ELEMENTARY = /^(address|bool|string|bytes|function|(u?int)(\d*)|bytes(\d+)|(u?fixed)(\d+x\d+)?)$/;

/** Strict Solidity ABI type check (viem does not validate widths). */
export function isValidAbiType(param: { type?: unknown; components?: unknown }): boolean {
  if (typeof param?.type !== 'string') return false;
  let t = param.type;
  while (/\[\d*\]$/.test(t)) {
    const m = /\[(\d*)\]$/.exec(t)!;
    if (m[1] !== '' && (m[1] === '0' || m[1].startsWith('0'))) return false;
    t = t.slice(0, -m[0].length);
  }
  if (t === 'tuple') {
    const comps = param.components;
    return Array.isArray(comps) && comps.every((c) => isValidAbiType(c as { type?: unknown }));
  }
  const m = ELEMENTARY.exec(t);
  if (!m) return false;
  if (m[2] && m[3] !== '') {
    const bits = Number(m[3]);
    if (bits < 8 || bits > 256 || bits % 8 !== 0) return false;
  }
  if (m[4] !== undefined) {
    const n = Number(m[4]);
    if (n < 1 || n > 32) return false;
  }
  return true;
}

/** Validate a JSON ABI array; returns it typed. Throws ValidationError. */
export function validateAbi(input: unknown): Abi {
  if (!Array.isArray(input)) throw new ValidationError('ABI must be a JSON array.', 'abi');
  if (input.length === 0) throw new ValidationError('ABI is empty.', 'abi');
  if (input.length > MAX_ABI_ENTRIES) throw new ValidationError(`ABI has more than ${MAX_ABI_ENTRIES} entries.`, 'abi');
  input.forEach((e, i) => {
    if (!e || typeof e !== 'object') throw new ValidationError(`ABI entry ${i} is not an object.`, 'abi');
    const t = (e as { type?: unknown }).type ?? 'function';
    if (typeof t !== 'string' || !ABI_TYPES.has(t)) throw new ValidationError(`ABI entry ${i} has unknown type "${String(t)}".`, 'abi');
    const name = (e as { name?: unknown }).name;
    if ((t === 'function' || t === 'event' || t === 'error') && (typeof name !== 'string' || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name))) {
      throw new ValidationError(`ABI entry ${i} (${t}) has an invalid name.`, 'abi');
    }
    const inputs = (e as { inputs?: unknown }).inputs;
    if (inputs !== undefined && !Array.isArray(inputs)) throw new ValidationError(`ABI entry ${i} inputs must be an array.`, 'abi');
    const outputs = (e as { outputs?: unknown }).outputs;
    for (const [list, label] of [[inputs, 'input'], [outputs, 'output']] as const) {
      if (list === undefined) continue;
      if (!Array.isArray(list)) throw new ValidationError(`ABI entry ${i} ${label}s must be an array.`, 'abi');
      list.forEach((p, j) => {
        if (!isValidAbiType(p as { type?: unknown })) {
          throw new ValidationError(`ABI entry ${i} (${String(name ?? t)}) ${label} ${j} has an invalid type "${String((p as { type?: unknown })?.type)}".`, 'abi');
        }
      });
    }
    try {
      if (t === 'function') toFunctionSelector(formatAbiItem(e as AbiFunction));
      if (t === 'event') toEventSelector(formatAbiItem(e as AbiEvent));
      if (t === 'error') toFunctionSelector(formatAbiItem(e as never));
    } catch (err) {
      throw new ValidationError(`ABI entry ${i} (${String(name ?? t)}) has an invalid signature: ${(err as Error).message.split('\n')[0]}`, 'abi');
    }
  });
  return input as Abi;
}

export function parseAbiText(text: string): Abi {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ValidationError('ABI is not valid JSON.', 'abi');
  }
  // Accept an artifact object that wraps an ABI.
  if (parsed && !Array.isArray(parsed) && typeof parsed === 'object' && Array.isArray((parsed as { abi?: unknown }).abi)) {
    parsed = (parsed as { abi: unknown }).abi;
  }
  return validateAbi(parsed);
}

function pickBytecode(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && typeof (v as { object?: unknown }).object === 'string') return (v as { object: string }).object;
  return null;
}

function hasLinkRefs(v: unknown): boolean {
  return !!v && typeof v === 'object' && Object.keys(v as object).length > 0;
}

const PVM_MAGIC = '50564d00'; // "PVM\0"

/**
 * Validate an uploaded compiled artifact (Hardhat, Foundry, or solc
 * single-contract output). Only JSON is accepted; no build scripts or sources
 * are executed.
 */
export function validateArtifact(raw: unknown): ValidatedArtifact {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ValidationError('Artifact must be a JSON object with abi and bytecode.');
  const a = raw as Record<string, any>;
  const warnings: string[] = [];
  const abi = validateAbi(a.abi);

  const evm = a.evm && typeof a.evm === 'object' ? a.evm : null;
  let creation = pickBytecode(a.bytecode) ?? pickBytecode(evm?.bytecode);
  const deployed = pickBytecode(a.deployedBytecode) ?? pickBytecode(evm?.deployedBytecode);
  const linkRefs = a.linkReferences ?? a.bytecode?.linkReferences ?? evm?.bytecode?.linkReferences;

  if (!creation || creation === '0x' || creation === '') {
    if (deployed) throw new ValidationError('Artifact has only runtime (deployed) bytecode. Deployment needs creation bytecode.', 'bytecode');
    throw new ValidationError('Artifact has no creation bytecode. Interfaces and abstract contracts cannot be deployed.', 'bytecode');
  }
  if (!creation.startsWith('0x')) creation = '0x' + creation;
  if (/__\$[0-9a-fA-F]{34}\$__|__[A-Za-z0-9_.:/-]{1,36}__/.test(creation)) {
    throw new ValidationError('Creation bytecode contains unresolved library placeholders. Link libraries before uploading.', 'bytecode');
  }
  if (hasLinkRefs(linkRefs)) {
    throw new ValidationError('Artifact declares library link references. Linked libraries are not supported; upload fully linked bytecode.', 'bytecode');
  }
  if (!isHex(creation) || creation.length % 2 !== 0) throw new ValidationError('Creation bytecode is not valid hex.', 'bytecode');
  let deployedHex: `0x${string}` | null = null;
  if (deployed && deployed !== '0x') {
    const d = deployed.startsWith('0x') ? deployed : '0x' + deployed;
    if (isHex(d)) deployedHex = d as `0x${string}`;
    if (deployedHex && deployedHex.toLowerCase() === creation.toLowerCase()) {
      throw new ValidationError('The bytecode field equals the runtime bytecode. Deployment needs creation bytecode.', 'bytecode');
    }
  }
  const bytecodeKind: BytecodeKind = creation.slice(2, 10).toLowerCase() === PVM_MAGIC ? 'polkavm' : 'evm';
  if (bytecodeKind === 'evm') warnings.push('EVM bytecode: compatibility with the Portaldot Revive runtime is confirmed only by a successful deployment on the connected network.');

  const ctor = abi.find((e) => e.type === 'constructor') as { inputs?: AbiParameter[]; stateMutability?: string } | undefined;
  const compiler =
    a.compiler && typeof a.compiler === 'object'
      ? a.compiler
      : a.metadata && typeof a.metadata === 'string'
        ? safeCompilerFromMetadata(a.metadata)
        : null;
  return {
    contractName: typeof a.contractName === 'string' ? a.contractName.slice(0, 120) : null,
    abi,
    creationBytecode: creation as `0x${string}`,
    deployedBytecode: deployedHex,
    bytecodeKind,
    constructorInputs: ctor?.inputs ?? [],
    constructorPayable: ctor?.stateMutability === 'payable',
    compiler,
    warnings,
  };
}

function safeCompilerFromMetadata(m: string): Record<string, unknown> | null {
  try {
    const j = JSON.parse(m);
    return j?.compiler ? { version: j.compiler.version, settings: j.settings ? { optimizer: j.settings.optimizer, evmVersion: j.settings.evmVersion } : undefined } : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Argument parsing                                                   */
/* ------------------------------------------------------------------ */

export class UnsupportedTypeError extends ValidationError {}

const INT_RE = /^(u?)int(\d*)$/;
const BYTES_RE = /^bytes(\d+)$/;
const ARRAY_RE = /^(.*)\[(\d*)\]$/;

function parseIntLike(type: string, v: unknown, label: string): bigint {
  const m = INT_RE.exec(type)!;
  const unsigned = m[1] === 'u';
  const bits = m[2] ? Number(m[2]) : 256;
  if (bits < 8 || bits > 256 || bits % 8 !== 0) throw new UnsupportedTypeError(`${label}: invalid integer width ${type}.`);
  let n: bigint;
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) throw new ValidationError(`${label}: pass large integers as strings to avoid precision loss.`);
    n = BigInt(v);
  } else if (typeof v === 'string') {
    const s = v.trim();
    if (/^-?(0|[1-9][0-9]*)$/.test(s)) n = BigInt(s);
    else if (/^0x[0-9a-fA-F]+$/.test(s)) n = BigInt(s);
    else throw new ValidationError(`${label}: enter a whole number for ${type}.`);
  } else if (typeof v === 'bigint') n = v;
  else throw new ValidationError(`${label}: enter a whole number for ${type}.`);
  const min = unsigned ? 0n : -(2n ** BigInt(bits - 1));
  const max = unsigned ? 2n ** BigInt(bits) - 1n : 2n ** BigInt(bits - 1) - 1n;
  if (n < min || n > max) throw new ValidationError(`${label}: value is out of range for ${type}.`);
  return n;
}

/** Convert a JSON/string value into a viem-encodable value for an ABI parameter. */
export function coerceAbiValue(param: AbiParameter, v: unknown, label = param.name || param.type): unknown {
  const type = param.type;
  const arr = ARRAY_RE.exec(type);
  if (arr) {
    let list = v;
    if (typeof v === 'string') {
      try {
        list = JSON.parse(v);
      } catch {
        throw new ValidationError(`${label}: enter a JSON array for ${type}.`);
      }
    }
    if (!Array.isArray(list)) throw new ValidationError(`${label}: enter a JSON array for ${type}.`);
    if (arr[2] !== '' && list.length !== Number(arr[2])) throw new ValidationError(`${label}: ${type} needs exactly ${arr[2]} items.`);
    if (list.length > 1000) throw new ValidationError(`${label}: arrays are limited to 1000 items.`);
    const inner = { ...param, type: arr[1] } as AbiParameter;
    return list.map((x, i) => coerceAbiValue(inner, x, `${label}[${i}]`));
  }
  if (type === 'tuple') {
    const comps = (param as { components?: readonly AbiParameter[] }).components ?? [];
    let obj = v;
    if (typeof v === 'string') {
      try {
        obj = JSON.parse(v);
      } catch {
        throw new ValidationError(`${label}: enter a JSON object or array for the tuple.`);
      }
    }
    if (Array.isArray(obj)) {
      if (obj.length !== comps.length) throw new ValidationError(`${label}: tuple needs ${comps.length} items.`);
      return comps.map((c, i) => coerceAbiValue(c, obj[i], `${label}.${c.name || i}`));
    }
    if (obj && typeof obj === 'object') {
      const allNamed = comps.every((c) => c.name);
      if (!allNamed) throw new ValidationError(`${label}: tuple has unnamed components; enter a JSON array.`);
      const out: Record<string, unknown> = {};
      for (const c of comps) {
        if (!(c.name! in (obj as object))) throw new ValidationError(`${label}: missing tuple field "${c.name}".`);
        out[c.name!] = coerceAbiValue(c, (obj as Record<string, unknown>)[c.name!], `${label}.${c.name}`);
      }
      return out;
    }
    throw new ValidationError(`${label}: enter a JSON object or array for the tuple.`);
  }
  if (INT_RE.test(type)) return parseIntLike(type, v, label);
  if (type === 'address') {
    if (typeof v !== 'string' || !isAddress(v.trim(), { strict: false })) throw new ValidationError(`${label}: enter a 20-byte 0x address.`);
    const s = v.trim();
    if (s !== s.toLowerCase() && s !== s.toUpperCase().replace('0X', '0x') && !isAddress(s, { strict: true })) {
      throw new ValidationError(`${label}: address checksum does not match.`);
    }
    return getAddress(s);
  }
  if (type === 'bool') {
    if (v === true || v === 'true') return true;
    if (v === false || v === 'false') return false;
    throw new ValidationError(`${label}: enter true or false.`);
  }
  if (type === 'string') {
    if (typeof v !== 'string') throw new ValidationError(`${label}: enter text.`);
    if (v.length > 10000) throw new ValidationError(`${label}: text is limited to 10000 characters.`);
    return v;
  }
  if (type === 'bytes') {
    if (typeof v !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(v.trim())) throw new ValidationError(`${label}: enter 0x-prefixed hex with an even number of digits.`);
    return v.trim();
  }
  const b = BYTES_RE.exec(type);
  if (b) {
    const n = Number(b[1]);
    if (n < 1 || n > 32) throw new UnsupportedTypeError(`${label}: invalid type ${type}.`);
    if (typeof v !== 'string' || !new RegExp(`^0x[0-9a-fA-F]{${n * 2}}$`).test(v.trim())) throw new ValidationError(`${label}: enter exactly ${n} bytes as 0x hex.`);
    return v.trim();
  }
  throw new UnsupportedTypeError(`${label}: type ${type} is not supported by the PalletDock form. Nothing was encoded.`);
}

export function coerceArgs(inputs: readonly AbiParameter[], values: unknown[]): unknown[] {
  if (values.length !== inputs.length) throw new ValidationError(`Expected ${inputs.length} arguments, received ${values.length}.`);
  return inputs.map((p, i) => coerceAbiValue(p, values[i], p.name || `arg${i}`));
}

/** Recursively convert decoded values to JSON-safe lossless values. */
export function toLosslessJson(v: unknown): unknown {
  if (typeof v === 'bigint') return v.toString(10);
  if (Array.isArray(v)) return v.map(toLosslessJson);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = toLosslessJson(x);
    return out;
  }
  return v;
}

export function functionsOf(abi: Abi, mode: 'read' | 'write'): AbiFunction[] {
  return abi.filter(
    (e): e is AbiFunction =>
      e.type === 'function' && (mode === 'read' ? ['view', 'pure'].includes(e.stateMutability) : !['view', 'pure'].includes(e.stateMutability)),
  );
}

export function eventsOf(abi: Abi): AbiEvent[] {
  return abi.filter((e): e is AbiEvent => e.type === 'event');
}

export function signatureOf(item: AbiFunction | AbiEvent): string {
  return `${item.name}(${item.inputs.map((i) => formatParamType(i)).join(',')})`;
}

function formatParamType(p: AbiParameter): string {
  if (p.type.startsWith('tuple')) {
    const comps = (p as { components?: readonly AbiParameter[] }).components ?? [];
    return `(${comps.map(formatParamType).join(',')})${p.type.slice(5)}`;
  }
  return p.type;
}

export function eventTopic0(e: AbiEvent): `0x${string}` {
  return toEventSelector(e);
}
