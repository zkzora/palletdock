'use client';

import Image from 'next/image';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Activity, Braces, ChevronDown, Clock, FileText, Gauge, KeyRound, LogOut, Menu, PanelsTopLeft, Settings, TerminalSquare, X } from 'lucide-react';
import { WORKSPACE_EXPIRED_EVENT, api, type ApiError } from '@/lib/api';
import type { Owner, Project, SessionInfo } from '@/lib/types';
import { WalletProvider, useWallet } from '@/lib/wallet';
import { shortAddr } from '@/lib/format';
import { CopyButton, Modal, Notice } from '@/components/ui';
import { useSpotlight } from '@/components/motion';
import { PlaygroundGuide } from '@/components/playground-guide';
import { PORTALDOT_ADD_CHAIN_PARAMS } from '@/lib/wallet-core';
import { NETWORK } from '@/lib/network';

interface WorkspaceValue {
  owner: Owner;
  /** Account or temporary playground guest; guests get restrictions explained instead of hidden pages. */
  session: SessionInfo;
  guest: boolean;
  /** The EVM RPC is a local fixture chain (labelled FIXTURE NETWORK), not Portaldot. */
  fixture: boolean;
  csrfToken: string;
  projects: Project[];
  project: Project | null;
  projectId: string | null;
  readOnly: boolean;
  reloadProjects(): Promise<void>;
  request<T>(path: string, init?: RequestInit): Promise<T>;
  href(path: string): string;
  openSigner(): void;
}
const WorkspaceContext = createContext<WorkspaceValue | null>(null);
export function useWorkspace(): WorkspaceValue {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error('Workspace context missing');
  return value;
}

const nav = [
  ['Overview', '/app', PanelsTopLeft],
  ['Contracts', '/app/contracts', Braces],
  ['Transactions', '/app/transactions', Activity],
  ['Indexer', '/app/indexer', Gauge],
  ['API', '/app/api', KeyRound],
  ['Monitoring', '/app/monitoring', TerminalSquare],
  ['Settings', '/app/settings', Settings],
] as const;

export function WorkspaceShell({ children }: { children: React.ReactNode }) {
  return (
    <WalletProvider>
      <Shell>{children}</Shell>
    </WalletProvider>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const spotlight = useSpotlight<HTMLElement>();
  const search = useSearchParams();
  const router = useRouter();
  const wallet = useWallet();
  const [owner, setOwner] = useState<Owner | null>(null);
  const [session, setSession] = useState<SessionInfo>({ kind: 'account', expiresAt: null });
  const [csrfToken, setCsrfToken] = useState('');
  const [projects, setProjects] = useState<Project[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error' | 'expired'>('loading');
  const [endSession, setEndSession] = useState(false);
  const [message, setMessage] = useState('');
  const [navOpen, setNavOpen] = useState(false);
  const [signerOpen, setSignerOpen] = useState(false);
  const [fixture, setFixture] = useState(false);

  const reloadProjects = useCallback(async () => {
    const result = await api<{ data: Project[] }>('/workspace/projects');
    setProjects(result.data);
  }, []);

  const bootstrap = useCallback(async () => {
    setStatus('loading');
    try {
      const me = await api<{ owner: Owner; session: SessionInfo; csrfToken: string }>('/auth/me');
      setOwner(me.owner);
      setSession(me.session);
      setCsrfToken(me.csrfToken);
      await reloadProjects();
      setStatus('ready');
    } catch (error) {
      if ((error as ApiError).code === 'WORKSPACE_EXPIRED') {
        setStatus('expired');
        return;
      }
      if ((error as ApiError).status === 401) {
        router.replace(`/login?next=${encodeURIComponent(pathname)}`);
        return;
      }
      setMessage((error as Error).message);
      setStatus('error');
    }
    // pathname intentionally excluded: bootstrap once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadProjects, router]);
  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);
  useEffect(() => {
    const onExpired = () => setStatus('expired');
    window.addEventListener(WORKSPACE_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(WORKSPACE_EXPIRED_EVENT, onExpired);
  }, []);
  // A temporary workspace ends at its fixed expiry; the page follows without waiting for a failed request.
  useEffect(() => {
    if (status !== 'ready' || session.kind !== 'guest' || !session.expiresAt) return;
    const ms = new Date(session.expiresAt).getTime() - Date.now();
    const t = setTimeout(() => setStatus('expired'), Math.max(0, ms));
    return () => clearTimeout(t);
  }, [status, session]);
  useEffect(() => {
    if (status !== 'ready') return;
    api<{ data: { config: { fixture?: boolean } } }>('/workspace/network')
      .then((r) => setFixture(!!r.data.config.fixture))
      .catch(() => {});
  }, [status]);

  const requested = search.get('project');
  const project = projects.find((item) => item.id === requested) ?? projects.find((item) => !item.archived_at) ?? projects[0] ?? null;
  const request = useCallback(
    <T,>(path: string, init: RequestInit = {}) => api<T>(path, { ...init, headers: { ...init.headers, 'x-csrf-token': csrfToken } }),
    [csrfToken],
  );
  const href = useCallback((path: string) => (project ? `${path}${path.includes('?') ? '&' : '?'}project=${project.id}` : path), [project]);

  const value = useMemo(
    () =>
      owner
        ? {
            owner,
            session,
            guest: session.kind === 'guest',
            fixture,
            csrfToken,
            projects,
            project,
            projectId: project?.id ?? null,
            readOnly: !!project?.archived_at,
            reloadProjects,
            request,
            href,
            openSigner: () => setSignerOpen(true),
          }
        : null,
    [owner, session, fixture, csrfToken, projects, project, reloadProjects, request, href],
  );

  if (status === 'expired') return <ExpiredWorkspace />;

  if (status === 'loading' || (!value && status !== 'error'))
    return (
      <div className="workspace-loading" aria-busy="true">
        <div className="skeleton" style={{ width: 220, height: '100vh' }} />
        <div style={{ flex: 1, padding: 32 }}>
          <div className="skeleton" style={{ width: 220, height: 30, marginBottom: 24 }} />
          <div className="skeleton" style={{ height: 180 }} />
        </div>
      </div>
    );
  if (status === 'error' || !value)
    return (
      <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24 }}>
        <div className="notice error">
          <div>
            <strong>Workspace data could not be loaded</strong>
            <p style={{ margin: '4px 0 12px' }}>{message}</p>
            <button className="button secondary" onClick={() => void bootstrap()}>
              Try again
            </button>
          </div>
        </div>
      </main>
    );

  const switchProject = (id: string) => {
    router.push(`/app?project=${id}`);
  };
  const active = (h: string) => (h === '/app' ? pathname === h : pathname.startsWith(h));
  const crumb = pathname.startsWith('/app/projects') ? 'Projects' : pathname.startsWith('/app/network') ? 'Network' : (nav.find(([, h]) => active(h))?.[0] ?? 'Workspace');

  const signer = !wallet.account ? (
    <button className="wallet-chip primary" onClick={() => setSignerOpen(true)}>
      Connect wallet
    </button>
  ) : !wallet.onPortaldot ? (
    <button className="wallet-chip warn" onClick={() => setSignerOpen(true)}>
      Wrong network
    </button>
  ) : (
    <button className="wallet-chip" onClick={() => setSignerOpen(true)}>
      {shortAddr(wallet.account)}
    </button>
  );

  return (
    <WorkspaceContext.Provider value={value}>
      <div className="workspace">
        {navOpen && <button className="nav-scrim" aria-label="Close navigation" onClick={() => setNavOpen(false)} />}
        <aside className={`workspace-sidebar ${navOpen ? 'open' : ''}`} aria-label="Primary">
          <div className="sidebar-brand">
            <Link href="/">
              <Image src="/palletdock-logo.png" alt="PalletDock" width={2172} height={724} style={{ width: 'auto', height: 46, filter: 'invert(1)', margin: '-10px -8px' }} />
            </Link>
            <button className="icon-button sidebar-close" aria-label="Close navigation" onClick={() => setNavOpen(false)}>
              <X size={17} />
            </button>
          </div>
          <div className="project-picker">
            <label htmlFor="project-switch">Project</label>
            <div style={{ position: 'relative' }}>
              <select id="project-switch" value={project?.id ?? ''} onChange={(event) => switchProject(event.target.value)} disabled={!projects.length}>
                {projects.length ? (
                  projects.map((item) => (
                    <option value={item.id} key={item.id}>
                      {item.name}
                      {item.archived_at ? ' (archived)' : ''}
                    </option>
                  ))
                ) : (
                  <option value="">No projects</option>
                )}
              </select>
              <ChevronDown size={14} aria-hidden="true" />
            </div>
            <Link href={href('/app/projects')} className={active('/app/projects') ? 'all-projects active' : 'all-projects'} onClick={() => setNavOpen(false)}>
              All projects <span className="mono">{projects.length}</span>
            </Link>
          </div>
          <nav className="workspace-nav" aria-label="Project">
            {nav.map(([label, h, Icon]) => (
              <Link key={h} href={href(h)} aria-current={active(h) ? 'page' : undefined} onClick={() => setNavOpen(false)}>
                <Icon size={15} aria-hidden="true" />
                <span>{label}</span>
              </Link>
            ))}
          </nav>
          <div className="sidebar-foot">
            <Link href="/docs">
              <FileText size={15} aria-hidden="true" /> Documentation
            </Link>
            <button
              className="all-projects"
              style={{ width: '100%', border: 0, background: 'transparent' }}
              onClick={async () => {
                if (value.guest) return setEndSession(true);
                await request('/auth/logout', { method: 'POST' }).catch(() => {});
                router.replace('/login');
              }}
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                <LogOut size={15} aria-hidden="true" /> {value.guest ? 'End temporary session' : 'Sign out'}
              </span>
            </button>
            <div className="mono">
              {NETWORK.label}
              <br />
              EVM chain {NETWORK.chainId}
            </div>
          </div>
        </aside>
        <div className="workspace-body">
          <header className="workspace-header">
            <div className="crumb">
              <button className="icon-button menu-button" aria-label="Open navigation" onClick={() => setNavOpen(true)}>
                <Menu size={18} />
              </button>
              <span className="crumb-project">
                {project?.name ?? 'Workspace'} <span>/</span>
              </span>
              <strong>{crumb}</strong>
            </div>
            <div className="header-actions">
              {value.guest && session.expiresAt && <TemporaryChip expiresAt={session.expiresAt} />}
              {value.guest && (
                <Link className="button secondary save-workspace" href="/signup?save=1">
                  Save workspace
                </Link>
              )}
              <Link className="network-chip" href={href('/app/network')} style={{ textDecoration: 'none' }}>
                {NETWORK.label} <span className="mono">{NETWORK.chainIdHex}</span>
              </Link>
              {signer}
            </div>
          </header>
          {fixture && (
            <div className="archived-banner" role="note" style={{ background: '#1a1712', borderColor: '#3d3320', color: '#e6d3a8' }}>
              <strong>FIXTURE NETWORK</strong>
              <span style={{ color: '#d9c9a6' }}>The EVM RPC is a local test chain, not the live Portaldot network. Results here are test fixtures, never live evidence.</span>
            </div>
          )}
          {project?.archived_at && (
            <div className="archived-banner">
              <strong>Archived project</strong>
              <span>Indexer jobs are stopped and workspace data is read-only. On-chain resources are unchanged.</span>
            </div>
          )}
          <main ref={spotlight} className="workspace-main">
            {project?.playground && <PlaygroundGuide />}
            <div key={pathname} className="page-enter">
              {children}
            </div>
          </main>
        </div>
        {signerOpen && <SignerDialog onClose={() => setSignerOpen(false)} />}
        {endSession && (
          <Modal
            title="End temporary session"
            onClose={() => setEndSession(false)}
            footer={
              <>
                <button className="button secondary" onClick={() => setEndSession(false)} data-autofocus>
                  Keep working
                </button>
                <Link className="button secondary" href="/signup?save=1">
                  Save workspace
                </Link>
                <button
                  className="button danger"
                  onClick={async () => {
                    await request('/auth/logout', { method: 'POST' }).catch(() => {});
                    router.replace('/playground');
                  }}
                >
                  End session
                </button>
              </>
            }
          >
            <p style={{ margin: 0, lineHeight: 1.55, color: '#c4c8ce' }}>
              This temporary workspace has no password. Ending the session (or clearing this browser&apos;s cookies) removes your access to it, and it cannot be reopened. Contracts and transactions you
              submitted stay on the testnet; PalletDock cannot reverse on-chain actions.
            </p>
          </Modal>
        )}
      </div>
    </WorkspaceContext.Provider>
  );
}

function TemporaryChip({ expiresAt }: { expiresAt: string }) {
  const at = new Date(expiresAt);
  const label = at.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  return (
    <span className="temp-chip" title={`Temporary workspace. Off-chain access ends ${label}.`}>
      <Clock size={13} aria-hidden="true" />
      <span className="temp-label">Temporary playground · expires</span>
      <span className="temp-label-short" aria-hidden="true">
        Temporary · until
      </span>
      <time dateTime={expiresAt}>{at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
    </span>
  );
}

/** Shown once a temporary workspace's fixed lifetime has ended. */
function ExpiredWorkspace() {
  return (
    <main className="login-page">
      <section className="login-panel" aria-labelledby="expired-title">
        <div className="eyebrow">Playground</div>
        <h1 id="expired-title" className="page-title" style={{ fontSize: 26 }}>
          This temporary workspace expired
        </h1>
        <p className="muted" style={{ margin: 0, lineHeight: 1.6 }}>
          Its off-chain access ended at the fixed expiry: the session and read keys are revoked and its indexer and receipt tracking stopped. Contracts you deployed and transactions you signed remain on
          the testnet; PalletDock cannot reverse on-chain actions.
        </p>
        <div className="form-actions" style={{ marginTop: 0 }}>
          <Link className="button" href="/playground">
            Start a new playground
          </Link>
          <Link className="button secondary" href="/login">
            Sign in
          </Link>
        </div>
      </section>
    </main>
  );
}

function NetworkDetails() {
  const [probe, setProbe] = useState<{ status: string; observed_at: string; error: string | null } | null | undefined>(undefined);
  useEffect(() => {
    api<{ data: { probes: Array<{ target: string; status: string; observed_at: string; error: string | null }> } }>('/workspace/network')
      .then((r) => setProbe(r.data.probes.find((p) => p.target === 'evm') ?? null))
      .catch(() => setProbe(null));
  }, []);
  const rows: Array<[string, string]> = [
    ['Network name', PORTALDOT_ADD_CHAIN_PARAMS.chainName],
    ['RPC URL', PORTALDOT_ADD_CHAIN_PARAMS.rpcUrls[0]],
    ['Chain ID', String(NETWORK.chainId)],
    ['Currency symbol', PORTALDOT_ADD_CHAIN_PARAMS.nativeCurrency.symbol],
    ['Environment', NETWORK.environment],
  ];
  const down = probe && probe.status !== 'responded';
  return (
    <div className="card panel" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <strong style={{ fontSize: 13.5 }}>{NETWORK.label} network details</strong>
      {probe === undefined ? null : !probe ? (
        <span className="dim" style={{ fontSize: 12 }}>EVM RPC status: not probed yet.</span>
      ) : (
        <span className={down ? 'warning-text' : 'success-text'} style={{ fontSize: 12, lineHeight: 1.5 }}>
          EVM RPC {down ? 'not responding' : 'responding'} at last probe ({new Date(probe.observed_at).toLocaleTimeString()}){down && probe.error ? `: ${probe.error}` : ''}.
          {down ? ' Wallets check the RPC before adding a network, so adding will likely fail until it responds.' : ''}
        </span>
      )}
      <dl className="kv">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              {v} <CopyButton text={v} label={`Copy ${k}`} />
            </dd>
          </div>
        ))}
        <div>
          <dt>Block explorer</dt>
          <dd className="dim">Leave empty (none confirmed)</dd>
        </div>
      </dl>
    </div>
  );
}

function SignerDialog({ onClose }: { onClose(): void }) {
  const wallet = useWallet();
  const [switching, setSwitching] = useState(false);
  return (
    <Modal
      title="Signer"
      onClose={onClose}
      footer={
        <>
          {wallet.account && (
            <button className="button secondary" onClick={() => wallet.disconnect()}>
              Forget in this tab
            </button>
          )}
          <button className="button ghost" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      <p className="muted" style={{ margin: 0, fontSize: 13, lineHeight: 1.55 }}>
        Writes are signed in your browser wallet after you review them. PalletDock never asks for a seed phrase or private key, and a connected wallet does not unlock workspace data.
      </p>
      {!wallet.available && <Notice tone="warning" title="No browser wallet detected">Install MetaMask (recommended) to deploy or write. Reads and indexed data work without a wallet.</Notice>}
      {wallet.available && wallet.walletName !== 'MetaMask' && (
        <Notice tone={wallet.walletName ? 'warning' : 'info'} title="Use MetaMask">
          {wallet.walletName ? `${wallet.walletName} detected. ` : ''}
          PalletDock is tested with MetaMask. Rabby and some other wallets do not support Portaldot V3 (chain 420420777) and can fail when adding the network or signing. If connecting, switching, or signing fails, use MetaMask.
        </Notice>
      )}
      {wallet.available && !wallet.account && (
        <button className="choice" onClick={() => void wallet.connect()} disabled={wallet.connecting} data-autofocus>
          <strong>{wallet.connecting ? 'Waiting for the wallet…' : wallet.walletName === 'MetaMask' ? 'Connect MetaMask' : 'Connect EVM wallet'}</strong>
          <span className="mono dim" style={{ fontSize: 12 }}>
            Requests account access only (eth_requestAccounts)
          </span>
        </button>
      )}
      {wallet.account && (
        <div className="card panel">
          <div className="kv">
            <div>
              <dt>EVM account</dt>
              <dd>{wallet.account}</dd>
            </div>
            <div>
              <dt>Wallet chain</dt>
              <dd className={wallet.onPortaldot ? 'success-text' : 'warning-text'}>{wallet.chainId ? `${wallet.chainId} (${BigInt(wallet.chainId).toString()})` : 'Unknown'}</dd>
            </div>
          </div>
          {!wallet.onPortaldot && (
            <div style={{ marginTop: 10 }}>
              <Notice
                tone="warning"
                title="Wrong network"
                action={
                  <button
                    className="button secondary"
                    disabled={switching}
                    aria-busy={switching}
                    onClick={async () => {
                      setSwitching(true);
                      await wallet.switchNetwork();
                      setSwitching(false);
                    }}
                  >
                    {switching ? 'Check your wallet…' : 'Switch / add Portaldot V3'}
                  </button>
                }
              >
                The wallet must use EVM chain 420420777 (0x190f1ca9). If the wallet does not know this network, PalletDock asks it to add it; you approve that in the wallet.
              </Notice>
            </div>
          )}
        </div>
      )}
      {wallet.error && <Notice tone="danger">{wallet.error}</Notice>}
      {wallet.available && (!wallet.account || !wallet.onPortaldot) && <NetworkDetails />}
      <div className="card panel" style={{ borderStyle: 'dashed', opacity: 0.8 }}>
        <div className="panel-row">
          <strong style={{ fontSize: 13.5 }}>Native signer (SS58)</strong>
          <span className="chip dashed">Planned</span>
        </div>
        <span className="dim" style={{ fontSize: 12 }}>
          Native Revive calls need their own signing path and weight review.
        </span>
      </div>
    </Modal>
  );
}
