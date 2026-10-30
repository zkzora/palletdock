import type { FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { safeEqualStr, sha256Hex } from '@palletdock/db';
import { API_KEY_PREFIX, ERROR_CODES, evmUnitPolicyFromFingerprint, type ErrorCode, type EvmUnitPolicy, type ReadScope } from '@palletdock/shared';
import { resolveGuestConfig } from './guest-config.js';

export const SESSION_COOKIE = 'palletdock_session';

export function cursorSecret(): string {
  const s = process.env.PALLETDOCK_CURSOR_SECRET;
  if (!s || s.startsWith('replace-with')) {
    if (process.env.NODE_ENV === 'production') throw new Error('PALLETDOCK_CURSOR_SECRET must be set to a random value in production.');
    return 'local-development-cursor-secret-change-me';
  }
  return s;
}

export type SessionKind = 'account' | 'guest';

export interface SessionAuth {
  ownerId: string;
  sessionId: string;
  csrfToken: string;
  /** Null for a temporary playground guest, which never has an email or password. */
  email: string | null;
  kind: SessionKind;
  /** Fixed expiry of a guest workspace (and its session); null for accounts. */
  guestExpiresAt: string | null;
}

/** Owner as returned to the browser. Guests carry no email and are labelled explicitly. */
export function ownerView(auth: Pick<SessionAuth, 'ownerId' | 'email' | 'kind'>) {
  return { id: auth.ownerId, email: auth.email, kind: auth.kind, displayName: auth.kind === 'guest' ? 'Temporary workspace' : auth.email };
}

export const GUEST_EXPIRED_MESSAGE =
  'This temporary playground workspace expired. Its off-chain access ended; contracts and transactions stay on the testnet. Start a new playground to continue.';

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
    `SELECT s.id AS session_id, s.csrf_token, o.id AS owner_id, o.email, o.kind, o.guest_expires_at,
            (s.revoked_at IS NULL AND s.expires_at > now()) AS session_valid,
            (o.kind = 'guest' AND o.guest_expires_at <= now()) AS guest_expired
       FROM sessions s JOIN owners o ON o.id=s.owner_id
      WHERE s.token_hash=$1`,
    [sha256Hex(token)],
  );
  const row = result.rows[0];
  // Guest expiry is checked here, at authorization, not only by the maintenance pass.
  if (row?.guest_expired) {
    // The cookie is kept (it expires at the same moment and authorizes nothing), so later
    // requests keep explaining the expiry instead of falling back to a plain sign-in prompt.
    fail(reply, 'WORKSPACE_EXPIRED', GUEST_EXPIRED_MESSAGE);
    return null;
  }
  if (!row || !row.session_valid) {
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    fail(reply, 'UNAUTHORIZED', 'Session expired. Sign in again.');
    return null;
  }
  // Activity is recorded but never extends a session or a guest workspace.
  await pool.query('UPDATE sessions SET last_seen_at=now() WHERE id=$1', [row.session_id]);
  request.pdAuth = { kind: 'session' };
  return {
    ownerId: row.owner_id,
    sessionId: row.session_id,
    csrfToken: row.csrf_token,
    email: row.email,
    kind: row.kind,
    guestExpiresAt: row.guest_expires_at ? new Date(row.guest_expires_at).toISOString() : null,
  };
}

/**
 * Count one mutating or RPC-backed request against a guest workspace's action budget.
 * Atomic (single conditional UPDATE), so parallel requests cannot exceed it. Accounts are unaffected.
 */
export async function consumeGuestAction(pool: pg.Pool, auth: SessionAuth, reply: FastifyReply): Promise<boolean> {
  if (auth.kind !== 'guest') return true;
  const max = resolveGuestConfig().maxActions;
  const r = await pool.query(`UPDATE owners SET guest_actions=guest_actions+1 WHERE id=$1 AND kind='guest' AND guest_actions < $2 RETURNING guest_actions`, [auth.ownerId, max]);
  if (!r.rowCount) {
    fail(reply, 'LIMIT_REACHED', `This temporary workspace has used its ${max} workspace actions. Save the workspace as an account to continue, or start a new playground.`);
    return false;
  }
  return true;
}

/** Refuse an action that temporary workspaces do not support, with the reason. */
export function guestRestricted(auth: SessionAuth, reply: FastifyReply, message: string): boolean {
  if (auth.kind !== 'guest') return false;
  fail(reply, 'GUEST_RESTRICTED', message);
  return true;
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
  // A key of an expired guest workspace is rejected here even before maintenance revokes it.
  const result = await pool.query(
    `SELECT k.id, k.project_id, k.secret_hash, k.scopes
       FROM api_keys k JOIN projects p ON p.id=k.project_id JOIN owners o ON o.id=p.owner_id
      WHERE k.prefix=$1 AND k.revoked_at IS NULL AND k.expires_at > now() AND (o.kind <> 'guest' OR o.guest_expires_at > now())`,
    [prefix],
  );
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
 * and, unless allowArchived, an active (non-archived) project. For a guest,
 * mutations (and any route that sets guestBudget) count against its action budget.
 */
export async function workspaceGuard(
  pool: pg.Pool,
  request: FastifyRequest,
  reply: FastifyReply,
  opts: { mutate?: boolean; allowArchived?: boolean; guestBudget?: boolean } = {},
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
  if ((opts.guestBudget ?? !!opts.mutate) && !(await consumeGuestAction(pool, auth, reply))) return null;
  return { auth, project };
}

/**
 * Lock a project row for the rest of a transaction. Quota checks run after this
 * lock so concurrent requests for the same project are serialized.
 */
export async function lockProject(client: pg.PoolClient, projectId: string): Promise<void> {
  await client.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE', [projectId]);
}

/** Thrown inside a transaction when a guest quota is reached; the caller maps it to LIMIT_REACHED. */
export class QuotaError extends Error {}

/** Columns of network_fingerprints that evmUnitPolicyFromFingerprint reads. */
export const UNIT_SOURCE_COLUMNS = 'id, status, token_symbol, token_decimals, spec_version::text, last_verified_at, evidence';

/** EVM unit policy of the active fingerprint; unverified unless its runtime metadata supports it. */
export async function activeUnitPolicy(pool: pg.Pool): Promise<EvmUnitPolicy> {
  const r = await pool.query(`SELECT ${UNIT_SOURCE_COLUMNS} FROM network_fingerprints WHERE network_id='portaldot-v3-testnet' AND status='active' LIMIT 1`);
  return evmUnitPolicyFromFingerprint(r.rows[0] ?? null);
}

export async function activeFingerprint(pool: pg.Pool): Promise<{ id: string; genesis_hash: string; evm_chain_id: string } | null> {
  const r = await pool.query(`SELECT id, genesis_hash, evm_chain_id::text FROM network_fingerprints WHERE network_id='portaldot-v3-testnet' AND status='active' LIMIT 1`);
  return r.rows[0] ?? null;
}
