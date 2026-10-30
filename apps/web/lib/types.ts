export type SessionKind = 'account' | 'guest';
/** A temporary playground guest has no email; displayName labels it. */
export interface Owner { id: string; email: string | null; kind: SessionKind; displayName: string | null }
export interface SessionInfo { kind: SessionKind; expiresAt: string | null }
export interface Project {
  id: string;
  name: string;
  description: string;
  network_id: string;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  contract_count: number;
  active_key_count: number;
  indexer_status: string;
  /** Shows the guided playground checklist. */
  playground: boolean;
  playground_template: string | null;
}
export interface ApiKeyMeta {
  id: string; name: string; prefix: string; scopes: string[]; created_at: string; expires_at: string; revoked_at: string | null; last_used_at: string | null;
}
