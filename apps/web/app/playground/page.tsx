'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { PublicPage, Section, Para } from '@/components/public-page';
import { Notice } from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { PLAYGROUND_INTENT, lifetimeLabel, usePlaygroundConfig, type PlaygroundTemplate } from '@/lib/playground';
import { SharedBadge } from '@/components/playground-guide';
import type { Owner, SessionInfo } from '@/lib/types';

type Me = { owner: Owner; session: SessionInfo; csrfToken: string } | null;

/**
 * Public playground entry. Rendering, prefetching, and every GET here are side-effect
 * free; a temporary workspace is created only by the explicit Start button.
 */
export default function PlaygroundPage() {
  const router = useRouter();
  const { config, error: configError } = usePlaygroundConfig();
  const [me, setMe] = useState<Me | undefined>(undefined);
  const [choice, setChoice] = useState<PlaygroundTemplate['id']>('storage');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api<NonNullable<Me>>('/auth/me')
      .then(setMe)
      .catch(() => setMe(null));
  }, []);

  async function start() {
    setError('');
    setBusy(true);
    try {
      const r = await api<{ created: boolean; session: SessionInfo; projectId: string | null; csrfToken?: string }>('/auth/playground', {
        method: 'POST',
        headers: PLAYGROUND_INTENT,
        body: JSON.stringify({ template: choice }),
      });
      if (r.session.kind === 'account') {
        setError('You are already signed in. Your account stays signed in; open your workspace or create a sample project below.');
        setMe(await api<NonNullable<Me>>('/auth/me').catch(() => null));
        return;
      }
      // Add the shared, already deployed copy so the visitor can skip deployment. If it fails,
      // the guide offers the same action again (and deploying their own).
      if (r.created && r.projectId && r.csrfToken && config?.templates.find((t) => t.id === choice)?.sharedContract) {
        await api(`/workspace/projects/${r.projectId}/playground/shared-contract`, { method: 'POST', headers: { 'x-csrf-token': r.csrfToken } }).catch(() => undefined);
      }
      router.push(r.projectId ? `/app?project=${r.projectId}` : '/app');
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  async function sampleProject() {
    if (!me) return;
    setError('');
    setBusy(true);
    try {
      const r = await api<{ data: { id: string } }>('/workspace/projects', {
        method: 'POST',
        headers: { 'x-csrf-token': me.csrfToken },
        body: JSON.stringify({ name: `Playground sample ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`, description: 'Guided sample project.', playground: true }),
      });
      router.push(`/app?project=${r.data.id}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const lifetime = config ? lifetimeLabel(config.lifetimeMinutes) : '';
  const account = me?.session.kind === 'account';
  const guest = me?.session.kind === 'guest';

  return (
    <PublicPage
      eyebrow="Playground"
      title="Try the PalletDock workspace"
      intro="Open a temporary workspace without an email or password. It is the full PalletDock dashboard with one project, a bundled contract template, and a short guided checklist from deployment to the project API."
    >
      {configError && <Notice tone="danger" title="Playground information could not be loaded">{configError}</Notice>}
      {config && !config.enabled && (
        <Notice tone="warning" title="The playground is not enabled on this deployment">
          Sign in or create an account to use the workspace. <Link href="/login">Sign in</Link> · <Link href="/signup">Create an account</Link>
        </Notice>
      )}

      {account && (
        <Notice
          tone="info"
          title={`You are signed in${me?.owner.email ? ` as ${me.owner.email}` : ''}`}
          action={
            <div className="form-actions" style={{ marginTop: 0 }}>
              <Link className="button secondary" href="/app">
                Open workspace
              </Link>
              <button className="button" onClick={() => void sampleProject()} disabled={busy} aria-busy={busy}>
                Create a sample project
              </button>
            </div>
          }
        >
          A temporary workspace never replaces your account session. A sample project in your own workspace gets the same guided checklist and is kept like any other project.
        </Notice>
      )}
      {guest && me?.session.expiresAt && (
        <Notice tone="info" title="Your temporary workspace is still open" action={<Link className="button" href="/app">Continue</Link>}>
          Off-chain access ends {new Date(me.session.expiresAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}.
        </Notice>
      )}

      <Section title="Choose a template">
        <Para text="Each template is a bundled, reproducibly compiled contract. Templates marked ready already have a shared copy on the testnet, so you skip deployment and only sign a small write. For the others you deploy your own copy, which needs a storage deposit in test tPOT that grows with the contract's size. Nothing is sent until you review and sign in your wallet." />
        {!config ? (
          <div className="skeleton" style={{ height: 160 }} aria-busy="true" />
        ) : (
          <div className="grid-cards" role="group" aria-label="Templates">
            {config.templates.map((t) => (
              <button key={t.id} type="button" className="choice" aria-pressed={choice === t.id} onClick={() => setChoice(t.id)}>
                <strong style={{ fontSize: 14.5 }}>{t.title}</strong>
                <span className="dim" style={{ fontSize: 12.5 }}>{t.summary}</span>
                <span style={{ fontSize: 12.5, color: '#c4c8ce', lineHeight: 1.5 }}>{t.outcome}</span>
                <span className="mono dim" style={{ fontSize: 11.5 }}>
                  {t.contractName} · event {(t.sharedContract ? (t.shared.event ?? t.event) : t.event).signature}
                </span>
                <SharedBadge shared={!!t.sharedContract} />
              </button>
            ))}
          </div>
        )}
        {error && <Notice tone="danger">{error}</Notice>}
        {config?.enabled && !account && (
          <div className="form-actions" style={{ marginTop: 4, alignItems: 'center' }}>
            <button className="button" onClick={() => void start()} disabled={busy} aria-busy={busy}>
              {busy ? 'Opening workspace…' : guest ? 'Continue temporary workspace' : 'Start temporary workspace'}
            </button>
            <span className="dim" style={{ fontSize: 12.5 }}>No email, password, or wallet needed to start.</span>
          </div>
        )}
      </Section>

      <Section title="Real testnet transactions">
        <Para text={`Deploying and writing send real transactions to ${config?.network.name ?? 'Portaldot V3 Testnet'} (EVM chain ${config?.network.evmChainId ?? 420420777}). Your wallet is asked to connect only when you choose to deploy or write, and every request is shown for review before you sign. PalletDock never holds keys or seed phrases.`} />
        <Para text="Use MetaMask. It is the wallet PalletDock is tested with; Rabby and some other wallets do not support Portaldot V3 and can fail when adding the network or signing." />
        <Para text="Signing needs test tPOT in your wallet for fees (and for the payment amount in the Payments template). See [Funding](/docs/funding). PalletDock does not send test tokens." />
      </Section>

      <Section title="How long it lasts">
        <Para
          text={`A temporary workspace lasts ${lifetime || 'a few hours'} from the moment you start it; activity does not extend it. It holds one project, up to ${config?.limits.contracts ?? 2} tracked contracts, ${config?.limits.indexerSources ?? 1} indexer source, and ${config?.limits.readKeys ?? 1} read key.`}
        />
        <Para text="When it expires, its session and read keys are revoked and its indexing and receipt tracking stop. Clearing this browser's cookies before then also loses access, because a temporary workspace has no password." />
        <Para text="Contracts you deploy and transactions you sign stay on the testnet after the workspace expires. PalletDock cannot reverse on-chain actions." />
        <Para text="To keep the workspace, choose Save workspace inside it to register an account; the project, contracts, transactions, and checklist progress move to that account." />
      </Section>
    </PublicPage>
  );
}
