'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useWorkspace } from '@/components/workspace-shell';
import { Notice } from '@/components/ui';
import { api } from '@/lib/api';

export default function ImportContractPage() {
  const { project, projectId, readOnly, request, href, reloadProjects } = useWorkspace();
  const router = useRouter();
  const [form, setForm] = useState({ name: '', address: '', abi: '', deployTxHash: '', deployBlock: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState('');
  const [busy, setBusy] = useState(false);
  if (!project) return <Notice tone="warning">Create a project first.</Notice>;
  if (readOnly) return <Notice tone="warning" title="Archived project">Restore the project in Settings to import contracts.</Notice>;

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    setForm({ ...form, [k]: e.target.value });
    setErrors({ ...errors, [k]: '' });
  };

  async function fillSampleAbi() {
    try {
      const r = await api<{ data: { samples: Array<{ id: string; abi: unknown }> } }>(`/workspace/projects/${projectId}/artifacts`);
      const s = r.data.samples.find((x) => x.id === 'storage');
      if (s) setForm((f) => ({ ...f, abi: JSON.stringify(s.abi, null, 2) }));
    } catch (e) {
      setFailure((e as Error).message);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!form.name.trim()) errs.name = 'Enter a contract name.';
    if (!/^0x[0-9a-fA-F]{40}$/.test(form.address.trim())) errs.address = 'Enter a 20-byte 0x address.';
    try {
      const parsed = JSON.parse(form.abi);
      if (!Array.isArray(parsed) && !Array.isArray(parsed?.abi)) errs.abi = 'ABI must be a JSON array (or an artifact object with an abi field).';
    } catch {
      errs.abi = 'ABI is not valid JSON.';
    }
    if (form.deployTxHash && !/^0x[0-9a-fA-F]{64}$/.test(form.deployTxHash.trim())) errs.deployTxHash = 'Enter a 32-byte 0x transaction hash.';
    if (form.deployBlock && !/^(0|[1-9][0-9]*)$/.test(form.deployBlock.trim())) errs.deployBlock = 'Enter a whole block number.';
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    setFailure('');
    try {
      const abi = JSON.parse(form.abi);
      const r = await request<{ data: { id: string } }>(`/workspace/projects/${projectId}/contracts/import`, {
        method: 'POST',
        body: JSON.stringify({ name: form.name.trim(), address: form.address.trim(), abi: Array.isArray(abi) ? abi : abi.abi, deployTxHash: form.deployTxHash.trim(), deployBlock: form.deployBlock.trim() }),
      });
      await reloadProjects();
      router.push(href(`/app/contracts/${r.data.id}`));
    } catch (err) {
      setFailure((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const field = (k: keyof typeof form, label: React.ReactNode, input: React.ReactNode) => (
    <div className="field">
      <label htmlFor={`imp-${k}`}>{label}</label>
      {input}
      {errors[k] && <p className="field-error">{errors[k]}</p>}
    </div>
  );

  return (
    <div className="page-stack">
      <div>
        <div className="eyebrow">Contract Studio</div>
        <h1 className="page-title">Import contract</h1>
      </div>
      <div className="two-column">
        <form className="card form-card" onSubmit={submit} noValidate>
          <h2 style={{ margin: 0, fontSize: 14 }}>Contract details · {project.name}</h2>
          {field('name', 'Name', <input id="imp-name" className="input" value={form.name} onChange={set('name')} placeholder="PalletDockStorage" aria-invalid={!!errors.name} />)}
          {field(
            'address',
            <>
              Contract address <span className="dim">EVM H160</span>
            </>,
            <input id="imp-address" className="input mono" value={form.address} onChange={set('address')} placeholder="0x…" spellCheck={false} aria-invalid={!!errors.address} />,
          )}
          {field(
            'abi',
            <span style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
              ABI (JSON)
              <button type="button" className="mini-button" onClick={() => void fillSampleAbi()}>
                Use PalletDockStorage ABI
              </button>
            </span>,
            <textarea id="imp-abi" className="input mono" rows={9} value={form.abi} onChange={set('abi')} spellCheck={false} placeholder='[{ "type": "function", … }]' aria-invalid={!!errors.abi} style={{ fontSize: 12 }} />,
          )}
          <div className="two-column" style={{ gap: 12 }}>
            {field(
              'deployTxHash',
              <>
                Deployment hash <span className="dim">optional</span>
              </>,
              <input id="imp-deployTxHash" className="input mono" value={form.deployTxHash} onChange={set('deployTxHash')} placeholder="0x…" spellCheck={false} />,
            )}
            {field(
              'deployBlock',
              <>
                Deployment block <span className="dim">optional</span>
              </>,
              <input id="imp-deployBlock" className="input mono" value={form.deployBlock} onChange={set('deployBlock')} inputMode="numeric" />,
            )}
          </div>
          {failure && <Notice tone="danger" title="Import failed">{failure} Your entries are kept.</Notice>}
          <div className="form-actions" style={{ marginTop: 0 }}>
            <button className="button" type="submit" disabled={busy} aria-busy={busy}>
              {busy ? 'Checking runtime code…' : 'Import contract'}
            </button>
            <Link className="button secondary" href={href('/app/contracts')}>
              Cancel
            </Link>
          </div>
        </form>
        <section className="card panel" style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: 13, lineHeight: 1.6, color: 'var(--muted)' }}>
          <h2 style={{ margin: 0, color: 'var(--foreground)' }}>What import does</h2>
          <p style={{ margin: 0 }}>Import attaches an address and ABI to this project so PalletDock can read, decode, and index the contract. It is off-chain organization and does not change contract ownership.</p>
          <p style={{ margin: 0 }}>PalletDock checks the address format, the ABI structure, and that runtime code exists at the address on Portaldot V3 Testnet. It does not prove you own the address or that the ABI matches the deployed bytecode.</p>
          <p style={{ margin: 0 }}>ABI attachment is not source verification. Verification stays unavailable until a V3 verifier is tested.</p>
          <p style={{ margin: 0 }}>
            A deployment block lets you start indexing at the right height. <Link href="/docs/deploy">What to save after deploying</Link>
          </p>
        </section>
      </div>
    </div>
  );
}
