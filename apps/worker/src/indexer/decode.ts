import { decodeEventLog, type Abi, type AbiEvent, type Hex } from 'viem';
import { eventsOf, signatureOf, toLosslessJson, eventTopic0 } from '@palletdock/shared';

export type DecodeResult =
  | { status: 'decoded'; eventName: string; eventSignature: string; args: unknown }
  | { status: 'unknown_event'; eventName: null; eventSignature: null; args: null; error: string }
  | { status: 'decode_error'; eventName: string | null; eventSignature: string | null; args: null; error: string };

/**
 * Decode one raw log against a pinned ABI version. Never throws: unknown and
 * malformed logs are reported so the raw record can still be stored.
 */
export function decodeLog(abi: Abi, topics: readonly string[], data: string): DecodeResult {
  const topic0 = topics[0]?.toLowerCase();
  if (!topic0) return { status: 'unknown_event', eventName: null, eventSignature: null, args: null, error: 'Anonymous log without topic0; no decoder applied.' };
  const candidates = eventsOf(abi).filter((e) => !e.anonymous && eventTopic0(e).toLowerCase() === topic0);
  if (!candidates.length) {
    return { status: 'unknown_event', eventName: null, eventSignature: null, args: null, error: `topic0 ${topic0} does not match an event in the pinned ABI version.` };
  }
  let lastError = '';
  // ERC-20 and ERC-721 share Transfer's topic0; try each candidate (indexed layout differs).
  for (const ev of candidates) {
    try {
      const out = decodeEventLog({ abi: [ev] as AbiEvent[], topics: topics as [Hex, ...Hex[]], data: data as Hex, strict: true });
      return { status: 'decoded', eventName: out.eventName as string, eventSignature: signatureOf(ev), args: toLosslessJson(out.args) };
    } catch (e) {
      lastError = (e as Error).message.split('\n')[0];
    }
  }
  const ev = candidates[0];
  return { status: 'decode_error', eventName: ev.name, eventSignature: signatureOf(ev), args: null, error: lastError || 'Log does not match the ABI layout.' };
}
