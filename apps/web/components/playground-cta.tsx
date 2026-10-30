'use client';

import type { ReactNode } from 'react';
import { usePlaygroundConfig } from '@/lib/playground';

/**
 * Shows `playground` only when the API reports the playground as enabled, else `fallback`.
 * Keeps "Try Playground" off deployments where it is disabled or the API predates it.
 */
export function PlaygroundOr({ playground, fallback = null }: { playground: ReactNode; fallback?: ReactNode }) {
  const { config } = usePlaygroundConfig();
  return <>{config?.enabled ? playground : fallback}</>;
}
