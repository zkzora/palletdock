import { hmacHex, safeEqualStr, sha256Hex } from '@palletdock/db';

interface CursorPayload {
  v: 1;
  resource: string;
  projectId: string;
  filterHash: string;
  snapshot: string;
  after: string[];
}

export function normalizedFilterHash(query: Record<string, unknown>): string {
  const normalized = Object.fromEntries(
    Object.entries(query)
      .filter(([key]) => key !== 'cursor')
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => [key, Array.isArray(value) ? [...value].map(String).sort() : String(value ?? '')]),
  );
  return sha256Hex(JSON.stringify(normalized));
}

export function encodeCursor(payload: Omit<CursorPayload, 'v'>, secret: string): string {
  const body = Buffer.from(JSON.stringify({ v: 1, ...payload } satisfies CursorPayload)).toString('base64url');
  return `${body}.${hmacHex(secret, body)}`;
}

export function decodeCursor(
  cursor: string,
  expected: Pick<CursorPayload, 'resource' | 'projectId' | 'filterHash'>,
  secret: string,
): CursorPayload {
  const [body, signature, extra] = cursor.split('.');
  if (!body || !signature || extra || !safeEqualStr(hmacHex(secret, body), signature)) throw new Error('Cursor signature is invalid');
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Cursor payload is invalid');
  }
  if (!value || typeof value !== 'object') throw new Error('Cursor payload is invalid');
  const payload = value as CursorPayload;
  if (
    payload.v !== 1 ||
    payload.resource !== expected.resource ||
    payload.projectId !== expected.projectId ||
    payload.filterHash !== expected.filterHash ||
    typeof payload.snapshot !== 'string' ||
    !Array.isArray(payload.after) ||
    payload.after.some((part) => typeof part !== 'string')
  ) {
    throw new Error('Cursor does not belong to this project, resource, or filter set');
  }
  return payload;
}
