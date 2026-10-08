'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';

/** GET a workspace resource with loading/error state and optional polling. */
export function useResource<T>(path: string | null, opts: { pollMs?: number } = {}) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(!!path);
  const seq = useRef(0);

  const load = useCallback(
    async (quiet = false) => {
      if (!path) {
        setLoading(false);
        return;
      }
      const mine = ++seq.current;
      if (!quiet) setLoading(true);
      try {
        const r = await api<T>(path);
        if (mine === seq.current) {
          setData(r);
          setError('');
        }
      } catch (e) {
        if (mine === seq.current) setError((e as Error).message);
      } finally {
        if (mine === seq.current) setLoading(false);
      }
    },
    [path],
  );

  useEffect(() => {
    setData(null);
    void load();
  }, [load]);

  useEffect(() => {
    if (!opts.pollMs || !path) return;
    const t = setInterval(() => void load(true), opts.pollMs);
    return () => clearInterval(t);
  }, [opts.pollMs, path, load]);

  return { data, error, loading, reload: () => load(true) };
}
