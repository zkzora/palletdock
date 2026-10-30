'use client';

import { useEffect, useState } from 'react';
import { api } from './api';

/**
 * Playground template definitions come from the API (packages/contracts/playground.ts),
 * so the guided pages never keep their own copy.
 */
export interface PlaygroundCall {
  function: string;
  args: string[];
  explain: string;
}
export interface PlaygroundTemplate {
  id: 'storage' | 'erc20' | 'erc721' | 'payments';
  sampleId: string;
  contractName: string;
  title: string;
  summary: string;
  outcome: string;
  constructorArgs: string[];
  constructorNotes: string[];
  read: PlaygroundCall;
  write: PlaygroundCall & { explicitValue?: boolean; requiredInputs?: number[] };
  event: { name: string; signature: string; fields: string[]; explain: string };
  notes: string[];
}
export interface PlaygroundConfig {
  enabled: boolean;
  lifetimeMinutes: number;
  limits: { projects: number; contracts: number; indexerSources: number; readKeys: number; actions: number };
  network: { name: string; evmChainId: number };
  templates: PlaygroundTemplate[];
}

export type GuideState = 'done' | 'in_progress' | 'todo' | 'attention';
export interface Guide {
  template: PlaygroundTemplate | null;
  contract: { id: string; name: string; address: string; deploy_block: string | null } | null;
  deploy: { id: string; hash: string | null; submission_status: string; execution_status: string } | null;
  read: { function: string; blockNumber: string; at: string } | null;
  interaction: { id: string; hash: string | null; execution_status: string; block_number: string | null } | null;
  source: { id: string; status: string; start_block: string; checkpoint_block: string | null; latest_observed_block: string | null; last_error: string | null } | null;
  event: { block_number: string; transaction_hash: string; log_index: number; args: Record<string, unknown> | null } | null;
  apiQuery: { request_id: string; created_at: string } | null;
  steps: Array<{ id: 'template' | 'deploy' | 'read' | 'write' | 'event' | 'api'; title: string; state: GuideState; detail: string }>;
}

/** Sent with POST /auth/playground; a cross-site page cannot add it without a CORS preflight. */
export const PLAYGROUND_INTENT = { 'x-palletdock-intent': 'start-playground' };

let cached: Promise<PlaygroundConfig> | null = null;

/** Public playground configuration and templates (GET, side-effect free). */
export function usePlaygroundConfig(): { config: PlaygroundConfig | null; error: string } {
  const [config, setConfig] = useState<PlaygroundConfig | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    cached ??= api<PlaygroundConfig>('/auth/playground-config');
    cached.then(setConfig).catch((e) => {
      cached = null;
      setError((e as Error).message);
    });
  }, []);
  return { config, error };
}

/** Replace {signer} with the connected wallet account; left empty (to be filled in) without one. */
export function fillSigner(args: string[], account: string | null): string[] {
  return args.map((a) => (a === '{signer}' ? (account ?? '') : a));
}

export function lifetimeLabel(minutes: number): string {
  if (minutes % 60 === 0) return `${minutes / 60} hour${minutes === 60 ? '' : 's'}`;
  return `${minutes} minutes`;
}

/** Query string that opens a contract page on a prepared read or write (arguments are not secrets). */
export function callQuery(tab: 'read' | 'write', call: PlaygroundCall & { explicitValue?: boolean }, account: string | null): string {
  const q = new URLSearchParams({ tab, fn: call.function, args: JSON.stringify(fillSigner(call.args, account)) });
  if (call.explicitValue) q.set('value', 'explicit');
  return q.toString();
}
