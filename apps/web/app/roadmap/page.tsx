'use client';

import { Para, PublicPage, Section } from '@/components/public-page';

const MILESTONES: Array<{ title: string; status: string; tone: string; items: string[]; exit: string }> = [
  {
    title: 'Milestone 1: A proven end-to-end workflow',
    status: 'Implemented · ran live 2026-10-21',
    tone: '#6cb2f5',
    items: [
      'Project creation and Portaldot V3 network configuration.',
      'Account mapping and funding diagnostics.',
      'Contract artifact import and a tested Solidity deployment path.',
      'Contract calls, receipt tracking, and decoded events for the tested ABI.',
      'A bounded event indexer with checkpoints and reconnect recovery.',
      'A project-scoped read-only API.',
      'Monitoring for RPC health, transaction outcomes, and indexing progress.',
    ],
    exit: 'A real on-chain demo links a deployment, an interaction, an indexed event, and an API response, each with its network, address, hash, and freshness. Verified on a local fixture chain and on Portaldot V3 Testnet (2026-10-21).',
  },
  {
    title: 'Milestone 2: Portaldot-native resource tools',
    status: 'Planned integration',
    tone: '#8a8f98',
    items: ['Native Assets discovery and role-aware management.', 'Uniques and Nfts collections, items, metadata, and approvals.', 'Separate native and contract-based resource adapters.', 'Deposit-aware transaction previews and native-event indexing.'],
    exit: 'At least one tested native asset workflow and one tested native NFT workflow, with permissions and storage deposits displayed correctly.',
  },
  {
    title: 'Milestone 3: Developer diagnostics',
    status: 'Capability-dependent',
    tone: '#8a8f98',
    items: ['Read and write dry-runs using confirmed node capabilities.', 'Better error decoding and storage-deposit diagnostics.', 'Trace views only where a supported trace API is available.', 'Reproducible request exports and versioned artifacts.', 'Source verification only after a compatible verifier is confirmed.'],
    exit: 'Supported diagnostics are separated from unavailable RPC features, and failures can be reproduced from saved context.',
  },
  {
    title: 'Milestone 4: Assisted development',
    status: 'Research',
    tone: '#8a8f98',
    items: ['A project-aware copilot for documentation and error explanations.', 'Suggestions that cite their source and distinguish assumptions.', 'Read-only context access by default.', 'Explicit review before any generated code or transaction intent is used.'],
    exit: 'The assistant cannot expose secrets, silently change project settings, sign, or broadcast a transaction.',
  },
  {
    title: 'Milestone 5: Portaldot mainnet',
    status: 'Planned · after mainnet launch',
    tone: '#8a8f98',
    items: ['Network selection driven by configuration, with testnet and mainnet projects kept separate.', 'Mainnet identity verification (genesis hash, chain ID, runtime) before any indexing or tracking.', 'An independent security review before PalletDock is used with mainnet value.'],
    exit: 'A mainnet project runs the same workflow with its network identity verified and the security review published.',
  },
];

export default function RoadmapPage() {
  return (
    <PublicPage eyebrow="Roadmap" title="Roadmap" intro="A capability-based roadmap. Milestones describe planned outcomes, not guaranteed dates.">
      {MILESTONES.map((m) => (
        <section key={m.title} style={{ marginTop: 14, padding: 20, borderRadius: 10, border: '1px solid #25282d', background: '#16181b', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>{m.title}</h2>
            <span className="chip">
              {m.status}
            </span>
          </div>
          <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 6, color: '#c4c8ce', lineHeight: 1.6, fontSize: 14.5 }}>
            {m.items.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
          <p style={{ margin: 0, fontSize: 13.5, color: '#9a9fa8', lineHeight: 1.6 }}>
            <strong style={{ color: '#c4c8ce' }}>Exit criterion:</strong> {m.exit}
          </p>
        </section>
      ))}
      <Section title="Not committed">
        <Para text="A PalletDock token, cross-chain custody, a built-in bridge, billing, a public SLA, dedicated WASM compilation, and support for every Portaldot runtime module are not commitments." />
      </Section>
      <Para text="[Open the workspace](/app) · [Read the docs](/docs)" />
    </PublicPage>
  );
}
