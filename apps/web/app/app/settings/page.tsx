'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useWorkspace } from '@/components/workspace-shell';
import { CopyButton, Modal, Notice, useToast } from '@/components/ui';
import { EmptyState } from '@/components/page-state';
import { api } from '@/lib/api';

export default function SettingsPage() {
  const { project, projectId, readOnly, request, reloadProjects, href } = useWorkspace();
  const toast = useToast();
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [nameErr, setNameErr] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirm, setConfirm] = useState<'archive' | 'restore' | null>(null);
  const [restored, setRestored] = useState(false);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    setName(project?.name ?? '');
    setDesc(project?.description ?? '');
  }, [project?.id, project?.name, project?.description]);

  if (!project || !projectId) return <EmptyState title="Create a project first" body="Settings apply to one project." />;
  const dirty = name !== project.name || desc !== (project.description ?? '');

  async function save() {
    if (!name.trim()) return setNameErr('Enter project name.');
    setSaving(true);
    try {
      await request(`/workspace/projects/${projectId}`, { method: 'PATCH', body: JSON.stringify({ name: name.trim(), description: desc.trim() }) });
      await reloadProjects();
      toast.show('Settings saved.');
    } catch (e) {
      setNameErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function exportJson() {
    setExporting(true);
    try {
      const doc = await api<unknown>(`/workspace/projects/${projectId}/export`);
      const u = URL.createObjectURL(new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = u;
      a.download = `palletdock-${project!.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(u), 2000);
    } catch (e) {
      toast.show(`Export could not be prepared: ${(e as Error).message}`, true);
    } finally {
      setExporting(false);
    }
  }

  async function doArchive() {
    try {
      await request(`/workspace/projects/${projectId}/${confirm}`, { method: 'POST' });
      if (confirm === 'restore') setRestored(true);
      setConfirm(null);
      await reloadProjects();
      toast.show(confirm === 'archive' ? 'Project archived. Indexer jobs stopped.' : 'Project restored. Indexers stay stopped until you resume them.');
    } catch (e) {
      toast.show((e as Error).message, true);
      setConfirm(null);
    }
  }

  return (
    <div className="page-stack narrow">
      <div>
        <div className="eyebrow">Project settings</div>
        <h1 className="page-title">Settings</h1>
      </div>
      <section className="card form-card">
        <h2 style={{ margin: 0, fontSize: 14 }}>General</h2>
        <div className="field">
          <label htmlFor="s-name">Project name</label>
          <input id="s-name" className="input" value={name} disabled={readOnly} onChange={(e) => { setName(e.target.value); setNameErr(''); }} aria-invalid={!!nameErr} />
          {nameErr && <p className="field-error">{nameErr}</p>}
        </div>
        <div className="field">
          <label htmlFor="s-desc">Description</label>
          <textarea id="s-desc" className="input" rows={2} value={desc} disabled={readOnly} onChange={(e) => setDesc(e.target.value)} />
        </div>
        <div className="two-column" style={{ gap: 12 }}>
          <div>
            <div className="field-label">Network</div>
            <div style={{ marginTop: 6 }}>Portaldot V3 Testnet</div>
            <div className="dim" style={{ marginTop: 3, fontSize: 11.5 }}>Fixed after creation. Records keep their network identity.</div>
          </div>
          <div>
            <div className="field-label">Project ID</div>
            <div style={{ marginTop: 6, display: 'flex', gap: 8, alignItems: 'center' }}>
              <span className="mono" style={{ fontSize: 12.5, overflowWrap: 'anywhere' }}>{projectId}</span>
              <CopyButton text={projectId} label="Copy project ID" />
            </div>
          </div>
        </div>
        <div className="form-actions" style={{ marginTop: 0, alignItems: 'center' }}>
          <button className="button" onClick={() => void save()} disabled={!dirty || saving || readOnly} aria-busy={saving}>
            {saving ? 'Saving…' : 'Save changes'}
          </button>
          {dirty && <span className="dim" style={{ fontSize: 12.5 }}>Unsaved changes</span>}
        </div>
      </section>
      <section className="card form-card">
        <h2 style={{ margin: 0, fontSize: 14 }}>Export configuration</h2>
        <p className="muted" style={{ margin: 0, fontSize: 13, lineHeight: 1.55 }}>
          A JSON file with network identity, contracts and every ABI version, indexer configuration and checkpoints, and API key metadata. Secrets and key values are never included.
        </p>
        <div>
          <button className="button secondary" onClick={() => void exportJson()} disabled={exporting} aria-busy={exporting}>
            {exporting ? 'Preparing…' : 'Download configuration JSON'}
          </button>
        </div>
      </section>
      <section className="card form-card" style={{ borderColor: '#3a2a2a' }}>
        <h2 style={{ margin: 0, fontSize: 14 }}>{readOnly ? 'Restore project' : 'Archive project'}</h2>
        <p className="muted" style={{ margin: 0, fontSize: 13, lineHeight: 1.55 }}>
          {readOnly
            ? 'Restoring makes the workspace editable again. Indexer sources stay stopped until you resume each one, so no job restarts silently or twice.'
            : 'Archiving stops indexer jobs through the worker lifecycle and makes workspace data read-only. The read API keeps serving stored data to valid keys. Contracts, balances, and events on Portaldot are not changed.'}
        </p>
        <div>
          <button className={readOnly ? 'button secondary' : 'button danger'} onClick={() => setConfirm(readOnly ? 'restore' : 'archive')}>
            {readOnly ? 'Restore project' : 'Archive project'}
          </button>
        </div>
        {restored && !readOnly && (
          <Notice tone="success" title="Restored" action={<Link className="button secondary" href={href('/app/indexer')}>Review indexers</Link>}>
            Resume indexer sources individually from the Indexer page.
          </Notice>
        )}
      </section>
      {confirm && (
        <Modal
          title={confirm === 'archive' ? 'Archive project' : 'Restore project'}
          onClose={() => setConfirm(null)}
          footer={
            <>
              <button className="button secondary" onClick={() => setConfirm(null)} data-autofocus>
                Cancel
              </button>
              <button className={confirm === 'archive' ? 'button danger' : 'button'} onClick={() => void doArchive()}>
                {confirm === 'archive' ? 'Archive project' : 'Restore project'}
              </button>
            </>
          }
        >
          <p style={{ margin: 0, lineHeight: 1.55, color: '#c4c8ce' }}>
            {confirm === 'archive'
              ? `${project.name} becomes read-only and its indexer jobs stop; any in-flight fetch is discarded. On-chain resources are unchanged.`
              : `${project.name} becomes editable. Indexer sources remain stopped until you resume them.`}
          </p>
        </Modal>
      )}
      {toast.node}
    </div>
  );
}
