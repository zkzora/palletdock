import { decodeEventLog, type Abi, type AbiEvent, type Hex } from 'viem';
import { eventTopic0, eventsOf, signatureOf, toLosslessJson } from '@palletdock/shared';

export type DecodeResult =
  | { status: 'decoded'; eventName: string; eventSignature: string; args: unknown }
  | { status: 'unknown_event'; eventName: null; eventSignature: null; args: null; error: string }
  | { status: 'decode_error'; eventName: string | null; eventSignature: string | null; args: null; error: string };

export interface EventDecoder {
  decode(topics: readonly Hex[], data: Hex): DecodeResult;
}

/**
 * Build a decoder for one pinned ABI version. A log whose topic0 is not an
 * event in that ABI is `unknown_event`; one that matches but cannot be decoded
 * (wrong topic count, truncated data, bad encoding) is `decode_error`. Neither
 * is ever dropped: the raw log is retained by the caller regardless.
 */
export function createEventDecoder(abi: Abi): EventDecoder {
  const byTopic = new Map<string, AbiEvent>();
  for (const event of eventsOf(abi)) {
    if (event.anonymous) continue;
    byTopic.set(eventTopic0(event).toLowerCase(), event);
  }
  return {
    decode(topics, data) {
      const topic0 = topics[0]?.toLowerCase();
      const event = topic0 ? byTopic.get(topic0) : undefined;
      if (!event) {
        return { status: 'unknown_event', eventName: null, eventSignature: null, args: null, error: topic0 ? `No event in the pinned ABI has topic0 ${topic0}` : 'Log has no topics (anonymous event)' };
      }
      const eventSignature = signatureOf(event);
      try {
        const decoded = decodeEventLog({ abi: [event], topics: topics as [Hex, ...Hex[]], data, strict: true });
        return { status: 'decoded', eventName: event.name, eventSignature, args: toLosslessJson(decoded.args ?? {}) };
      } catch (error) {
        return { status: 'decode_error', eventName: event.name, eventSignature, args: null, error: firstLine((error as Error).message) };
      }
    },
  };
}

function firstLine(message: string): string {
  return message.split('\n')[0].slice(0, 500);
}
