'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Check, ChevronDown, ChevronUp, CircleAlert, Circle, LoaderCircle } from 'lucide-react';
import { useWorkspace } from '@/components/workspace-shell';
import { Notice } from '@/components/ui';
import { useResource } from '@/lib/use-resource';
import { useWallet } from '@/lib/wallet';
import { callQuery, usePlaygroundConfig, type Guide, type GuideState } from '@/lib/playground';
import { groupDigits } from '@/lib/format';
import type { ApiError } from '@/lib/api';

const COLLAPSE_KEY = 'palletdock.playground-guide.collapsed';

function StateIcon({ state }: { state: GuideState }) {
  if (state === 'done') return <Check size={14} aria-hidden="true" />;
  if (state === 'in_progress') return <LoaderCircle size={14} aria-hidden="true" className="spin" />;
  if (state === 'attention') return <CircleAlert size={14} aria-hidden="true" />;
  return <Circle size={14} aria-hidden="true" />;
}

const STATE_LABEL: Record<GuideState, string> = { done: 'Done', in_progress: 'In progress', todo: 'Not done', attention: 'Needs attention' };

/**
 * Compact guided checklist for a playground project. Every state comes from
 * GET /playground, which derives it from records the server or worker observed;
 * the buttons here only navigate or perform an explicit action.
 */
/** Whether a template has the operator's shared copy (no deployment) or must be deployed by the visitor. */
export function SharedBadge({ shared }: { shared: boolean }) {
  return (
    <span className={shared ? 'success-text' : 'dim'} style={{ fontSize: 11.5 }}>
      {shared ? 'Ready: shared contract, no deployment' : 'You deploy it (needs a tPOT storage deposit)'}
    </span>
  );
}

export function PlaygroundGuide() {
  const { projectId, project, request, href, readOnly } = useWorkspace();
  const wallet = useWallet();
  const { config } = usePlaygroundConfig();
  const { data, error, reload } = useResource<{ data: Guide }>(projectId && project?.playground ? `/workspace/projects/${projectId}/playground` : null, { pollMs: 6000 });
  const [collapsed, setCollapsed] = useState(false);
  const [busy, setBusy] = useState('');
  const [actionError, setActionError] = useState('');
  const [recovery, setRecovery] = useState<{ message: string; suggestedStartBlock: string | null } | null>(null);

  useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(COLLAPSE_KEY) === '1');
    } catch {
      /* storage unavailable: stay expanded */
    }
  }, []);
  const toggle = () => {
    setCollapsed((c) => {
      try {
        window.localStorage.setItem(COLLAPSE_KEY, c ? '0' : '1');
      } catch {
        /* ignore */
      }
      return !c;
    });
  };

  if (!project?.playground) return null;
  const guide = data?.data;
  const tpl = guide?.template ?? null;
  const done = guide?.steps.filter((s) => s.state === 'done').length ?? 0;
  const next = guide?.steps.find((s) => s.state !== 'done');

  async function chooseTemplate(id: string) {
    setActionError('');
    setBusy(`template:${id}`);
    try {
      await request(`/workspace/projects/${projectId}/playground/template`, { method: 'POST', body: JSON.stringify({ template: id }) });
      await reload();
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusy('');
    }
  }

  async function addSharedContract() {
    setActionError('');
    setBusy('shared');
    try {
      await request(`/workspace/projects/${projectId}/playground/shared-contract`, { method: 'POST' });
      await reload();
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusy('');
    }
  }

  async function startIndexing(startBlock?: string) {
    if (!guide?.contract) return;
    setActionError('');
    setBusy('source');
    try {
      await request(`/workspace/projects/${projectId}/playground/indexer-source`, {
        method: 'POST',
        body: JSON.stringify({ contractId: guide.contract.id, ...(startBlock ? { startBlock } : {}) }),
      });
      setRecovery(null);
      await reload();
    } catch (e) {
      const err = e as ApiError;
      const rec = err.body?.recovery as { suggestedStartBlock?: string | null } | undefined;
      if (err.code === 'HISTORY_UNAVAILABLE') setRecovery({ message: err.message, suggestedStartBlock: rec?.suggestedStartBlock ?? null });
      else setActionError(err.message);
    } finally {
      setBusy('');
    }
  }

  const action = (id: string) => {
    if (!guide || !tpl) return null;
    const c = guide.contract;
    switch (id) {
      case 'deploy':
        if (c) return null;
        return (
          <span className="guide-actions">
            {guide.sharedContract && !readOnly && (
              <button className="mini-button" onClick={() => void addSharedContract()} disabled={!!busy} aria-busy={busy === 'shared'}>
                {busy === 'shared' ? 'Checking contract…' : 'Use shared contract'}
              </button>
            )}
            <Link className="mini-button" href={href(`/app/contracts/deploy?template=${tpl.id}`)}>
              {guide.sharedContract ? 'Deploy your own' : 'Open deploy'}
            </Link>
          </span>
        );
      case 'read':
        return c ? (
          <Link className="mini-button" href={href(`/app/contracts/${c.id}?${callQuery('read', tpl.read, wallet.account)}`)}>
            Open {tpl.read.function}
          </Link>
        ) : null;
      case 'write':
        return c ? (
          <Link className="mini-button" href={href(`/app/contracts/${c.id}?${callQuery('write', tpl.write, wallet.account)}`)}>
            Prepare {tpl.write.function}
          </Link>
        ) : null;
      case 'event':
        return c ? (
          <Link className="mini-button" href={href(guide.source ? `/app/contracts/${c.id}?tab=events` : '/app/indexer')}>
            {guide.source ? 'Open events' : 'Open indexer'}
          </Link>
        ) : null;
      case 'api':
        return guide.event && c ? (
          <Link className="mini-button" href={href(`/app/api?endpoint=events&contract=${c.address}&event=${tpl.event.name}`)}>
            Open API playground
          </Link>
        ) : null;
      default:
        return null;
    }
  };

  return (
    <section className="card guide" aria-label="Playground guide">
      <div className="guide-head">
        <div style={{ minWidth: 0 }}>
          <span className="eyebrow">Playground guide{tpl ? ` · ${tpl.title}` : ''}</span>
          <div className="guide-summary">
            {guide ? (
              <>
                <strong>
                  {done} of {guide.steps.length} observed
                </strong>
                {next && <span className="dim"> · next: {next.title}</span>}
              </>
            ) : error ? (
              <span className="danger-text">{error}</span>
            ) : (
              <span className="dim">Loading guide…</span>
            )}
          </div>
        </div>
        <button className="mini-button" onClick={toggle} aria-expanded={!collapsed} aria-controls="playground-guide-steps">
          {collapsed ? <ChevronDown size={13} /> : <ChevronUp size={13} />} {collapsed ? 'Show steps' : 'Hide steps'}
        </button>
      </div>
      {!collapsed && guide && (
        <div id="playground-guide-steps" className="guide-body">
          {!tpl ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <p className="muted" style={{ margin: 0, fontSize: 13 }}>
                Choose a bundled contract. You can read its instructions before connecting a wallet; deploying and writing are real testnet transactions that you review and sign.
              </p>
              <div className="guide-templates">
                {(config?.templates ?? []).map((t) => (
                  <button key={t.id} className="choice" onClick={() => void chooseTemplate(t.id)} disabled={!!busy || readOnly} aria-busy={busy === `template:${t.id}`}>
                    <strong style={{ fontSize: 13.5 }}>{t.title}</strong>
                    <span className="dim" style={{ fontSize: 12 }}>{t.outcome}</span>
                    <SharedBadge shared={!!t.sharedContract} />
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <>
              <ol className="guide-steps">
                {guide.steps.map((s) => (
                  <li key={s.id} data-state={s.state}>
                    <span className="guide-icon" title={STATE_LABEL[s.state]}>
                      <StateIcon state={s.state} />
                      <span className="sr-only">{STATE_LABEL[s.state]}: </span>
                    </span>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <strong>{s.title}</strong>
                      <span className="dim">{s.detail}</span>
                    </div>
                    {s.state !== 'done' && action(s.id)}
                  </li>
                ))}
              </ol>
              {guide.contract && !guide.source && !readOnly && (
                <Notice
                  tone={guide.steps.find((s) => s.id === 'event')?.state === 'attention' ? 'warning' : 'info'}
                  title={guide.contract.shared ? `Index ${tpl.event.name} before you write` : `Index ${tpl.event.name} from the deployment block`}
                  action={
                    <button className="button secondary" onClick={() => void startIndexing()} disabled={!!busy} aria-busy={busy === 'source'}>
                      {busy === 'source' ? 'Checking block…' : 'Start indexing'}
                    </button>
                  }
                >
                  {guide.contract.shared ? (
                    <>
                      Creates one log source for {tpl.event.signature} starting at block {guide.contract.attached_block ? groupDigits(guide.contract.attached_block) : 'unknown'}, where this workspace added the shared contract, so your own write is covered. Earlier events of the shared contract, from other visitors, are not indexed here. Running it again reuses the same source.
                    </>
                  ) : (
                    <>
                      Creates one log source for {tpl.event.signature} starting at block {guide.contract.deploy_block ? groupDigits(guide.contract.deploy_block) : 'unknown'}, so events emitted while you continue are covered. The node only keeps recent history, so do this soon after deploying. Running it again reuses the same source.
                    </>
                  )}
                </Notice>
              )}
              {recovery && (
                <Notice
                  tone="warning"
                  title="Deployment block is no longer available"
                  action={
                    recovery.suggestedStartBlock ? (
                      <button className="button secondary" onClick={() => void startIndexing(recovery.suggestedStartBlock!)} disabled={!!busy}>
                        Start at block {groupDigits(recovery.suggestedStartBlock)}
                      </button>
                    ) : undefined
                  }
                >
                  {recovery.message} Choosing a later start block records the uncovered range in Monitoring; PalletDock will not claim coverage for it.
                </Notice>
              )}
              {guide.source && guide.steps.find((s) => s.id === 'event')?.state !== 'done' && (
                <p className="dim" style={{ margin: 0, fontSize: 12 }}>
                  Indexer: {guide.source.status.replace('_', ' ')} · checkpoint {guide.source.checkpoint_block ? groupDigits(guide.source.checkpoint_block) : 'none yet'} · latest observed{' '}
                  {guide.source.latest_observed_block ? groupDigits(guide.source.latest_observed_block) : 'unknown'}. The indexer stays a few blocks behind the head; that delay is not finality, which remains unknown.
                </p>
              )}
              <details className="guide-details">
                <summary>About the {tpl.title} template</summary>
                <ul>
                  <li>{tpl.outcome}</li>
                  {tpl.constructorNotes.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                  <li>{tpl.read.explain}</li>
                  <li>{tpl.write.explain}</li>
                  <li>{tpl.event.explain}</li>
                  {tpl.notes.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
                {!readOnly && (
                  <div className="guide-templates" style={{ marginTop: 8 }}>
                    {(config?.templates ?? [])
                      .filter((t) => t.id !== tpl.id)
                      .map((t) => (
                        <button key={t.id} className="mini-button" onClick={() => void chooseTemplate(t.id)} disabled={!!busy}>
                          Switch to {t.title}
                        </button>
                      ))}
                  </div>
                )}
              </details>
            </>
          )}
          {actionError && <Notice tone="danger">{actionError}</Notice>}
        </div>
      )}
    </section>
  );
}
