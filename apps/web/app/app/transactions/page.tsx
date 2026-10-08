'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { useWorkspace } from '@/components/workspace-shell';
import { Modal, Notice, Segmented, Status } from '@/components/ui';
import { execLabel } from '@/components/tx-progress';
import { EmptyState, ErrorState, LoadingCards } from '@/components/page-state';
import { useResource } from '@/lib/use-resource';
import { groupDigits, shortHash, when } from '@/lib/format';

type Filter = 'all' | 'success' | 'reverted' | 'pending' | 'unknown' | 'rejected' | 'prepared';

export default function TransactionsPage() {
  const { project, projectId, readOnly, request, href } = useWorkspace();
  const search = useSearchParams();
  const router = useRouter();
  const hash = search.get('hash') ?? '';
  const [filter, setFilter] = useState<Filter>('all');
  const [before, setBefore] = useState<string[]>([]);
  const cursor = before.at(-1);
  const qs = new URLSearchParams({ filter, ...(hash ? { hash } : {}), ...(cursor ? { before: cursor } : {}) }).toString();
  const { data, error, loading, reload } = useResource<{ data: any[]; nextBefore: string | null; scope: string }>(projectId ? `/workspace/projects/${projectId}/transactions?${qs}` : null, { pollMs: 8000 });
  const [registering, setRegistering] = useState(false);
  const [regHash, setRegHash] = useState('');
  const [regErr, setRegErr] = useState('');

  if (!project) return <EmptyState title="Create a project first" body="Transactions are tracked per project." />;

  async function register() {
    setRegErr('');
    if (!/^0x[0-9a-fA-F]{64}$/.test(regHash.trim())) return setRegErr('Enter a 32-byte 0x transaction hash.');
    try {
      const r = await request<{ data: { id: string } }>(`/workspace/projects/${projectId}/transactions/register`, { method: 'POST', body: JSON.stringify({ hash: regHash.trim() }) });
      setRegistering(false);
      router.push(href(`/app/transactions/${r.data.id}`));
    } catch (e) {
      setRegErr((e as Error).message);
    }
  }

  return (
    <div className="page-stack">
      <div className="page-heading">
        <div>
          <div className="eyebrow">Transactions · EVM layer</div>
          <h1 className="page-title">Recorded writes</h1>
          <p>Transactions submitted through PalletDock or explicitly registered by hash. Other wallet activity is not shown.</p>
        </div>
        {!readOnly && (
          <button className="button secondary" onClick={() => setRegistering(true)}>
            Register a hash
          </button>
        )}
      </div>
      {hash && (
        <Notice tone="info" action={<Link className="button ghost" href={href('/app/transactions')}>Clear</Link>}>
          Showing transaction <span className="mono">{shortHash(hash)}</span>
        </Notice>
      )}
      <Segmented<Filter>
        label="Execution filter"
        value={filter}
        onChange={(v) => { setFilter(v); setBefore([]); }}
        options={[
          ['all', 'All'],
          ['success', 'Succeeded'],
          ['reverted', 'Reverted'],
          ['pending', 'Pending'],
          ['unknown', 'Unknown'],
          ['rejected', 'Not submitted'],
          ['prepared', 'Awaiting signature'],
        ]}
      />
      {loading ? (
        <LoadingCards />
      ) : error ? (
        <ErrorState message={error} retry={() => void reload()} />
      ) : (
        <section className="card table-scroll">
          <div style={{ minWidth: 900 }}>
            <div className="row-head" style={{ gridTemplateColumns: '150px minmax(160px,1fr) 100px 200px 150px 170px' }}>
              <span>Hash</span>
              <span>Call</span>
              <span>Block</span>
              <span>Status</span>
              <span>Finality</span>
              <span>Recorded</span>
            </div>
            {data?.data.map((t) => {
              const [label, tone] = execLabel(t);
              return (
                <Link key={t.id} className="row-link" href={href(`/app/transactions/${t.id}`)} style={{ gridTemplateColumns: '150px minmax(160px,1fr) 100px 200px 150px 170px' }}>
                  <span className="mono">{t.hash ? shortHash(t.hash) : <span className="dim">no hash</span>}</span>
                  <span className="mono ellipsis" style={{ color: '#c4c8ce' }}>
                    {t.kind === 'deploy' ? 'Contract creation' : t.function_name ?? 'Not decoded'}
                    {t.contract_name ? ` · ${t.contract_name}` : ''}
                    {t.origin === 'registered' ? ' · registered' : ''}
                  </span>
                  <span className="mono">{t.block_number ? groupDigits(t.block_number) : '—'}</span>
                  <Status tone={tone}>{label}</Status>
                  <span className="dim">{t.block_number ? 'Not confirmed' : 'Not checked'}</span>
                  <span className="mono dim" style={{ fontSize: 12 }}>
                    {when(t.created_at)}
                  </span>
                </Link>
              );
            })}
            {!data?.data.length && <p className="card-empty" style={{ borderTop: '1px solid #1f2125' }}>No transactions match this filter. Writes signed in Contract Studio appear here with their hash and stages.</p>}
          </div>
        </section>
      )}
      <div className="form-actions" style={{ marginTop: 0 }}>
        {before.length > 0 && (
          <button className="button ghost" onClick={() => setBefore(before.slice(0, -1))}>
            Newer
          </button>
        )}
        {data?.nextBefore && (
          <button className="button secondary" onClick={() => setBefore([...before, data.nextBefore!])}>
            Older
          </button>
        )}
      </div>
      {registering && (
        <Modal
          title="Register a transaction hash"
          onClose={() => setRegistering(false)}
          footer={
            <>
              <button className="button secondary" onClick={() => setRegistering(false)}>
                Cancel
              </button>
              <button className="button" onClick={() => void register()}>
                Register
              </button>
            </>
          }
        >
          <p className="muted" style={{ margin: 0, fontSize: 13, lineHeight: 1.55 }}>
            Track a transaction that was sent outside PalletDock. It must exist on Portaldot V3 Testnet; its input is decoded when it calls a contract tracked in this project.
          </p>
          <div className="field">
            <label htmlFor="reg-hash">Transaction hash</label>
            <input id="reg-hash" className="input mono" value={regHash} onChange={(e) => setRegHash(e.target.value)} placeholder="0x…" spellCheck={false} data-autofocus />
          </div>
          {regErr && <p className="field-error">{regErr}</p>}
        </Modal>
      )}
    </div>
  );
}
