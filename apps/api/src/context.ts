import type { FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { safeEqualStr, sha256Hex } from '@palletdock/db';
import { API_KEY_PREFIX, ERROR_CODES, type ErrorCode, type ReadScope } from '@palletdock/shared';

export const SESSION_COOKIE = 'palletdock_session';

export function cursorSecret(): string {
  const s = process.env.PALLETDOCK_CURSOR_SECRET;
  if (!s || s.startsWith('replace-with')) {
    if (process.env.NODE_ENV === 'production') throw new Error('PALLETDOCK_CURSOR_SECRET must be set to a random value in production.');
    return 'local-development-cursor-secret-change-me';
  }
  return s;
}

export interface SessionAuth {
  ownerId: string;
  sessionId: string;
  csrfToken: string;
  email: string;
}

export interface KeyAuth {
  keyId: string;
  projectId: string;
  scopes: ReadScope[];
}

declare module 'fastify' {
  interface FastifyRequest {
    pdAuth?: { kind: 'api_key' | 'session'; projectId?: string; keyId?: string };
    pdErrorCode?: string;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

export function fail(reply: FastifyReply, code: ErrorCode, message: string, requestId?: string): FastifyReply {
  reply.request.pdErrorCode = code;
  return reply.code(ERROR_CODES[code]).send({ error: { code, message, requestId: requestId ?? reply.request.id } });
}

export function stringParam(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function param(request: FastifyRequest, name: string): string {
  return stringParam((request.params as Record<string, unknown>)[name]);
}

export async function sessionAuth(pool: pg.Pool, request: FastifyRequest, reply: FastifyReply): Promise<SessionAuth | null> {
  const token = request.cookies[SESSION_COOKIE];
  if (!token) {
    fail(reply, 'UNAUTHORIZED', 'Sign in to continue.');
    return null;
  }
  const result = await pool.query(
    `SELECT s.id AS session_id, s.csrf_token, o.id AS owner_id, o.email
       FROM sessions s JOIN owners o ON o.id=s.owner_id
      WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
    [sha256Hex(token)],
  );
  if (!result.rowCount) {
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    fail(reply, 'UNAUTHORIZED', 'Session expired. Sign in again.');
    return null;
  }
  const row = result.rows[0];
  await pool.query('UPDATE sessions SET last_seen_at=now() WHERE id=$1', [row.session_id]);
  request.pdAuth = { kind: 'session' };
  return { ownerId: row.owner_id, sessionId: row.session_id, csrfToken: row.csrf_token, email: row.email };
}

export function requireCsrf(auth: SessionAuth, request: FastifyRequest, reply: FastifyReply): boolean {
  const supplied = request.headers['x-csrf-token'];
  if (typeof supplied !== 'string' || !safeEqualStr(supplied, auth.csrfToken)) {
    fail(reply, 'CSRF_REJECTED', 'The CSRF token is missing or invalid. Refresh the session and try again.');
    return false;
  }
  return true;
}

export async function keyAuth(pool: pg.Pool, request: FastifyRequest, reply: FastifyReply, projectId: string, scope: ReadScope): Promise<KeyAuth | null> {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith('Bearer ')) {
    fail(reply, 'UNAUTHORIZED', 'Provide a project read key as a Bearer token.');
    return null;
  }
  const token = authorization.slice(7).trim();
  const dot = token.indexOf('.');
  const prefix = dot > 0 ? token.slice(0, dot) : '';
  if (!prefix.startsWith(API_KEY_PREFIX) || token.length > 256) {
    fail(reply, 'UNAUTHORIZED', 'The project read key is invalid.');
    return null;
  }
  const result = await pool.query(`SELECT id, project_id, secret_hash, scopes FROM api_keys WHERE prefix=$1 AND revoked_at IS NULL AND expires_at > now()`, [prefix]);
  const row = result.rows[0];
  if (!row || !safeEqualStr(row.secret_hash, sha256Hex(token))) {
    fail(reply, 'UNAUTHORIZED', 'The project read key is invalid or expired.');
    return null;
  }
  request.pdAuth = { kind: 'api_key', keyId: row.id };
  if (row.project_id !== projectId) {
    fail(reply, 'PROJECT_NOT_FOUND', 'Project not found for this key.');
    return null;
  }
  request.pdAuth.projectId = projectId;
  if (!row.scopes.includes(scope)) {
    fail(reply, 'FORBIDDEN_SCOPE', `This key does not grant ${scope}.`);
    return null;
  }
  await pool.query('UPDATE api_keys SET last_used_at=now() WHERE id=$1', [row.id]);
  return { keyId: row.id, projectId: row.project_id, scopes: row.scopes };
}

export async function projectOwned(pool: pg.Pool, projectId: string, ownerId: string): Promise<Record<string, any> | null> {
  if (!isUuid(projectId)) return null;
  const result = await pool.query('SELECT * FROM projects WHERE id=$1 AND owner_id=$2', [projectId, ownerId]);
  return result.rows[0] ?? null;
}

/**
 * Session + ownership guard for workspace routes. Mutations also require CSRF
 * and, unless allowArchived, an active (non-archived) project.
 */
export async function workspaceGuard(
  pool: pg.Pool,
  request: FastifyRequest,
  reply: FastifyReply,
  opts: { mutate?: boolean; allowArchived?: boolean } = {},
): Promise<{ auth: SessionAuth; project: Record<string, any> } | null> {
  const auth = await sessionAuth(pool, request, reply);
  if (!auth) return null;
  if (opts.mutate && !requireCsrf(auth, request, reply)) return null;
  const project = await projectOwned(pool, param(request, 'projectId'), auth.ownerId);
  if (!project) {
    fail(reply, 'PROJECT_NOT_FOUND', 'Project not found.');
    return null;
  }
  request.pdAuth = { kind: 'session', projectId: project.id };
  if (opts.mutate && !opts.allowArchived && project.archived_at) {
    fail(reply, 'PROJECT_ARCHIVED', 'This project is archived and read-only. Restore it to make changes.');
    return null;
  }
  return { auth, project };
}

export async function activeFingerprint(pool: pg.Pool): Promise<{ id: string; genesis_hash: string; evm_chain_id: string } | null> {
  const r = await pool.query(`SELECT id, genesis_hash, evm_chain_id::text FROM network_fingerprints WHERE network_id='portaldot-v3-testnet' AND status='active' LIMIT 1`);
  return r.rows[0] ?? null;
}
