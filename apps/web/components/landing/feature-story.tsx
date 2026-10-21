'use client';

import Link from 'next/link';
import { Reveal } from '@/components/motion';
import { NETWORK } from '@/lib/network';
import { Lifecycle, lifecycleStates } from './lifecycle';

/**
 * Editorial product sections: an asymmetric heading, short copy, and a large
 * application panel with a smaller panel overlapping it. Sides alternate.
 * Panels show illustrative data; hashes and addresses are masked.
 */

const MASK = '0x••••…••••';

function FeatureStory({
  index,
  title,
  body,
  link,
  reverse,
  main,
  aside,
}: {
  index: string;
  title: React.ReactNode;
  body: string;
  link: [string, string];
  reverse?: boolean;
  main: React.ReactNode;
  aside: React.ReactNode;
}) {
  return (
    <section className={`ld-story ${reverse ? 'is-reverse' : ''}`}>
      <div className="container">
        <div className="ld-story-head">
          <h2 className="ld-display">
            <span className="mono ld-story-n">{index}</span>
            {title}
          </h2>
          <div className="ld-story-copy">
            <p>{body}</p>
            <Link href={link[1]} className="arrow-link ld-more">
              {link[0]} <span className="arrow" aria-hidden="true">→</span>
            </Link>
          </div>
        </div>
        <Reveal className="ld-story-stage">
          <div className="ld-story-main reveal">{main}</div>
          <div className="ld-story-aside reveal" style={{ '--i': 2 } as React.CSSProperties}>
            {aside}
          </div>
        </Reveal>
      </div>
    </section>
  );
}

function Window({ path, children, tag }: { path: string; children: React.ReactNode; tag?: string }) {
  return (
    <div className="ld-window">
      <div className="ld-window-bar">
        <span className="mono dim">{path}</span>
        {tag && <span className="ld-chip mono">{tag}</span>}
      </div>
      {children}
    </div>
  );
}

function Rows({ rows }: { rows: Array<[string, React.ReactNode]> }) {
  return (
    <dl className="ld-kv">
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt className="mono">{k}</dt>
          <dd className="mono">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Minimal JSON highlighter for the illustrative response. */
function JsonLines({ text }: { text: string }) {
  return (
    <ol className="ld-lines mono">
      {text.split('\n').map((line, n) => (
        <li key={n}>
          {line.split(/("(?:[^"\\]|\\.)*"(?:\s*:)?|\bnull\b|-?\b\d+\b)/g).map((p, i) =>
            i % 2 === 0 ? p : (
              <span key={i} className={p.endsWith(':') ? 'c-p' : p === 'null' || /^-?\d/.test(p) ? 'c-n' : p === '"unknown"' ? 'c-w' : 'c-s'}>
                {p}
              </span>
            ),
          )}
        </li>
      ))}
    </ol>
  );
}

const RESPONSE = `{
  "data": [
    {
      "networkId": "portaldot-v3-testnet",
      "contractAddress": "${MASK}",
      "blockNumber": "••••••",
      "transactionHash": "${MASK}",
      "logIndex": 0,
      "decodeStatus": "decoded",
      "event": {
        "name": "NumberChanged",
        "signature": "NumberChanged(address,uint256,uint256)",
        "args": { "previousValue": "0", "newValue": "42" }
      },
      "finality": "unknown"
    }
  ],
  "nextCursor": null
}`;

export function FeatureStories() {
  return (
    <>
      <FeatureStory
        index="01"
        title={
          <>
            Deploy with
            <br />
            wallet control
          </>
        }
        body="PalletDock validates the artifact, encodes the call, and estimates the fee. Signing and broadcasting stay in your browser wallet, and the network is checked before every approval."
        link={['How signing works', '/docs/security']}
        main={
          <Window path={`storage-demo / Contracts / PalletDockStorage`} tag="ABI v1">
            <div className="ld-studio">
              <div className="ld-tabs mono" aria-hidden="true">
                <span>Read</span>
                <span className="is-active">Write</span>
                <span>Events</span>
                <span>ABI</span>
              </div>
              <div className="ld-studio-body">
                <ul className="ld-fn-list mono">
                  <li className="is-active">store(uint256)</li>
                  <li>retrieve()</li>
                </ul>
                <div className="ld-form">
                  <span className="mono dim">store(uint256 newValue)</span>
                  <span className="ld-input mono">42</span>
                  <Rows
                    rows={[
                      ['Network', `${NETWORK.label} · ${NETWORK.chainId}`],
                      ['Fee', 'Estimated by the RPC before signing'],
                      ['Signer', 'Your connected wallet'],
                    ]}
                  />
                  <span className="ld-fake-button">Review in wallet</span>
                </div>
              </div>
            </div>
          </Window>
        }
        aside={
          <div className="ld-mini">
            <span className="eyebrow">Browser wallet</span>
            <strong>Signature request</strong>
            <Rows
              rows={[
                ['Chain', String(NETWORK.chainId)],
                ['To', 'PalletDockStorage'],
                ['Call', 'store(42)'],
              ]}
            />
            <div className="ld-mini-actions">
              <span className="ld-fake-button ghost">Reject</span>
              <span className="ld-fake-button">Confirm</span>
            </div>
            <p className="ld-note">Signed in your wallet. PalletDock never receives the key.</p>
          </div>
        }
      />

      <FeatureStory
        index="02"
        reverse
        title={
          <>
            Follow
            <br />
            every state
          </>
        }
        body="Submission, inclusion, execution, finality, and indexing are separate facts with their own evidence. A missing receipt is not a failure, and finality is shown as unknown until a verified adapter can prove it."
        link={['Transaction lifecycle', '/docs/transactions']}
        main={
          <Window path="storage-demo / Transactions" tag={MASK}>
            <div className="ld-tx">
              <div className="ld-tx-head">
                <span className="mono dim">Call</span>
                <strong className="mono">PalletDockStorage.store(42)</strong>
              </div>
              <Lifecycle states={lifecycleStates(3)} />
              <ul className="ld-facts" aria-label="Recorded facts and their sources">
                {[
                  ['Transaction hash returned', 'wallet response'],
                  ['Receipt status 0x1', 'eth_getTransactionReceipt'],
                  ['Finality not confirmed', 'no verified adapter'],
                  ['Event not indexed yet', 'indexer checkpoint'],
                ].map(([fact, source]) => (
                  <li key={fact}>
                    <span>{fact}</span>
                    <span>{source}</span>
                  </li>
                ))}
              </ul>
            </div>
          </Window>
        }
        aside={
          <div className="ld-mini">
            <span className="eyebrow">Receipt</span>
            <Rows
              rows={[
                ['status', '0x1 · executed'],
                ['block', '#••••••'],
                ['logs', '1 · NumberChanged'],
                ['finality', <span key="f" className="warning-text">Not confirmed</span>],
              ]}
            />
          </div>
        }
      />

      <FeatureStory
        index="03"
        title={
          <>
            Query indexed
            <br />
            evidence
          </>
        }
        body="Indexed events are served over a project-scoped read API. Keys are scoped, expiring, and revocable; responses carry the network, block, decode status, and explicit finality."
        link={['Read API reference', '/docs/api']}
        main={
          <Window path="GET /v1/projects/{projectId}/events" tag="200 OK">
            <pre className="ld-request mono">
              <span className="c-k">curl</span> {'"$PALLETDOCK_API/v1/projects/$PROJECT_ID/events?event=NumberChanged"'} \{'\n'}
              {'  '}-H <span className="c-s">{'"Authorization: Bearer $PALLETDOCK_READ_KEY"'}</span>
            </pre>
            <JsonLines text={RESPONSE} />
          </Window>
        }
        aside={
          <div className="ld-mini">
            <span className="eyebrow">Read key</span>
            <strong className="mono">frontend-read</strong>
            <div className="ld-scopes">
              <span className="ld-chip mono">events:read</span>
              <span className="ld-chip mono">transactions:read</span>
            </div>
            <Rows
              rows={[
                ['key', 'pd_live_••••••.••••••••'],
                ['expires', 'in 30 days'],
              ]}
            />
            <p className="ld-note">Shown once at creation. Only a hash is stored.</p>
          </div>
        }
      />
    </>
  );
}
