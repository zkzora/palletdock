'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useWorkspace } from '@/components/workspace-shell';
import { AbiInputs } from '@/components/abi-form';
import { SignDialog, type FlowResult, type Prepared } from '@/components/sign-flow';
import { Notice } from '@/components/ui';
import { ErrorState, LoadingCards } from '@/components/page-state';
import { useResource } from '@/lib/use-resource';
import { useWallet } from '@/lib/wallet';
import { TxProgress } from '@/components/tx-progress';
import { NETWORK } from '@/lib/network';

interface Sample {
  id: string;
  title: string;
  description: string;
  contractName: string;
  compiler: { version: string; settings: { evmVersion: string; optimizer: { enabled: boolean; runs: number } } };
  creationBytecodeSha256: string;
  creationBytes: number;
  constructorInputs: Array<{ name: string; type: string }>;
  payable: boolean;
}
interface Uploaded {
  id: string;
  name: string;
  contractName: string | null;
  bytecodeKind: string;
  checksum: string;
  provenance: string;
  constructorInputs: Array<{ name: string; type: string }>;
  payable: boolean;
}

type Choice = { kind: 'sample'; sample: Sample } | { kind: 'artifact'; artifact: Uploaded };

export default function DeployPage() {
  const { project, projectId, readOnly, request, openSigner } = useWorkspace();
  const wallet = useWallet();
  const { data, error, loading, reload } = useResource<{ data: { samples: Sample[]; artifacts: Uploaded[] } }>(projectId ? `/workspace/projects/${projectId}/artifacts` : null);
  const [step, setStep] = useState(1);
  const [choice, setChoice] = useState<Choice | null>(null);
  const [args, setArgs] = useState<string[]>([]);
  const [value, setValue] = useState('0');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [result, setResult] = useState<FlowResult | null>(null);
  const [upload, setUpload] = useState({ name: '', text: '' });
  const [uploadErr, setUploadErr] = useState('');

  if (!project) return <Notice tone="warning">Create a project first.</Notice>;
  if (readOnly) return <Notice tone="warning" title="Archived project">Restore the project in Settings to deploy.</Notice>;

  const inputs = choice ? (choice.kind === 'sample' ? choice.sample.constructorInputs : choice.artifact.constructorInputs) : [];
  const payable = choice ? (choice.kind === 'sample' ? choice.sample.payable : choice.artifact.payable) : false;

  async function uploadArtifact(e: React.FormEvent) {
    e.preventDefault();
    setUploadErr('');
    if (upload.text.length > 2 * 1024 * 1024) return setUploadErr('Artifact files are limited to 2 MB.');
    try {
      JSON.parse(upload.text);
    } catch {
      return setUploadErr('Artifact is not valid JSON.');
    }
    try {
      const r = await request<{ data: { id: string; warnings: string[] } }>(`/workspace/projects/${projectId}/artifacts`, { method: 'POST', body: JSON.stringify({ name: upload.name, artifact: upload.text }) });
      setUpload({ name: '', text: '' });
      await reload();
      const fresh = await request<{ data: { artifacts: Uploaded[] } }>(`/workspace/projects/${projectId}/artifacts`);
      const a = fresh.data.artifacts.find((x) => x.id === r.data.id);
      if (a) setChoice({ kind: 'artifact', artifact: a });
    } catch (err) {
      setUploadErr((err as Error).message);
    }
  }

  async function review() {
    setFailure('');
    if (!choice) return;
    if (!wallet.account) {
      openSigner();
      setFailure('Connect a wallet to prepare the deployment; the review uses your signer address for estimates.');
      return;
    }
    setBusy(true);
    try {
      let artifactId: string;
      if (choice.kind === 'sample') {
        const s = await request<{ data: { id: string } }>(`/workspace/projects/${projectId}/artifacts/samples/${choice.sample.id}`, { method: 'POST' });
        artifactId = s.data.id;
      } else artifactId = choice.artifact.id;
      const r = await request<{ data: Prepared }>(`/workspace/projects/${projectId}/artifacts/${artifactId}/prepare-deploy`, {
        method: 'POST',
        body: JSON.stringify({ args, value: value.trim() || '0', from: wallet.account }),
      });
      setPrepared(r.data);
    } catch (e) {
      setFailure((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const steps = ['Artifact', 'Arguments', 'Review', 'Wallet', 'Result'];
  const current = result ? 5 : prepared ? 4 : step;

  return (
    <div className="page-stack">
      <div>
        <div className="eyebrow">Contract Studio · EVM path</div>
        <h1 className="page-title">Deploy contract</h1>
      </div>
      <ol className="steps" aria-label="Deployment steps">
        {steps.map((l, i) => (
          <li key={l} aria-current={current === i + 1 ? 'step' : undefined} className={current > i + 1 ? 'done' : ''}>
            <span>{i + 1}</span>
            {l}
          </li>
        ))}
      </ol>

      {result ? (
        <DeployResult result={result} onAgain={() => { setResult(null); setPrepared(null); setStep(1); setChoice(null); setArgs([]); }} />
      ) : step === 1 ? (
        <section style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <h2 style={{ margin: 0, fontSize: 14 }}>Choose a compiled artifact</h2>
          {loading ? (
            <LoadingCards />
          ) : error ? (
            <ErrorState message={error} retry={() => void reload()} />
          ) : (
            <>
              <div className="grid-cards">
                {data?.data.samples.map((s) => (
                  <button key={s.id} className="choice" aria-pressed={choice?.kind === 'sample' && choice.sample.id === s.id} onClick={() => { setChoice({ kind: 'sample', sample: s }); setArgs([]); }}>
                    <strong style={{ fontSize: 14.5 }}>{s.title}</strong>
                    <span className="dim" style={{ fontSize: 12.5 }}>{s.description}</span>
                    <span className="mono dim" style={{ fontSize: 11.5 }}>
                      solc {s.compiler.version.split('+')[0]} · evm {s.compiler.settings.evmVersion} · optimizer {s.compiler.settings.optimizer.enabled ? s.compiler.settings.optimizer.runs : 'off'}
                    </span>
                    <span className="mono dim" style={{ fontSize: 11.5 }}>
                      {s.creationBytes} B creation code · sha256 {s.creationBytecodeSha256.slice(0, 12)}… · bundled sample
                    </span>
                  </button>
                ))}
                {data?.data.artifacts.filter((a) => a.provenance === 'uploaded').map((a) => (
                  <button key={a.id} className="choice" aria-pressed={choice?.kind === 'artifact' && choice.artifact.id === a.id} onClick={() => { setChoice({ kind: 'artifact', artifact: a }); setArgs([]); }}>
                    <strong style={{ fontSize: 14.5 }}>{a.name}</strong>
                    <span className="mono dim" style={{ fontSize: 11.5 }}>
                      {a.contractName ?? 'contract'} · {a.bytecodeKind} bytecode · uploaded · {a.checksum.slice(0, 12)}…
                    </span>
                    <span className="mono dim" style={{ fontSize: 11.5 }}>
                      constructor({a.constructorInputs.map((i) => i.type).join(', ')})
                    </span>
                  </button>
                ))}
              </div>
              <details className="card panel">
                <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Upload a compiled artifact (JSON)</summary>
                <form onSubmit={uploadArtifact} style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 12 }}>
                  <p className="dim" style={{ margin: 0, fontSize: 12.5, lineHeight: 1.5 }}>
                    Hardhat, Foundry, or solc output with <span className="mono">abi</span> and creation <span className="mono">bytecode</span>. Linked-library placeholders and runtime-only bytecode are rejected. Nothing is compiled or executed on the server.
                  </p>
                  <div className="field">
                    <label htmlFor="up-name">Name</label>
                    <input id="up-name" className="input" value={upload.name} onChange={(e) => setUpload({ ...upload, name: e.target.value })} placeholder="MyContract" />
                  </div>
                  <div className="field">
                    <label htmlFor="up-file">Artifact file</label>
                    <input
                      id="up-file"
                      type="file"
                      accept="application/json,.json"
                      onChange={async (e) => {
                        const f = e.target.files?.[0];
                        if (!f) return;
                        if (f.size > 2 * 1024 * 1024) return setUploadErr('Artifact files are limited to 2 MB.');
                        setUpload({ name: upload.name || f.name.replace(/\.json$/, ''), text: await f.text() });
                      }}
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="up-text">or paste JSON</label>
                    <textarea id="up-text" className="input mono" rows={5} value={upload.text} onChange={(e) => setUpload({ ...upload, text: e.target.value })} style={{ fontSize: 12 }} />
                  </div>
                  {uploadErr && <p className="field-error">{uploadErr}</p>}
                  <div>
                    <button className="button secondary" type="submit" disabled={!upload.text}>
                      Validate and add artifact
                    </button>
                  </div>
                </form>
              </details>
              <p className="dim" style={{ margin: 0, fontSize: 12.5 }}>
                Compatibility of EVM bytecode with Portaldot V3 Revive is confirmed only by a successful deployment. <Link href="/docs/deploy">Deploy guide</Link>
              </p>
              <div>
                <button className="button" disabled={!choice} onClick={() => setStep(2)}>
                  Continue
                </button>
              </div>
            </>
          )}
        </section>
      ) : (
        <section className="card form-card" style={{ maxWidth: 680 }}>
          <h2 style={{ margin: 0, fontSize: 14 }}>Constructor arguments · {choice?.kind === 'sample' ? choice.sample.title : choice?.artifact.name}</h2>
          <AbiInputs params={inputs} values={args} onChange={setArgs} idPrefix="ctor" />
          {payable && (
            <div className="field">
              <label htmlFor="dep-value">
                Value <span className="dim">raw EVM base units (denomination unverified)</span>
              </label>
              <input id="dep-value" className="input mono" value={value} onChange={(e) => setValue(e.target.value)} inputMode="numeric" />
            </div>
          )}
          {!wallet.account && (
            <Notice tone="warning" title="No signer connected" action={<button className="button secondary" onClick={openSigner}>Connect wallet</button>}>
              Deployment is signed in your browser wallet.
            </Notice>
          )}
          {wallet.account && !wallet.onPortaldot && <Notice tone="warning" title="Wallet is on a different network">You will be asked to switch to {NETWORK.label} before signing.</Notice>}
          {failure && <Notice tone="danger">{failure}</Notice>}
          <div className="form-actions" style={{ marginTop: 0 }}>
            <button className="button secondary" onClick={() => setStep(1)}>
              Back
            </button>
            <button className="button" onClick={() => void review()} disabled={busy} aria-busy={busy}>
              {busy ? 'Preparing review…' : 'Continue to review'}
            </button>
          </div>
        </section>
      )}

      {prepared && !result && projectId && (
        <SignDialog
          title="Review deployment"
          prepared={prepared}
          request={request}
          projectId={projectId}
          onClose={() => setPrepared(null)}
          onDone={(r) => setResult(r)}
          extraRows={[['Artifact', `${prepared.review.artifact?.name} · ${prepared.review.artifact?.bytecodeKind} · sha256 ${String(prepared.review.artifact?.checksum).slice(0, 16)}…`]]}
        />
      )}
    </div>
  );
}

function DeployResult({ result, onAgain }: { result: FlowResult; onAgain(): void }) {
  const { href } = useWorkspace();
  return (
    <section className="card panel" style={{ maxWidth: 760, display: 'flex', flexDirection: 'column', gap: 12 }}>
      {result.kind === 'submitted' ? (
        <TxProgress transactionId={result.transactionId} />
      ) : result.kind === 'unknown' ? (
        <Notice tone="warning" title="Submission could not be confirmed">
          {result.error} Check the account's activity before retrying; do not resubmit until the original submission is understood.
        </Notice>
      ) : result.kind === 'rejected' ? (
        <Notice tone="info" title="Rejected in the wallet">
          Nothing was submitted.
        </Notice>
      ) : (
        <Notice tone="danger" title={result.kind === 'wrong_network' ? 'Wrong network' : 'Failed before broadcast'}>
          {result.error}
        </Notice>
      )}
      <div className="form-actions" style={{ marginTop: 0 }}>
        <Link className="button secondary" href={href(`/app/transactions/${result.transactionId}`)}>
          View transaction details
        </Link>
        <button className="button ghost" onClick={onAgain}>
          Start a new deployment
        </button>
      </div>
    </section>
  );
}
