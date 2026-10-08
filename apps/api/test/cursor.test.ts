import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor, normalizedFilterHash } from '../src/cursor.js';

const secret = 'test-secret-that-is-long-enough-for-hmac';

describe('opaque cursors', () => {
  it('binds pagination state to project, resource, and filters', () => {
    const filterHash = normalizedFilterHash({ limit: '25', event: 'Stored', cursor: 'ignored' });
    const cursor = encodeCursor({ resource: 'events', projectId: 'project-a', filterHash, snapshot: '100', after: ['80'] }, secret);
    expect(decodeCursor(cursor, { resource: 'events', projectId: 'project-a', filterHash }, secret).after).toEqual(['80']);
    expect(() => decodeCursor(cursor, { resource: 'events', projectId: 'project-b', filterHash }, secret)).toThrow('does not belong');
  });

  it('rejects tampering', () => {
    const filterHash = normalizedFilterHash({ limit: 25 });
    const cursor = encodeCursor({ resource: 'contracts', projectId: 'p', filterHash, snapshot: 'now', after: [] }, secret);
    expect(() => decodeCursor(`${cursor.slice(0, -1)}0`, { resource: 'contracts', projectId: 'p', filterHash }, secret)).toThrow('signature');
  });
});
