'use client';

import { useState } from 'react';
import { Para, PublicPage, Section } from '@/components/public-page';
import { NETWORK } from '@/lib/network';

const TYPES = ['Account', 'Deployment', 'Indexer', 'API', 'Dashboard', 'Other'];

const FIELDS: Array<{ key: string; label: string; placeholder: string; required?: boolean; long?: boolean }> = [
  { key: 'summary', label: 'Summary', placeholder: 'Contract event is missing after a successful transaction', required: true },
  { key: 'projectId', label: 'Project ID', placeholder: '<PROJECT_ID>' },
  { key: 'contract', label: 'Contract address', placeholder: '<CONTRACT_ADDRESS>' },
  { key: 'txHash', label: 'Transaction hash', placeholder: '<TRANSACTION_HASH>' },
  { key: 'requestId', label: 'Request ID', placeholder: '<REQUEST_ID>' },
  { key: 'happened', label: 'What happened?', placeholder: 'Describe the observed result.', required: true, long: true },
  { key: 'expected', label: 'What did you expect?', placeholder: 'Describe the expected result.', required: true, long: true },
  { key: 'steps', label: 'Steps to reproduce', placeholder: 'List the shortest repeatable steps.', required: true, long: true },
];

/** Remove values that look like secrets before export (read keys, long word lists). */
function sanitize(v: string): { text: string; redacted: boolean } {
  let redacted = false;
  let text = v.replace(/pd_live_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, () => {
    redacted = true;
    return '<REDACTED_API_KEY>';
  });
  text = text.replace(/\b(?:[a-z]{3,8}\s+){11,23}[a-z]{3,8}\b/g, () => {
    redacted = true;
    return '<REDACTED_POSSIBLE_SEED_PHRASE>';
  });
  return { text, redacted };
}

export default function SupportPage() {
  const [type, setType] = useState(TYPES[0]);
  const [vals, setVals] = useState<Record<string, string>>({});
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');

  function exportReport() {
    const missing = FIELDS.filter((f) => f.required && !vals[f.key]?.trim()).map((f) => f.label);
    if (missing.length) {
      setErr(`Fill in: ${missing.join(', ')}.`);
      return;
    }
    setErr('');
    let anyRedacted = false;
    const lines = [`PalletDock issue report`, `Issue type: ${type}`, `Network: ${NETWORK.walletName} (EVM chain ${NETWORK.chainId})`, `Prepared: ${new Date().toISOString()}`, ''];
    for (const f of FIELDS) {
      const raw = vals[f.key]?.trim();
      if (!raw) continue;
      const s = sanitize(raw);
      anyRedacted ||= s.redacted;
      lines.push(f.long ? `${f.label}:\n${s.text}\n` : `${f.label}: ${s.text}`);
    }
    const u = URL.createObjectURL(new Blob([lines.join('\n') + '\n'], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = u;
    a.download = `palletdock-report-${Date.now()}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(u), 2000);
    setNote(anyRedacted ? 'Report exported. Something that looked like a secret was replaced with a placeholder — review the file before sharing.' : 'Report exported. Review it before sharing.');
  }

  const input = { width: '100%', minHeight: 38, padding: '0 12px', borderRadius: 7, border: '1px solid #34373d', background: '#0f1012', fontSize: 14, outline: 'none' } as const;
  return (
    <PublicPage eyebrow="Support" title="Support" intro="Find the right place to resolve a network, account, deployment, or PalletDock workflow issue.">
      <Section title="Before reporting an issue">
        <Para text="Check [Troubleshooting](/docs/troubleshooting) for account funding, network mismatch, missing events, and stale indexer data." />
        <Para text="For Portaldot test-token distribution or network announcements, use the team's current official channels. PalletDock does not control the faucet or network validators." />
      </Section>
      <Section title="Prepare an issue report">
        <p style={{ margin: 0, padding: '12px 14px', borderRadius: 9, background: '#1a1712', border: '1px solid #3d3320', color: '#e6d3a8', fontSize: 13.5, lineHeight: 1.55 }}>
          Support submissions are not connected yet. Export the report and share it with the repository maintainer when a verified project contact is published. Nothing on this page is sent anywhere.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: 18, borderRadius: 10, border: '1px solid #25282d', background: '#16181b' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 12.5, color: '#c4c8ce' }}>Issue type</span>
            <select value={type} onChange={(e) => setType(e.target.value)} style={input}>
              {TYPES.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </label>
          <div>
            <span style={{ fontSize: 12.5, color: '#c4c8ce' }}>Network</span>
            <div style={{ marginTop: 6, fontSize: 14 }}>{NETWORK.label}</div>
          </div>
          {FIELDS.map((f) => (
            <label key={f.key} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={{ fontSize: 12.5, color: '#c4c8ce' }}>
                {f.label} {!f.required && <span style={{ color: '#8a8f98' }}>if relevant</span>}
              </span>
              {f.long ? (
                <textarea rows={3} value={vals[f.key] ?? ''} placeholder={f.placeholder} onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })} style={{ ...input, padding: '10px 12px', resize: 'vertical' }} />
              ) : (
                <input value={vals[f.key] ?? ''} placeholder={f.placeholder} onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })} style={input} spellCheck={false} />
              )}
            </label>
          ))}
          {err && <p style={{ margin: 0, color: '#f2867a', fontSize: 12.5 }}>{err}</p>}
          {note && <p style={{ margin: 0, color: '#b5c9bb', fontSize: 12.5 }}>{note}</p>}
          <div>
            <button onClick={exportReport} className="button">
              Export report
            </button>
          </div>
        </div>
      </Section>
      <Section title="Safe reporting">
        <Para text="Do not include seed phrases, private keys, API secrets, signing payloads containing secrets, or personal information unrelated to the issue. A public transaction hash is useful; wallet ownership proof is not required to report a bug. Exported reports automatically replace PalletDock read keys and long word lists with placeholders, but always review the file yourself." />
      </Section>
      <Section title="Security issues">
        <Para text="Report security concerns privately to the repository maintainer. Do not publish an exploit, secret, or personal data in a public issue. No dedicated disclosure address or response-time guarantee is offered." />
      </Section>
      <Section title="Useful links">
        <Para text="[Troubleshooting](/docs/troubleshooting) · [Network setup](/docs/network) · [Accounts and mapping](/docs/accounts) · [Portaldot V3 developer guide](https://github.com/ItsCogumellum/portaldot-v3-testnet-guide)" />
      </Section>
    </PublicPage>
  );
}
