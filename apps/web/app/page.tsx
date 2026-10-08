import Image from 'next/image';
import Link from 'next/link';

const workflow = [
  ['01', 'Create a project', 'Keep contracts, keys, and indexer jobs inside one network-scoped workspace.'],
  ['02', 'Import or deploy', 'Attach a compatible artifact or connect a contract already deployed on Portaldot.'],
  ['03', 'Read and write', 'Use ABI-aware forms while every write remains subject to human wallet approval.'],
  ['04', 'Track the outcome', 'Keep submission, inclusion, execution, finality, and indexing as separate facts.'],
  ['05', 'Index the event', 'Process bounded log ranges with durable checkpoints and raw-log preservation.'],
  ['06', 'Query the API', 'Read project data with scoped keys and explicit coverage and freshness context.'],
];

export default function LandingPage() {
  return <div style={{ minHeight: '100vh' }}>
    <header style={{ position: 'sticky', top: 0, zIndex: 20, borderBottom: '1px solid var(--border)', background: 'rgba(14,15,17,.9)', backdropFilter: 'blur(8px)' }}>
      <div className="container" style={{ height: 60, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
        <Link href="/" aria-label="PalletDock home"><Image src="/palletdock-logo.png" alt="PalletDock" width={2172} height={724} priority style={{ width: 'auto', height: 46, filter: 'invert(1)', margin: '-8px' }} /></Link>
        <nav aria-label="Page" style={{ display: 'flex', alignItems: 'center', gap: 22, fontSize: 13 }}>
          <a href="#workflow" className="muted" style={{ textDecoration: 'none' }}>Workflow</a>
          <a href="#capabilities" className="muted" style={{ textDecoration: 'none' }}>Capabilities</a>
          <Link href="/login" className="button" style={{ minHeight: 34, paddingInline: 14 }}>Open workspace</Link>
        </nav>
      </div>
    </header>
    <main>
      <section className="container" style={{ paddingBlock: '88px 64px', display: 'flex', flexDirection: 'column', gap: 28 }}>
        <div className="eyebrow">Developer workspace for Portaldot</div>
        <h1 style={{ margin: 0, maxWidth: 900, fontSize: 'clamp(38px,6vw,64px)', fontWeight: 600, letterSpacing: '-.03em', lineHeight: 1.04, textWrap: 'balance' }}>Deploy, index and monitor Portaldot contracts in one workspace.</h1>
        <p className="muted" style={{ margin: 0, maxWidth: 650, fontSize: 17, lineHeight: 1.6 }}>Organize contracts by project, preserve transaction evidence, index events, expose scoped read APIs, and inspect real RPC observations without confusing unknown state for success.</p>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}><Link href="/login" className="button">Open the workspace</Link><a href="#workflow" className="button secondary">See the workflow</a></div>
        <div className="notice" style={{ maxWidth: 760 }}><span className="status-dot warning" aria-hidden="true" /><span><strong>MVP in development.</strong> The local workspace and read API are connected. Live testnet acceptance remains dependent on reachable Portaldot RPCs and human wallet approval.</span></div>
      </section>

      <section aria-label="Product preview" className="container" style={{ paddingBottom: 96 }}>
        <div className="card" style={{ overflow: 'hidden', background: '#111214' }}>
          <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', color: 'var(--dim)', fontSize: 12.5 }}><span>Project workspace <span style={{ color: '#55595f', paddingInline: 8 }}>/</span><strong style={{ color: 'var(--foreground)' }}>Overview</strong></span><span className="badge">Portaldot V3 Testnet <span className="mono dim">0x190f1ca9</span></span></div>
          <div style={{ padding: 22, display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(170px,1fr))' }}>
            {[
              ['01 · Projects', 'Persistent', 'Database-backed workspace', 'success'],
              ['02 · Network', 'Observed', 'Failed probes stay unavailable', 'warning'],
              ['03 · API', 'Scoped', 'Project read keys', 'success'],
              ['04 · Indexer', 'Next slice', 'Lease and checkpoint worker', 'info'],
            ].map(([k,v,n,s]) => <div key={k} style={{ minHeight: 118, padding: 16, border: '1px solid var(--border)', margin: '0 -1px -1px 0', display: 'flex', flexDirection: 'column', gap: 10 }}><span className="mono dim" style={{ fontSize: 11 }}>{k}</span><strong style={{ fontSize: 16 }}>{v}</strong><span className="muted" style={{ marginTop: 'auto', display: 'flex', gap: 7, alignItems: 'center', fontSize: 12.5 }}><span className={`status-dot ${s}`} />{n}</span></div>)}
          </div>
        </div>
      </section>

      <section id="workflow" style={{ borderTop: '1px solid var(--border)' }}><div className="container" style={{ paddingBlock: 88, display: 'flex', flexDirection: 'column', gap: 36 }}><div style={{ maxWidth: 650, display: 'flex', flexDirection: 'column', gap: 12 }}><div className="eyebrow">Workflow</div><h2 className="section-title">One contract, followed from deployment to an application query.</h2><p className="muted" style={{ margin: 0, lineHeight: 1.6 }}>Every step keeps the network, address, block, transaction, and freshness context needed by the next one.</p></div><ol style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(250px,1fr))', borderTop: '1px solid var(--border)', borderLeft: '1px solid var(--border)' }}>{workflow.map(([n,t,b]) => <li key={n} style={{ minHeight: 180, padding: 22, borderRight: '1px solid var(--border)', borderBottom: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 10 }}><span className="mono dim" style={{ fontSize: 12 }}>{n}</span><strong style={{ fontSize: 16 }}>{t}</strong><span className="muted" style={{ fontSize: 13.5, lineHeight: 1.55 }}>{b}</span></li>)}</ol></div></section>

      <section id="capabilities" style={{ borderTop: '1px solid var(--border)' }}><div className="container" style={{ paddingBlock: 88, display: 'flex', flexDirection: 'column', gap: 36 }}><div className="eyebrow">Capabilities</div><div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(280px,1fr))', gap: 20 }}>{[
        ['Contract Studio','Artifacts, ABI versions, reads, wallet-reviewed writes, receipts, and decoded failures.','In progress'],
        ['Indexer and API','Raw EVM logs, explicit coverage, durable checkpoints, scoped keys, and stable cursors.','Core worker next'],
        ['Monitoring','Timestamped RPC probes, worker health, request outcomes, and unavailable values that stay unavailable.','Connected locally'],
      ].map(([t,b,s]) => <article className="card" key={t} style={{ padding: 22, display: 'flex', flexDirection: 'column', gap: 16 }}><h3 style={{ margin: 0, fontSize: 17 }}>{t}</h3><p className="muted" style={{ margin: 0, lineHeight: 1.6 }}>{b}</p><span className="badge" style={{ alignSelf: 'flex-start' }}><span className="status-dot info" />{s}</span></article>)}</div></div></section>
    </main>
    <footer style={{ borderTop: '1px solid var(--border)' }}><div className="container" style={{ paddingBlock: 24, display: 'flex', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', color: 'var(--dim)', fontSize: 12.5 }}><span>PalletDock · independent developer tooling</span><span className="mono">Portaldot V3 Testnet · EVM chain 420420777</span></div></footer>
  </div>;
}
