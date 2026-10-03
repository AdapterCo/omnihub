'use client';
import { useEffect, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Check, Copy, ExternalLink, LoaderCircle, Pencil, Plus, RefreshCw, X } from 'lucide-react';
import { money, date } from '@/lib/domain';

// Telas de planos (§43/§44): "Assinatura" para o titular da conta (escolher plano, pagar no Mercado
// Pago, cancelar) e "Plataforma" para os administradores da plataforma (cadastro de planos, limite
// de lojas das contas dos administradores e situação das contas). Toda regra fica no servidor.

type Plan = { id: string; name: string; priceCents: number; maxStores: number; active: boolean };
type Sub = { id: string; planName: string; priceCents: number; maxStores: number; payerEmail: string; status: string; paidUntil: number; initPoint: string | null; lastError: string; createdAt: number };
type Access = { status: string; accessUntil: number; maxStores: number };
type SubscriptionView = { plans: Plan[]; subscriptions: Sub[]; billingReady: boolean; access: Access };

const SUB_LABEL: Record<string, string> = { CREATING: 'Criando', PENDING: 'Aguardando pagamento', AUTHORIZED: 'Ativa', PAUSED: 'Pausada no Mercado Pago', CANCELLED: 'Cancelada', FAILED: 'Não criada' };
const ACCESS_LABEL: Record<string, string> = { none: 'Sem plano', trial: 'Avaliação', active: 'Ativa', cancelled: 'Cancelada (vale até o fim do período pago)', expired: 'Vencida', platform: 'Administrador da plataforma' };

async function call<T>(url: string, body?: unknown): Promise<T> {
 const r = await fetch(url, body === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
 const data = await r.json().catch(() => ({}));
 if (!r.ok) throw new Error((data as { error?: string }).error || 'Operação não concluída.');
 return data as T;
}

export function SubscriptionPage({ ownerEmail, storesUsed, onChanged }: { ownerEmail: string; storesUsed: number; onChanged: () => void }) {
 const [view, setView] = useState<SubscriptionView | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [payer, setPayer] = useState(ownerEmail), [confirmCancel, setConfirmCancel] = useState(false);
 const load = async (refresh = false) => {
  setBusy(true); setError('');
  try { setView(await call<SubscriptionView>(`/api/subscription${refresh ? '?refresh=1' : ''}`)); if (refresh) onChanged(); }
  catch (e) { setError(e instanceof Error ? e.message : 'Falha ao consultar.'); }
  finally { setBusy(false); }
 };
 useEffect(() => {
  // Volta do checkout do Mercado Pago (?assinatura=retorno): confere o pagamento na hora.
  const back = new URLSearchParams(window.location.search).get('assinatura') === 'retorno';
  if (back) window.history.replaceState(null, '', window.location.pathname);
  void load(back);
  // eslint-disable-next-line react-hooks/exhaustive-deps
 }, []);
 const subscribe = async (planId: string) => {
  setBusy(true); setError('');
  try { const r = await call<{ initPoint: string }>('/api/subscription', { action: 'start', planId, payerEmail: payer }); window.location.assign(r.initPoint); }
  catch (e) { setError(e instanceof Error ? e.message : 'Falha ao assinar.'); setBusy(false); }
 };
 const cancel = async () => {
  setBusy(true); setError('');
  try { setView(await call<SubscriptionView>('/api/subscription', { action: 'cancel' })); setConfirmCancel(false); onChanged(); }
  catch (e) { setError(e instanceof Error ? e.message : 'Falha ao cancelar.'); }
  finally { setBusy(false); }
 };
 if (!view) return <section className="panel p-6">{error ? <p role="alert" className="notice error">{error}</p> : <p className="muted"><LoaderCircle className="inline animate-spin" size={16} /> Carregando assinatura…</p>}</section>;
 const access = view.access;
 const platform = access.status === 'platform';
 const valid = access.accessUntil > Date.now() && ['active', 'trial', 'cancelled', 'platform'].includes(access.status);
 const current = view.subscriptions.find((s) => s.status === 'AUTHORIZED' && s.paidUntil > Date.now());
 const pending = view.subscriptions.find((s) => s.status === 'PENDING' && s.initPoint);
 const open = view.subscriptions.some((s) => ['PENDING', 'AUTHORIZED', 'PAUSED', 'CREATING'].includes(s.status));
 return <div className="stack">
  <section className="panel p-6 stack">
   <div className="split"><h2>Situação da conta</h2><Button variant="outline" size="sm" disabled={busy} onClick={() => void load(true)}><RefreshCw /> Atualizar</Button></div>
   <div className="list-row px-0"><span>Situação</span><strong>{ACCESS_LABEL[access.status] ?? access.status}</strong></div>
   {!platform && access.accessUntil > 0 && <div className="list-row px-0"><span>{valid ? 'Acesso até' : 'Acesso terminou em'}</span><strong>{date(access.accessUntil)}</strong></div>}
   <div className="list-row px-0"><span>Lojas</span><strong>{storesUsed} de {access.maxStores}</strong></div>
   {current && <div className="list-row px-0"><span>Plano</span><strong>{current.planName} · {money(current.priceCents)}/mês</strong></div>}
   {platform && <p className="notice">Conta de administrador da plataforma: liberada sem assinatura. O limite de lojas é definido em Plataforma.</p>}
   {!platform && !valid && <p className="notice error">{access.status === 'none' ? 'Sua conta ainda não tem plano. Escolha um plano abaixo para começar a usar o OmniHub.' : 'O período pago terminou e a renovação não foi confirmada. Regularize abaixo para voltar a operar; consultas e exportações continuam disponíveis.'}</p>}
   {pending && !current && <div className="notice">Assinatura do plano <strong>{pending.planName}</strong> aguardando pagamento no Mercado Pago. <a className="link" href={pending.initPoint!}>Continuar pagamento <ExternalLink size={14} className="inline" /></a> Já pagou? Clique em Atualizar.</div>}
   {error && <p role="alert" className="notice error">{error}</p>}
  </section>
  {!platform && <section className="panel p-6 stack">
   <h2>Planos</h2>
   {!view.billingReady ? <p className="notice">A contratação online ainda não foi configurada pelo OmniHub. Fale com o suporte.</p>
    : !view.plans.length ? <p className="notice">Nenhum plano disponível no momento. Fale com o suporte.</p>
    : <>
     <label className="field">E-mail da conta Mercado Pago que vai pagar<input type="email" value={payer} onChange={(e) => setPayer(e.target.value)} placeholder="email@exemplo.com" /></label>
     <p className="muted">O pagamento é feito na página do Mercado Pago. A cobrança é mensal e automática; cada pagamento confirmado libera um mês de acesso. Só o titular da conta assina ou cancela.</p>
     <div className="cards">{view.plans.map((p) => {
      const isCurrent = current?.planName === p.name && current.priceCents === p.priceCents;
      const tooSmall = storesUsed > p.maxStores;
      return <div key={p.id} className="panel p-4 stack">
       <strong>{p.name}</strong>
       <span className="text-2xl font-semibold">{money(p.priceCents)}<small className="muted">/mês</small></span>
       <span>Até {p.maxStores} {p.maxStores === 1 ? 'loja' : 'lojas'}</span>
       {isCurrent ? <span className="badge">Plano atual</span>
        : <Button disabled={busy || tooSmall || !payer} onClick={() => void subscribe(p.id)}>{busy ? <LoaderCircle className="animate-spin" /> : <ExternalLink />} {current ? 'Trocar para este plano' : 'Assinar'}</Button>}
       {tooSmall && !isCurrent && <small className="muted">A conta tem {storesUsed} lojas.</small>}
      </div>;
     })}</div>
     {current && <p className="muted">Ao trocar de plano, a assinatura atual é cancelada assim que o pagamento do novo plano for confirmado.</p>}
    </>}
  </section>}
  {!platform && open && <section className="panel p-6 stack">
   <h2>Cancelar assinatura</h2>
   <p className="muted">As cobranças param no Mercado Pago. O acesso continua até o fim do período já pago e depois as novas operações ficam bloqueadas.</p>
   {confirmCancel ? <div className="inline" style={{ gap: 8 }}><Button variant="destructive" disabled={busy} onClick={() => void cancel()}><X /> Confirmar cancelamento</Button><Button variant="outline" onClick={() => setConfirmCancel(false)}>Voltar</Button></div>
    : <Button variant="outline" disabled={busy} onClick={() => setConfirmCancel(true)}>Cancelar assinatura</Button>}
  </section>}
  {view.subscriptions.length > 0 && <section className="panel p-6 stack">
   <h2>Histórico de assinaturas</h2>
   {view.subscriptions.map((s) => <div key={s.id} className="list-row px-0"><span>{s.planName} · {money(s.priceCents)}/mês · {date(s.createdAt)}{s.lastError && <><br /><small className="muted">{s.lastError}</small></>}</span><strong>{SUB_LABEL[s.status] ?? s.status}{s.paidUntil > 0 ? ` · pago até ${date(s.paidUntil)}` : ''}</strong></div>)}
  </section>}
 </div>;
}

type Overview = { plans: Plan[]; adminMaxStores: number | null; billingProblems: string[]; webhookUrl: string | null; accounts: { id: string; name: string; ownerEmail: string; status: string; accessUntil: number; maxStores: number; stores: number; planName: string; subscriptionStatus: string; platform: boolean }[] };
const toCents = (v: string) => { if (!/^\d+(?:[,.]\d{1,2})?$/.test(v.trim())) return NaN; const [a, b = ''] = v.trim().replace(',', '.').split('.'); return Number(a) * 100 + Number(b.padEnd(2, '0')); };

export function PlatformPage() {
 const [data, setData] = useState<Overview | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
 const [form, setForm] = useState<{ id?: string; name: string; price: string; maxStores: string; active: boolean } | null>(null), [adminStores, setAdminStores] = useState('');
 const run = async (body?: unknown, ok?: string) => {
  setBusy(true); setError(''); setNotice('');
  try { const d = await call<Overview>('/api/platform', body); setData(d); setAdminStores(d.adminMaxStores === null ? '' : String(d.adminMaxStores)); if (ok) setNotice(ok); return true; }
  catch (e) { setError(e instanceof Error ? e.message : 'Falha.'); return false; }
  finally { setBusy(false); }
 };
 useEffect(() => { void run(); }, []);
 const savePlan = async (e: FormEvent) => {
  e.preventDefault();
  if (!form) return;
  const priceCents = toCents(form.price);
  if (!Number.isFinite(priceCents)) { setError('Preço inválido. Use, por exemplo, 99,90.'); return; }
  if (await run({ action: 'savePlan', id: form.id, name: form.name, priceCents, maxStores: Number(form.maxStores), active: form.active }, 'Plano salvo.')) setForm(null);
 };
 if (!data) return <section className="panel p-6">{error ? <p role="alert" className="notice error">{error}</p> : <p className="muted"><LoaderCircle className="inline animate-spin" size={16} /> Carregando…</p>}</section>;
 return <div className="stack">
  {error && <p role="alert" className="notice error">{error}</p>}
  {notice && <p className="notice">{notice}</p>}
  <section className="panel p-6 stack">
   <h2>Cobrança das assinaturas (Mercado Pago)</h2>
   {data.billingProblems.length ? <p className="notice error">Contratação online desligada. Configure no servidor: {data.billingProblems.join('; ')}.</p>
    : <>
     <p className="muted">No painel do Mercado Pago (Suas integrações &gt; aplicação &gt; Webhooks), cadastre esta URL com os eventos <strong>Planos e assinaturas</strong> (assinatura e pagamento recorrente) e use o mesmo segredo de PLATFORM_MP_WEBHOOK_SECRET.</p>
     <div className="inline" style={{ gap: 8 }}><code className="truncate">{data.webhookUrl}</code><Button size="sm" variant="outline" onClick={() => { void navigator.clipboard.writeText(data.webhookUrl!); setNotice('URL copiada.'); }}><Copy /> Copiar</Button></div>
    </>}
  </section>
  <section className="panel p-6 stack">
   <div className="split"><h2>Planos</h2><Button size="sm" onClick={() => setForm({ name: '', price: '', maxStores: '', active: true })}><Plus /> Novo plano</Button></div>
   <p className="muted">Cobrança mensal. Alterar preço ou limite vale para novas assinaturas; quem já assinou mantém o que contratou.</p>
   {form && <form className="form-grid" onSubmit={(e) => void savePlan(e)}>
    <label className="field">Nome<input required maxLength={60} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
    <label className="field">Preço mensal (R$)<input required inputMode="decimal" placeholder="0,00" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} /></label>
    <label className="field">Limite de lojas<input required type="number" min={1} value={form.maxStores} onChange={(e) => setForm({ ...form, maxStores: e.target.value })} /></label>
    <label className="field inline" style={{ gap: 6 }}><input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} style={{ width: 'auto', height: 'auto' }} /> Disponível para contratar</label>
    <div className="form-actions full"><Button type="button" variant="outline" onClick={() => setForm(null)}>Cancelar</Button><Button type="submit" disabled={busy}><Check /> Salvar plano</Button></div>
   </form>}
   {!data.plans.length ? <p className="notice">Nenhum plano cadastrado. Sem plano disponível, contas novas não conseguem assinar.</p>
    : data.plans.map((p) => <div key={p.id} className="list-row px-0"><span>{p.name} · {money(p.priceCents)}/mês · até {p.maxStores} {p.maxStores === 1 ? 'loja' : 'lojas'}{p.active ? '' : ' · indisponível'}</span><Button size="sm" variant="outline" onClick={() => setForm({ id: p.id, name: p.name, price: (p.priceCents / 100).toFixed(2).replace('.', ','), maxStores: String(p.maxStores), active: p.active })}><Pencil /> Editar</Button></div>)}
  </section>
  <section className="panel p-6 stack">
   <h2>Contas dos administradores da plataforma</h2>
   <p className="muted">Contas cujo titular está em PLATFORM_ADMIN_EMAILS usam o OmniHub sem assinatura, com este limite de lojas{data.adminMaxStores === null ? ' (ainda não definido: 0 lojas)' : ''}.</p>
   <form className="inline" style={{ gap: 8 }} onSubmit={(e) => { e.preventDefault(); void run({ action: 'adminMaxStores', value: Number(adminStores) }, 'Limite salvo.'); }}>
    <input type="number" min={0} required value={adminStores} onChange={(e) => setAdminStores(e.target.value)} style={{ maxWidth: 120 }} /><Button type="submit" disabled={busy}><Check /> Salvar limite</Button>
   </form>
  </section>
  <section className="panel p-6 stack">
   <h2>Contas ({data.accounts.length})</h2>
   {data.accounts.map((a) => <div key={a.id} className="list-row px-0"><span><strong>{a.name}</strong> · {a.ownerEmail || 'sem titular'}<br /><small className="muted">{a.platform ? 'Administrador da plataforma' : `${ACCESS_LABEL[a.status] ?? a.status}${a.planName ? ` · ${a.planName} (${SUB_LABEL[a.subscriptionStatus] ?? a.subscriptionStatus})` : ''}`}</small></span><small>{a.stores}/{a.platform ? data.adminMaxStores ?? 0 : a.maxStores} lojas{!a.platform && a.accessUntil > 0 ? ` · até ${date(a.accessUntil)}` : ''}</small></div>)}
  </section>
 </div>;
}
