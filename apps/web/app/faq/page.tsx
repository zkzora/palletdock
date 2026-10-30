'use client';

import { Para, PublicPage, Section } from '@/components/public-page';

const QA: Array<[string, string]> = [
  ['What is PalletDock?', 'PalletDock is a self-hosted developer workspace for Portaldot. It connects contract deployment and interaction, event indexing, read-only application APIs, and project monitoring in one project.'],
  ['What is available now?', 'Projects, wallet-signed deploys and writes, receipt tracking, an EVM log indexer with reorg handling, a scoped read API, and monitoring. See [Limitations](/docs/limitations) for what is not covered yet.'],
  ['Is PalletDock a bridge?', 'No. Its purpose is the developer workflow. A bridge, light client, or cross-chain integration may use indexing and APIs, but it is not part of PalletDock.'],
  ['Which networks are supported?', 'Portaldot V3 (EVM chain ID `420420777`, currently the testnet). Mainnet is not supported; the [Roadmap](/roadmap) lists what it needs.'],
  ['Which wallet should I use?', 'MetaMask for the Solidity path. It is the wallet PalletDock is tested with; Rabby and some other EVM wallets do not support Portaldot V3 and can fail when adding the network or signing. PalletDock shows the selected signing account and network before every approval. Native (SS58) signing is not supported; see the [Roadmap](/roadmap).'],
  ['Which address should receive my test tokens?', 'For a MetaMask deployer funded through a native transfer, use the account PalletDock resolves with `reviveApi.accountId` (Overview → Account mapping). Follow the distributor\'s current address-format instructions; do not guess a mapped account.'],
  ['Where is the faucet?', 'The team announcement supplied for this project describes manual requests in Portaldot\'s Discord with distribution once every 24 hours. There is no confirmed public faucet URL. Recheck the current channel and schedule before requesting.'],
  ['Can I verify contract source on the explorer?', 'A V3 source-verification service has not been confirmed. PalletDock shows verification as unavailable. Importing an ABI is not source verification.'],
  ['Are native Assets ERC-20 tokens?', 'Not automatically. Native Assets are runtime-managed resources identified by asset IDs; ERC-20 is a contract interface identified by an address. PalletDock supports ERC-20 contracts today; managing native Assets is not supported (see the [Roadmap](/roadmap)).'],
  ['Are Uniques and Nfts the same as ERC-721?', 'No. Native NFT modules use collection and item IDs with module-specific permissions. An ERC-721 collection is a contract. PalletDock supports ERC-721 contracts; managing native NFTs is not supported (see the [Roadmap](/roadmap)).'],
  ['Does PalletDock store my private key?', 'No. Every write is signed in your browser wallet; PalletDock never collects a seed phrase or private key and holds no deployer key. This is an implementation property, not a completed third-party audit. Never enter private keys into any form or report.'],
  ['Does PalletDock include an AI assistant?', 'No. The [Roadmap](/roadmap) describes the constraints any assistant would have to meet: reviewable suggestions only, and it must never sign or submit transactions.'],
  ['Is PalletDock free?', 'PalletDock is self-hosted from its repository. No hosted service, pricing, paid tiers, or quotas are offered.'],
  ['Where should I start?', 'Read [Getting started](/docs/getting-started), verify [network details](/docs/network), then complete [account mapping](/docs/accounts) and [funding](/docs/funding).'],
];

export default function FaqPage() {
  return (
    <PublicPage eyebrow="FAQ" title="Frequently Asked Questions" intro="Answers about PalletDock, Portaldot, and the developer workflow.">
      {QA.map(([q, a]) => (
        <Section key={q} title={q}>
          <Para text={a} />
        </Section>
      ))}
      <div style={{ marginTop: 24, paddingTop: 20, borderTop: '1px solid #222429' }}>
        <Para text="Still need help? [Support](/support)" />
      </div>
    </PublicPage>
  );
}
