import { z } from 'zod';

export const READ_SCOPES = ['contracts:read', 'transactions:read', 'events:read', 'indexer:read'] as const;
export type ReadScope = (typeof READ_SCOPES)[number];

export const API_KEY_PREFIX = 'pd_live_';
export const API_DEFAULT_LIMIT = 25;
export const API_MAX_LIMIT = 100;

export const ERROR_CODES = {
  INVALID_QUERY: 400,
  INVALID_REQUEST: 400,
  UNAUTHORIZED: 401,
  CSRF_REJECTED: 403,
  FORBIDDEN_SCOPE: 403,
  PROJECT_ARCHIVED: 409,
  PROJECT_NOT_FOUND: 404,
  NOT_FOUND: 404,
  CONFLICT: 409,
  CURSOR_RESTART_REQUIRED: 409,
  PAYLOAD_TOO_LARGE: 413,
  RATE_LIMITED: 429,
  NETWORK_IDENTITY_MISMATCH: 503,
  SERVICE_UNAVAILABLE: 503,
  INTERNAL: 500,
} as const;
export type ErrorCode = keyof typeof ERROR_CODES;

export const projectCreateSchema = z.object({
  name: z.string().trim().min(1, 'Enter project name.').max(80, 'Project name is limited to 80 characters.'),
  description: z.string().trim().max(500, 'Description is limited to 500 characters.').optional().default(''),
  networkId: z.literal('portaldot-v3-testnet').optional().default('portaldot-v3-testnet'),
});

export const projectUpdateSchema = z.object({
  name: z.string().trim().min(1, 'Enter project name.').max(80).optional(),
  description: z.string().trim().max(500).optional(),
});

export const addressSchema = z.string().trim().regex(/^0x[0-9a-fA-F]{40}$/, 'Enter a 20-byte 0x address.');
export const txHashSchema = z.string().trim().regex(/^0x[0-9a-fA-F]{64}$/, 'Enter a 32-byte 0x transaction hash.');
export const decString = z.string().regex(/^(0|[1-9][0-9]*)$/, 'Enter a non-negative whole number.');

export const contractImportSchema = z.object({
  name: z.string().trim().min(1, 'Enter a contract name.').max(80),
  address: addressSchema,
  abi: z.unknown(),
  deployTxHash: txHashSchema.optional().or(z.literal('')).transform((v) => v || undefined),
  deployBlock: decString.optional().or(z.literal('')).transform((v) => v || undefined),
});

export const indexerSourceSchema = z.object({
  contractId: z.string().uuid(),
  events: z.array(z.string().min(1).max(200)).min(1, 'Select at least one event.').max(50),
  startBlock: decString,
  endBlock: decString.optional().or(z.literal('')).transform((v) => v || undefined),
});

export const apiKeyCreateSchema = z.object({
  name: z.string().trim().min(1, 'Enter a key name.').max(60),
  scopes: z.array(z.enum(READ_SCOPES)).min(1, 'Select at least one scope.'),
  expiresInDays: z.union([z.literal(7), z.literal(30), z.literal(90), z.literal(365)]),
});

export interface ApiMeta {
  requestId: string;
  networkId: string;
  networkFingerprint: string | null;
  chainLayer: 'evm';
  observedAt: string;
  checkpoint: { blockNumber: string; blockHash: string; committedAt: string } | null;
  coverage: Array<{ sourceId: string; fromBlock: string; toBlock: string | null; status: 'complete' | 'empty' }>;
  finalityPolicy: 'included-with-explicit-finality';
  finality: 'unknown';
}

export interface ApiEnvelope<T> {
  requestId: string;
  data: T;
  nextCursor: string | null;
  meta: ApiMeta;
}

export interface ApiErrorBody {
  error: { code: ErrorCode; message: string; requestId: string };
}

/** Transaction lifecycle dimensions are tracked independently. */
export type SubmissionStatus = 'prepared' | 'rejected' | 'submitted' | 'unknown';
export type InclusionStatus = 'not_observed' | 'pending' | 'included' | 'reorged_out';
export type ExecutionStatus = 'unknown' | 'success' | 'reverted';
export type FinalityStatus = 'unknown';
export type IndexingStatus = 'not_applicable' | 'not_covered' | 'pending' | 'indexed' | 'no_events';
