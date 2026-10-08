export interface Owner { id: string; email: string }
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
}
export interface ApiKeyMeta {
  id: string; name: string; prefix: string; scopes: string[]; created_at: string; expires_at: string; revoked_at: string | null; last_used_at: string | null;
}
