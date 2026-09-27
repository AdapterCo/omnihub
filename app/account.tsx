'use client';
import { useEffect, useState, type FormEvent } from 'react';
import { ArrowUpRight, KeyRound, LoaderCircle, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';

// Telas de segurança da conta: segunda etapa do login (código do app autenticador), "Esqueci minha
// senha", nova senha pelo link do e-mail e "Minha conta" (trocar senha, verificação em duas etapas).
// Toda regra fica no servidor (lib/auth/security.ts); aqui só coleta e mostra.
async function post<T = Record<string, unknown>>(url: string, body: unknown): Promise<T & { error?: string }> {
 const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
 const d = (await r.json().catch(() => ({}))) as T & { error?: string };
 if (!r.ok) throw new Error(d.error || 'Não foi possível concluir. Tente novamente.');
 return d;
}
const errorText = (e: unknown) => (e instanceof Error ? e.message : 'Não foi possível concluir. Tente novamente.');

export function TwoFactorLogin({ challenge, onDone, onCancel }: { challenge: string; onDone: () => void; onCancel: () => void }) {
 const [code, setCode] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
 const submit = async (e: FormEvent) => {
  e.preventDefault(); if (busy) return; setBusy(true); setError('');
  try { await post('/api/auth/login/2fa', { challenge, code: code.trim() }); onDone(); } catch (err) { setError(errorText(err)); setCode(''); } finally { setBusy(false); }
 };
 return <>
  <p>Abra o aplicativo autenticador e informe o código de 6 dígitos da sua conta OmniHub. Sem o celular, use um dos códigos de recuperação.</p>
  {error && <div className="notice error" role="alert">{error}</div>}
  <form onSubmit={submit}>
   <label className="field">Código<input required autoFocus autoComplete="one-time-code" inputMode="text" maxLength={11} value={code} onChange={(e) => setCode(e.target.value)} placeholder="000000" /></label>
   <Button className="mt-5 w-full" disabled={busy || !code.trim()}>{busy ? <LoaderCircle className="animate-spin" /> : <ShieldCheck />} Confirmar</Button>
  </form>
  <p className="muted mt-5 mb-0"><button type="button" className="underline" onClick={onCancel}>Voltar e entrar com outro e-mail</button></p>
 </>;
}

export function ForgotPassword({ initialEmail, onBack }: { initialEmail: string; onBack: () => void }) {
 const [email, setEmail] = useState(initialEmail), [busy, setBusy] = useState(false), [error, setError] = useState(''), [done, setDone] = useState('');
 const submit = async (e: FormEvent) => {
  e.preventDefault(); if (busy) return; setBusy(true); setError('');
  try { const d = await post<{ message?: string }>('/api/auth/password/forgot', { email: email.trim() }); setDone(d.message ?? 'Pedido registrado.'); } catch (err) { setError(errorText(err)); } finally { setBusy(false); }
 };
 return <>
  <p>Informe o e-mail da sua conta. Se ele estiver cadastrado, enviaremos um link para criar uma nova senha (vale por 30 minutos).</p>
  {error && <div className="notice error" role="alert">{error}</div>}
  {done ? <div className="notice">{done}</div> : <form onSubmit={submit}>
   <label className="field">E-mail<input required type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="voce@empresa.com" /></label>
   <Button className="mt-5 w-full" disabled={busy}>{busy ? <LoaderCircle className="animate-spin" /> : <KeyRound />} Enviar link</Button>
  </form>}
  <p className="muted mt-5 mb-0"><button type="button" className="underline" onClick={onBack}>Voltar para a entrada</button></p>
 </>;
}

export function ResetPassword({ token, onDone }: { token: string; onDone: (message: string) => void }) {
 const [password, setPassword] = useState(''), [confirm, setConfirm] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
 const submit = async (e: FormEvent) => {
  e.preventDefault(); if (busy) return;
  if (password !== confirm) { setError('As senhas não conferem.'); return; }
  setBusy(true); setError('');
  try { await post('/api/auth/password/reset', { token, newPassword: password }); onDone('Senha alterada. Entre com a nova senha.'); } catch (err) { setError(errorText(err)); } finally { setBusy(false); }
 };
 return <>
  <p>Crie a nova senha da sua conta (mínimo de 8 caracteres). Por segurança, todos os acessos abertos serão encerrados.</p>
  {error && <div className="notice error" role="alert">{error}</div>}
  <form onSubmit={submit}>
   <label className="field">Nova senha<input required type="password" minLength={8} maxLength={128} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
   <label className="field">Repita a nova senha<input required type="password" minLength={8} maxLength={128} autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} /></label>
   <Button className="mt-5 w-full" disabled={busy}>{busy ? <LoaderCircle className="animate-spin" /> : <ArrowUpRight />} Salvar nova senha</Button>
  </form>
 </>;
}

type TwoFactorState = { enabled: boolean; recoveryCodesLeft: number };
export function MyAccountDialog({ onClose }: { onClose: () => void }) {
 const [status, setStatus] = useState<TwoFactorState | null>(null), [error, setError] = useState(''), [info, setInfo] = useState(''), [busy, setBusy] = useState(false);
 const [current, setCurrent] = useState(''), [next, setNext] = useState(''), [confirm, setConfirm] = useState('');
 const [password2fa, setPassword2fa] = useState(''), [code, setCode] = useState('');
 const [setup, setSetup] = useState<{ secret: string; uri: string; qrSvg: string | null } | null>(null);
 const [recovery, setRecovery] = useState<string[] | null>(null);
 const loadStatus = async () => { try { const r = await fetch('/api/auth/2fa', { cache: 'no-store' }); if (r.ok) setStatus(await r.json()); } catch { /* mostra sem o status */ } };
 useEffect(() => { void loadStatus(); }, []);
 const run = async (fn: () => Promise<void>) => { if (busy) return; setBusy(true); setError(''); setInfo(''); try { await fn(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); } };
 const changePassword = (e: FormEvent) => { e.preventDefault(); if (next !== confirm) { setError('As senhas novas não conferem.'); return; } void run(async () => { await post('/api/auth/password', { currentPassword: current, newPassword: next }); setCurrent(''); setNext(''); setConfirm(''); setInfo('Senha alterada. Os outros acessos abertos com a senha antiga foram encerrados.'); }); };
 const startSetup = (e: FormEvent) => { e.preventDefault(); void run(async () => { setSetup(await post('/api/auth/2fa', { action: 'setup', password: password2fa })); setPassword2fa(''); }); };
 const confirmSetup = (e: FormEvent) => { e.preventDefault(); void run(async () => { const d = await post<{ recoveryCodes: string[] }>('/api/auth/2fa', { action: 'enable', code: code.trim() }); setRecovery(d.recoveryCodes); setSetup(null); setCode(''); await loadStatus(); }); };
 const disable = (e: FormEvent) => { e.preventDefault(); void run(async () => { await post('/api/auth/2fa', { action: 'disable', password: password2fa, code: code.trim() }); setPassword2fa(''); setCode(''); setInfo('Verificação em duas etapas desativada.'); await loadStatus(); }); };
 return <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}><DialogContent className="sm:max-w-xl max-h-[90vh] overflow-y-auto">
  <DialogHeader><DialogTitle>Minha conta</DialogTitle><DialogDescription>Senha e verificação em duas etapas do seu usuário.</DialogDescription></DialogHeader>
  {error && <div className="notice error" role="alert">{error}</div>}
  {info && <div className="notice">{info}</div>}
  <section className="stack">
   <h3 className="section-title"><KeyRound size={16} /> Trocar senha</h3>
   <form className="form-grid" onSubmit={changePassword}>
    <label className="field full">Senha atual<input required type="password" autoComplete="current-password" maxLength={128} value={current} onChange={(e) => setCurrent(e.target.value)} /></label>
    <label className="field">Nova senha<input required type="password" minLength={8} maxLength={128} autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} /></label>
    <label className="field">Repita a nova senha<input required type="password" minLength={8} maxLength={128} autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} /></label>
    <div className="form-actions full" style={{ marginTop: 0 }}><Button disabled={busy}>Salvar nova senha</Button></div>
   </form>
  </section>
  <section className="stack" style={{ marginTop: 16 }}>
   <h3 className="section-title"><ShieldCheck size={16} /> Verificação em duas etapas</h3>
   {recovery ? <div className="notice">
    <strong>Ativada. Guarde estes códigos de recuperação agora</strong> (cada um vale uma vez, para entrar sem o celular). Eles não serão mostrados de novo.
    <pre className="mt-2 text-sm" style={{ whiteSpace: 'pre-wrap' }}>{recovery.join('\n')}</pre>
    <Button type="button" size="sm" variant="outline" onClick={() => { void navigator.clipboard?.writeText(recovery.join('\n')).catch(() => undefined); }}>Copiar códigos</Button>{' '}
    <Button type="button" size="sm" onClick={() => setRecovery(null)}>Já guardei</Button>
   </div> : status?.enabled ? <>
    <p className="muted">Ativa. Ao entrar, além da senha, será pedido o código do aplicativo autenticador. Códigos de recuperação restantes: {status.recoveryCodesLeft}.</p>
    <form className="form-grid" onSubmit={disable}>
     <label className="field">Senha atual<input required type="password" autoComplete="current-password" value={password2fa} onChange={(e) => setPassword2fa(e.target.value)} /></label>
     <label className="field">Código do app ou de recuperação<input required autoComplete="one-time-code" maxLength={11} value={code} onChange={(e) => setCode(e.target.value)} /></label>
     <div className="form-actions full" style={{ marginTop: 0 }}><Button variant="outline" disabled={busy}>Desativar</Button></div>
    </form>
   </> : setup ? <>
    <p className="muted">1. No aplicativo autenticador (Google Authenticator, Microsoft Authenticator, Authy…), adicione uma conta lendo o QR Code — ou digite a chave. 2. Informe o código de 6 dígitos que aparecer.</p>
    {setup.qrSvg && <div style={{ width: 180, height: 180, background: 'white', padding: 8 }} aria-label="QR Code da verificação em duas etapas" dangerouslySetInnerHTML={{ __html: setup.qrSvg }} />}
    <label className="field">Chave (se não der para ler o QR)<input readOnly value={setup.secret} onFocus={(e) => e.currentTarget.select()} /></label>
    <form className="form-grid" onSubmit={confirmSetup}>
     <label className="field">Código do aplicativo<input required autoFocus autoComplete="one-time-code" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} /></label>
     <div className="form-actions" style={{ marginTop: 0, alignSelf: 'end' }}><Button disabled={busy || code.length !== 6}>Ativar</Button><Button type="button" variant="outline" onClick={() => setSetup(null)}>Cancelar</Button></div>
    </form>
   </> : <>
    <p className="muted">Opcional. Protege a conta mesmo se alguém descobrir sua senha: ao entrar, será pedido também o código do aplicativo no seu celular.</p>
    <form className="form-grid" onSubmit={startSetup}>
     <label className="field">Confirme sua senha<input required type="password" autoComplete="current-password" value={password2fa} onChange={(e) => setPassword2fa(e.target.value)} /></label>
     <div className="form-actions" style={{ marginTop: 0, alignSelf: 'end' }}><Button disabled={busy}>Configurar</Button></div>
    </form>
   </>}
  </section>
 </DialogContent></Dialog>;
}
