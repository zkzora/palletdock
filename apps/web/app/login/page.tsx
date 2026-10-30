'use client';

import Image from 'next/image';
import Link from 'next/link';
import { Eye, EyeOff } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { FormEvent, Suspense, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { PlaygroundOr } from '@/components/playground-cta';
import type { SessionInfo } from '@/lib/types';

function LoginForm() {
  const router = useRouter(); const search = useSearchParams();
  const emailRef = useRef<HTMLInputElement>(null);
  const [email,setEmail] = useState(''); const [password,setPassword] = useState(''); const [show,setShow] = useState(false); const [busy,setBusy] = useState(false); const [error,setError] = useState('');
  const [guest,setGuest] = useState(false);
  useEffect(() => { api<{ session: SessionInfo }>('/auth/me').then((me) => setGuest(me.session.kind === 'guest')).catch(() => setGuest(false)); }, []);
  async function submit(event: FormEvent) { event.preventDefault(); setError(''); if (!email.trim()) { setError('Enter your owner email.'); emailRef.current?.focus(); return; } setBusy(true); try { await api('/auth/login',{method:'POST',body:JSON.stringify({email,password})}); const next=search.get('next'); router.replace(next?.startsWith('/app') ? next : '/app'); } catch (value) { setError((value as Error).message); } finally { setBusy(false); } }
  return <main className="login-page"><section className="login-panel"><Link href="/"><Image src="/palletdock-logo.png" alt="PalletDock" width={2172} height={724} priority style={{ width:'auto',height:54,filter:'invert(1)',margin:'-12px -9px 16px' }} /></Link><div className="eyebrow">Workspace access</div><h1 className="page-title" style={{fontSize:30}}>Sign in to PalletDock</h1><p className="muted" style={{lineHeight:1.6}}>Sign in to your isolated workspace. Wallet connection is separate and never required for read-only pages.</p>{guest && <div className="notice warning" role="status">This browser has an unsaved temporary playground workspace. Signing in replaces that session and it cannot be reopened. <Link href="/signup?save=1">Save it first</Link> or <Link href="/app">return to it</Link>.</div>}{error && <div className="notice error" role="alert">{error}</div>}<form onSubmit={submit} style={{display:'flex',flexDirection:'column',gap:16}}>
    <div className="field"><label htmlFor="email">Email</label><input ref={emailRef} className="input" id="email" type="email" autoComplete="email" spellCheck={false} value={email} onChange={e=>setEmail(e.target.value)} required /></div>
    <div className="field"><label htmlFor="password">Password</label><div style={{position:'relative'}}><input className="input" style={{paddingRight:48}} id="password" type={show?'text':'password'} autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)} required /><button type="button" className="password-toggle" onClick={()=>setShow(!show)} aria-label={show?'Hide password':'Show password'}>{show?<EyeOff size={17}/>:<Eye size={17}/>}</button></div></div>
    <button className="button" type="submit" disabled={busy} aria-busy={busy}>{busy?'Signing in…':'Sign in'}</button>
  </form><p className="dim" style={{fontSize:12.5,lineHeight:1.55}}>Need an account? <Link href="/signup">Create one</Link>.</p><PlaygroundOr playground={<div className="playground-cta"><span className="dim">No account yet? Explore the full workspace first, without an email or password.</span><Link className="button secondary" href="/playground">Try Playground</Link></div>} /></section></main>;
}
export default function LoginPage(){return <Suspense><LoginForm/></Suspense>}
