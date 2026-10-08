'use client';

import Image from 'next/image';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Activity, Braces, ChevronDown, FileText, Gauge, KeyRound, LogOut, Menu, PanelsTopLeft, Settings, TerminalSquare, X } from 'lucide-react';
import { api } from '@/lib/api';
import type { Owner, Project } from '@/lib/types';
import { WalletProvider, useWallet } from '@/lib/wallet';
import { shortAddr } from '@/lib/format';
import { Modal, Notice } from '@/components/ui';

interface WorkspaceValue {
  owner: Owner;
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
  const search = useSearchParams();
  const router = useRouter();
  const wallet = useWallet();
  const [owner, setOwner] = useState<Owner | null>(null);
  const [csrfToken, setCsrfToken] = useState('');
  const [projects, setProjects] = useState<Project[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
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
      const me = await api<{ owner: Owner; csrfToken: string }>('/auth/me');
      setOwner(me.owner);
      setCsrfToken(me.csrfToken);
      await reloadProjects();
      setStatus('ready');
    } catch (error) {
      if ((error as Error & { status?: number }).status === 401) {
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
    [owner, csrfToken, projects, project, reloadProjects, request, href],
  );

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
      <span className="status-dot warning" /> Wrong network
    </button>
  ) : (
    <button className="wallet-chip" onClick={() => setSignerOpen(true)}>
      <span className="status-dot success" /> {shortAddr(wallet.account)}
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
                await request('/auth/logout', { method: 'POST' }).catch(() => {});
                router.replace('/login');
              }}
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                <LogOut size={15} aria-hidden="true" /> Sign out
              </span>
            </button>
            <div className="mono">
              Portaldot V3 Testnet
              <br />
              EVM chain 420420777
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
              <Link className="network-chip" href={href('/app/network')} style={{ textDecoration: 'none' }}>
                Portaldot V3 Testnet <span className="mono">0x190f1ca9</span>
              </Link>
              {signer}
            </div>
          </header>
          {fixture && (
            <div className="archived-banner" role="note" style={{ background: '#1a1712', borderColor: '#3d3320', color: '#e6d3a8' }}>
              <strong>FIXTURE NETWORK</strong>
              <span style={{ color: '#d9c9a6' }}>The EVM RPC is a local test chain, not Portaldot V3 Testnet. Results here are test fixtures, never live evidence.</span>
            </div>
          )}
          {project?.archived_at && (
            <div className="archived-banner">
              <strong>Archived project</strong>
              <span>Indexer jobs are stopped and workspace data is read-only. On-chain resources are unchanged.</span>
            </div>
          )}
          <main className="workspace-main">{children}</main>
        </div>
        {signerOpen && <SignerDialog onClose={() => setSignerOpen(false)} />}
      </div>
    </WorkspaceContext.Provider>
  );
}

function SignerDialog({ onClose }: { onClose(): void }) {
  const wallet = useWallet();
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
      {!wallet.available && <Notice tone="warning" title="No browser wallet detected">Install an EVM wallet extension (for example MetaMask) to deploy or write. Reads and indexed data work without a wallet.</Notice>}
      {wallet.available && !wallet.account && (
        <button className="choice" onClick={() => void wallet.connect()} disabled={wallet.connecting} data-autofocus>
          <strong>{wallet.connecting ? 'Waiting for the wallet…' : 'Connect EVM wallet'}</strong>
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
              <Notice tone="warning" title="Wrong network" action={<button className="button secondary" onClick={() => void wallet.switchNetwork()}>Switch to Portaldot V3</button>}>
                The wallet must use EVM chain 420420777 (0x190f1ca9). Writes are blocked until it does.
              </Notice>
            </div>
          )}
        </div>
      )}
      {wallet.error && <Notice tone="danger">{wallet.error}</Notice>}
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
