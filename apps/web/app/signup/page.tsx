'use client';

import Image from 'next/image';
import Link from 'next/link';
import { Eye, EyeOff } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { FormEvent, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';

interface SignupConfig {
  enabled: boolean;
  inviteRequired: boolean;
}

export default function SignupPage() {
  const router = useRouter();
  const emailRef = useRef<HTMLInputElement>(null);
  const [config, setConfig] = useState<SignupConfig | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api<SignupConfig>('/auth/signup-config')
      .then(setConfig)
      .catch((value) => setError((value as Error).message));
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError('');
    if (!email.trim()) {
      setError('Enter your email address.');
      emailRef.current?.focus();
      return;
    }
    if (password.length < 12) {
      setError('Password must be at least 12 characters.');
      return;
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      await api('/auth/signup', {
        method: 'POST',
        body: JSON.stringify({ email, password, inviteCode: config?.inviteRequired ? inviteCode : undefined }),
      });
      router.replace('/app/projects/new');
    } catch (value) {
      setError((value as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const disabled = config?.enabled === false;
  return (
    <main className="login-page">
      <section className="login-panel">
        <Link href="/">
          <Image src="/palletdock-logo.png" alt="PalletDock" width={2172} height={724} priority style={{ width: 'auto', height: 54, filter: 'invert(1)', margin: '-12px -9px 16px' }} />
        </Link>
        <div className="eyebrow">Workspace access</div>
        <h1 className="page-title" style={{ fontSize: 30 }}>Create your account</h1>
        <p className="muted" style={{ lineHeight: 1.6 }}>Create an isolated PalletDock workspace. Wallet connection stays separate and is only needed when you choose to sign an on-chain action.</p>
        {error && <div className="notice error" role="alert">{error}</div>}
        {config === null && !error ? <p className="muted">Checking registration availability...</p> : null}
        {disabled ? (
          <div className="notice warning" role="status">Account registration is disabled on this deployment. Ask its operator for access.</div>
        ) : config?.enabled ? (
          <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div className="field">
              <label htmlFor="email">Email</label>
              <input ref={emailRef} className="input" id="email" type="email" autoComplete="email" spellCheck={false} maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} required />
            </div>
            <div className="field">
              <label htmlFor="password">Password</label>
              <div style={{ position: 'relative' }}>
                <input className="input" style={{ paddingRight: 48 }} id="password" type={showPassword ? 'text' : 'password'} autoComplete="new-password" minLength={12} maxLength={128} value={password} onChange={(event) => setPassword(event.target.value)} required />
                <button type="button" className="password-toggle" onClick={() => setShowPassword(!showPassword)} aria-label={showPassword ? 'Hide password' : 'Show password'}>{showPassword ? <EyeOff size={17} /> : <Eye size={17} />}</button>
              </div>
              <span className="dim" style={{ fontSize: 12 }}>Use at least 12 characters. PalletDock stores a salted password hash.</span>
            </div>
            <div className="field">
              <label htmlFor="confirm-password">Confirm password</label>
              <input className="input" id="confirm-password" type={showPassword ? 'text' : 'password'} autoComplete="new-password" minLength={12} maxLength={128} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} required />
            </div>
            {config.inviteRequired ? (
              <div className="field">
                <label htmlFor="invite-code">Registration code</label>
                <input className="input" id="invite-code" type="password" autoComplete="off" maxLength={256} value={inviteCode} onChange={(event) => setInviteCode(event.target.value)} required />
              </div>
            ) : null}
            <button className="button" type="submit" disabled={busy} aria-busy={busy}>{busy ? 'Creating account...' : 'Create account'}</button>
          </form>
        ) : null}
        <p className="dim" style={{ fontSize: 12.5, lineHeight: 1.55 }}>Already have an account? <Link href="/login">Sign in</Link>.</p>
      </section>
    </main>
  );
}
