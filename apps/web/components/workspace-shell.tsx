'use client';

import Image from 'next/image';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Activity, Braces, ChevronDown, FileText, Gauge, KeyRound, Menu, Network, PanelsTopLeft, Settings, TerminalSquare, WalletCards, X } from 'lucide-react';
import { api } from '@/lib/api';
import type { Owner, Project } from '@/lib/types';

interface WorkspaceValue {
  owner: Owner;
  csrfToken: string;
  projects: Project[];
  project: Project | null;
  projectId: string | null;
  reloadProjects(): Promise<void>;
  request<T>(path: string, init?: RequestInit): Promise<T>;
}
const WorkspaceContext = createContext<WorkspaceValue | null>(null);
export function useWorkspace(): WorkspaceValue { const value = useContext(WorkspaceContext); if (!value) throw new Error('Workspace context missing'); return value; }

const nav = [
  ['Overview', '/app', PanelsTopLeft], ['Projects', '/app/projects', WalletCards], ['Contracts', '/app/contracts', Braces],
  ['Transactions', '/app/transactions', Activity], ['Indexer', '/app/indexer', Gauge], ['API Keys', '/app/api/keys', KeyRound],
  ['Monitoring', '/app/monitoring', TerminalSquare], ['Network', '/app/network', Network], ['Settings', '/app/settings', Settings],
] as const;

export function WorkspaceShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const search = useSearchParams();
  const router = useRouter();
  const [owner, setOwner] = useState<Owner | null>(null);
  const [csrfToken, setCsrfToken] = useState('');
  const [projects, setProjects] = useState<Project[]>([]);
  const [status, setStatus] = useState<'loading'|'ready'|'error'>('loading');
  const [message, setMessage] = useState('');
  const [navOpen, setNavOpen] = useState(false);

  const reloadProjects = useCallback(async () => {
    const result = await api<{ data: Project[] }>('/workspace/projects');
    setProjects(result.data);
  }, []);

  const bootstrap = useCallback(async () => {
    setStatus('loading');
    try {
      const me = await api<{ owner: Owner; csrfToken: string }>('/auth/me');
      setOwner(me.owner); setCsrfToken(me.csrfToken);
      await reloadProjects(); setStatus('ready');
    } catch (error) {
      if ((error as Error & { status?: number }).status === 401) { router.replace(`/login?next=${encodeURIComponent(pathname)}`); return; }
      setMessage((error as Error).message); setStatus('error');
    }
  }, [pathname, reloadProjects, router]);
  useEffect(() => { void bootstrap(); }, [bootstrap]);

  const requested = search.get('project');
  const project = projects.find((item) => item.id === requested) ?? projects.find((item) => !item.archived_at) ?? projects[0] ?? null;
  const request = useCallback(<T,>(path: string, init: RequestInit = {}) => api<T>(path, { ...init, headers: { ...init.headers, 'x-csrf-token': csrfToken } }), [csrfToken]);
  const value = useMemo(() => owner ? ({ owner, csrfToken, projects, project, projectId: project?.id ?? null, reloadProjects, request }) : null, [owner, csrfToken, projects, project, reloadProjects, request]);

  if (status === 'loading' || !value) return <div className="workspace-loading" aria-busy="true"><div className="skeleton" style={{ width: 220, height: '100vh' }} /><div style={{ flex: 1, padding: 32 }}><div className="skeleton" style={{ width: 220, height: 30, marginBottom: 24 }} /><div className="skeleton" style={{ height: 180 }} /></div></div>;
  if (status === 'error') return <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24 }}><div className="notice error"><div><strong>Workspace data could not be loaded</strong><p style={{ margin: '4px 0 12px' }}>{message}</p><button className="button secondary" onClick={() => void bootstrap()}>Try again</button></div></div></main>;

  const switchProject = (id: string) => { const params = new URLSearchParams(search.toString()); params.set('project', id); router.replace(`${pathname}?${params}`); };
  const active = (href: string) => href === '/app' ? pathname === href : pathname.startsWith(href);
  const crumb = nav.find(([hrefLabel, href]) => active(href))?.[0] ?? 'Workspace';

  return <WorkspaceContext.Provider value={value}><div className="workspace">
    {navOpen && <button className="nav-scrim" aria-label="Close navigation" onClick={() => setNavOpen(false)} />}
    <aside className={`workspace-sidebar ${navOpen ? 'open' : ''}`} aria-label="Primary">
      <div className="sidebar-brand"><Link href="/"><Image src="/palletdock-logo.png" alt="PalletDock" width={2172} height={724} style={{ width: 'auto', height: 46, filter: 'invert(1)', margin: '-10px -8px' }} /></Link><button className="icon-button sidebar-close" aria-label="Close navigation" onClick={() => setNavOpen(false)}><X size={17} /></button></div>
      <div className="project-picker"><label htmlFor="project-switch">Project</label><div style={{ position: 'relative' }}><select id="project-switch" value={project?.id ?? ''} onChange={(event) => switchProject(event.target.value)} disabled={!projects.length}>{projects.length ? projects.map((item) => <option value={item.id} key={item.id}>{item.name}</option>) : <option value="">No projects</option>}</select><ChevronDown size={14} aria-hidden="true" /></div><Link href="/app/projects" className={active('/app/projects') ? 'all-projects active' : 'all-projects'}>All projects <span className="mono">{projects.length}</span></Link></div>
      <nav className="workspace-nav" aria-label="Project">{nav.filter(([label]) => label !== 'Projects').map(([label,href,Icon]) => <Link key={href} href={`${href}${project ? `?project=${project.id}` : ''}`} aria-current={active(href) ? 'page' : undefined} onClick={() => setNavOpen(false)}><Icon size={15} aria-hidden="true" /><span>{label}</span>{['Contracts','Transactions','Indexer','Monitoring','Settings'].includes(label) && <span className="nav-state" title="Backend slice in progress">·</span>}</Link>)}</nav>
      <div className="sidebar-foot"><Link href="/docs"><FileText size={15} aria-hidden="true" /> Documentation</Link><div className="mono">Portaldot V3 Testnet<br />EVM chain 420420777</div></div>
    </aside>
    <div className="workspace-body"><header className="workspace-header"><div className="crumb"><button className="icon-button menu-button" aria-label="Open navigation" onClick={() => setNavOpen(true)}><Menu size={18} /></button><span className="crumb-project">{project?.name ?? 'Workspace'} <span>/</span></span><strong>{crumb}</strong></div><div className="header-actions"><span className="network-chip">Portaldot V3 Testnet <span className="mono">0x190f1ca9</span></span><span className="signer-chip"><span className="status-dot" /> Read-only</span></div></header>{project?.archived_at && <div className="archived-banner"><strong>Archived project</strong><span>Workspace configuration is read-only. On-chain resources are unchanged.</span></div>}<main className="workspace-main">{children}</main></div>
  </div></WorkspaceContext.Provider>;
}
