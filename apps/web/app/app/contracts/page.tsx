'use client';

import Link from 'next/link';
import { useWorkspace } from '@/components/workspace-shell';
import { EmptyState, ErrorState, LoadingCards } from '@/components/page-state';
import { useResource } from '@/lib/use-resource';
import { groupDigits } from '@/lib/format';

interface Row {
  id: string;
  name: string;
  address: string;
  source: string;
  deploy_block: string | null;
  abi_version: number;
  indexed: boolean;
}

export default function ContractsPage() {
  const { project, projectId, readOnly, href } = useWorkspace();
  const { data, error, loading, reload } = useResource<{ data: Row[] }>(projectId ? `/workspace/projects/${projectId}/contracts` : null);
  if (!project) return <EmptyState title="Create a project first" body="Contracts are tracked inside a project." action={<Link className="button" href="/app/projects/new">Create project</Link>} />;
  const actions = !readOnly && (
    <div className="form-actions" style={{ marginTop: 0 }}>
      <Link className="button secondary" href={href('/app/contracts/import')}>
        Import contract
      </Link>
      <Link className="button" href={href('/app/contracts/deploy')}>
        Deploy contract
      </Link>
    </div>
  );
  return (
    <div className="page-stack">
      <div className="page-heading">
        <div>
          <div className="eyebrow">Contract Studio</div>
          <h1 className="page-title">Contracts</h1>
        </div>
        {actions}
      </div>
      {loading ? (
        <LoadingCards />
      ) : error ? (
        <ErrorState message={error} retry={() => void reload()} />
      ) : !data?.data.length ? (
        <EmptyState title="No contracts tracked" body="Deploy from a compiled artifact or import an existing EVM contract by address and ABI. Importing is off-chain organization and does not change contract ownership." action={actions || undefined} />
      ) : (
        <div className="grid-cards">
          {data.data.map((c) => (
            <Link key={c.id} className="contract-card" href={href(`/app/contracts/${c.id}`)}>
              <span style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <strong style={{ fontSize: 15 }}>{c.name}</strong>
                <span className="dim" style={{ fontSize: 12, textTransform: 'capitalize' }}>
                  {c.source}
                </span>
              </span>
              <span className="mono" style={{ fontSize: 12, color: '#c4c8ce', overflowWrap: 'anywhere' }}>
                {c.address}
              </span>
              <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <span className="chip">
                  ABI v{c.abi_version}
                </span>
                <span className="chip dashed">Verification unavailable</span>
                {c.indexed && <span className="chip">Indexed</span>}
              </span>
              <span className="dim" style={{ fontSize: 12 }}>
                {c.deploy_block ? `Deployment block ${groupDigits(c.deploy_block)}` : 'Deployment block not recorded'}
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
