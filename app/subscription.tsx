'use client';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Check, Copy, CreditCard, LoaderCircle, Pencil, Plus, QrCode, RefreshCw, X } from 'lucide-react';
import { money, date } from '@/lib/domain';

// Planos (modelo do Adapter Connect): o cliente escolhe o plano e paga na própria tela, por Pix
// (QR Code) ou cartão de crédito/débito (formulário seguro do Mercado Pago). Toda regra fica no
// servidor; esta tela só mostra e envia. "Plataforma" é o cadastro dos planos pelos administradores.

type Plan = { id: string; name: string; priceCents: number; maxStores: number; description: string; features: string[]; active: boolean };
type Invoice = { id: string; planName: string; amountCents: number; maxStores: number; status: string; paymentMethod: string; paymentStatusDetail: string; dueDate: number; paidAt: number | null; periodEnd: number | null; createdAt: number };
type Access = { status: string; accessUntil: number; maxStores: number };
type Checkout = { pixEnabled: boolean; cardEnabled: boolean; publicKey: string | null };
type PageView = { plans: Plan[]; invoices: Invoice[]; billingReady: boolean; checkout: Checkout; access: Access };

const INVOICE_LABEL: Record<string, string> = { pending: 'Pendente', paid: 'Pago', failed: 'Não aprovado', cancelled: 'Cancelada' };
const ACCESS_LABEL: Record<string, string> = { none: 'Sem plano', trial: 'Avaliação', active: 'Ativa', cancelled: 'Renovação cancelada (vale até o fim do período pago)', expired: 'Vencida', platform: 'Administrador da plataforma' };

async function call<T>(url: string, body?: unknown): Promise<T> {
 const r = await fetch(url, body === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
 const data = await r.json().catch(() => ({}));
 if (!r.ok) throw new Error((data as { error?: string }).error || 'Operação não concluída.');
 return data as T;
}

// ---------------------------------------------------------------- formulário de cartão (Card Payment Brick)

type CardFormData = { token?: string; issuer_id?: string; payment_method_id?: string; payer?: { email?: string; identification?: { type?: string; number?: string } } };
type BrickController = { unmount: () => void };
type MercadoPagoSdk = new (publicKey: string, options: { locale: string }) => { bricks: () => { create: (kind: string, containerId: string, settings: unknown) => Promise<BrickController> } };
declare global { interface Window { MercadoPago?: MercadoPagoSdk } }

let sdkPromise: Promise<void> | null = null;
function loadMercadoPagoSdk(): Promise<void> {
 if (window.MercadoPago) return Promise.resolve();
 sdkPromise ??= new Promise<void>((resolve, reject) => {
  const script = document.createElement('script');
  script.src = 'https://sdk.mercadopago.com/js/v2';
  script.async = true;
  script.onload = () => resolve();
  script.onerror = () => { sdkPromise = null; reject(new Error('Não foi possível carregar o formulário seguro do Mercado Pago.')); };
  document.head.appendChild(script);
 });
 return sdkPromise;
}

function CardForm({ invoice, publicKey, payerEmail, onResult }: { invoice: Invoice; publicKey: string; payerEmail: string; onResult: (approved: boolean, message: string) => void }) {
 const containerId = `mp-card-${invoice.id}`;
 const [ready, setReady] = useState(false), [error, setError] = useState('');
 const resultRef = useRef(onResult);
 resultRef.current = onResult;
 useEffect(() => {
  let controller: BrickController | null = null, cancelled = false, loaded = false;
  setReady(false); setError('');
  const failed = () => { if (!cancelled) setError('O formulário de cartão não carregou. Tente de novo mais tarde ou use Pix.'); };
  // O SDK às vezes só registra a falha no console: sem "pronto" em 20 s, avisa em vez de ficar carregando.
  const timer = window.setTimeout(() => { if (!loaded) failed(); }, 20_000);
  loadMercadoPagoSdk().then(async () => {
   if (cancelled || !window.MercadoPago) return;
   const mp = new window.MercadoPago(publicKey, { locale: 'pt-BR' });
   controller = await mp.bricks().create('cardPayment', containerId, {
    initialization: { amount: invoice.amountCents / 100, payer: { email: payerEmail } },
    customization: { paymentMethods: { minInstallments: 1, maxInstallments: 1, types: { included: ['credit_card', 'debit_card'] } }, visual: { hideFormTitle: true } },
    callbacks: {
     onReady: () => { loaded = true; setReady(true); },
     onError: (e: { type?: string }) => { if (!loaded || e?.type === 'critical') failed(); else setError('Não foi possível validar os dados do cartão. Confira e tente de novo, ou use Pix.'); },
     // O cartão nunca passa pelo OmniHub: o Mercado Pago devolve só um token de uso único.
     onSubmit: async (data: CardFormData) => {
      setError('');
      let r: { paymentStatus: string; paymentStatusDetail: string; invoice: Invoice };
      try {
       r = await call('/api/subscription', {
        action: 'pay', invoiceId: invoice.id, method: 'card', payerEmail: payerEmail || data.payer?.email, token: data.token, paymentMethodId: data.payment_method_id,
        issuerId: data.issuer_id, identificationType: data.payer?.identification?.type, identificationNumber: data.payer?.identification?.number,
       });
      } catch (err) {
       setError(err instanceof Error ? err.message : 'Não foi possível realizar a cobrança.');
       throw err;
      }
      if (r.invoice.status === 'paid' || r.paymentStatus === 'approved') { resultRef.current(true, 'Pagamento aprovado.'); return; }
      if (['pending', 'in_process', 'authorized'].includes(r.paymentStatus)) { resultRef.current(false, 'Pagamento em análise pelo Mercado Pago. A conta é ativada assim que for aprovado.'); return; }
      const msg = `Pagamento não aprovado${r.paymentStatusDetail ? ` (${r.paymentStatusDetail})` : ''}. Confira os dados do cartão ou use Pix.`;
      setError(msg);
      throw new Error(msg);
     },
    },
   });
   if (cancelled) controller.unmount();
  }).catch(failed);
  return () => { cancelled = true; window.clearTimeout(timer); controller?.unmount(); };
 }, [containerId, invoice.amountCents, invoice.id, payerEmail, publicKey]);
 return <div className="stack">
  {!ready && !error && <p className="muted"><LoaderCircle className="inline animate-spin" size={14} /> Carregando formulário seguro do Mercado Pago…</p>}
  <div id={containerId} />
  {error && <p role="alert" className="notice error">{error}</p>}
 </div>;
}

// ---------------------------------------------------------------- painel de pagamento (Pix ou cartão)

type PixData = { qrCode: string | null; qrCodeBase64: string | null; ticketUrl: string | null };

export function PaymentPanel({ invoice, checkout, defaultPayerEmail, onPaid }: { invoice: Invoice; checkout: Checkout; defaultPayerEmail: string; onPaid: () => void }) {
 const [method, setMethod] = useState<'pix' | 'card'>('pix'), [payer, setPayer] = useState(defaultPayerEmail), [cardPayer, setCardPayer] = useState(defaultPayerEmail), [pix, setPix] = useState<PixData | null>(null);
 const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [paid, setPaid] = useState(invoice.status === 'paid'), [waiting, setWaiting] = useState(false);
 // Com pagamento em andamento, confere a cada 5 s (o servidor consulta o Mercado Pago).
 useEffect(() => {
  if (paid || !waiting) return;
  const t = window.setInterval(async () => {
   try { const r = await call<{ invoice: Invoice }>(`/api/subscription?invoice=${encodeURIComponent(invoice.id)}`); if (r.invoice.status === 'paid') setPaid(true); } catch { /* tenta de novo no próximo ciclo */ }
  }, 5000);
  return () => window.clearInterval(t);
 }, [invoice.id, paid, waiting]);
 const generatePix = async () => {
  setBusy(true); setError(''); setNotice('');
  try {
   const r = await call<PixData & { invoice: Invoice; paymentStatus: string }>('/api/subscription', { action: 'pay', invoiceId: invoice.id, method: 'pix', payerEmail: payer });
   if (r.invoice.status === 'paid') { setPaid(true); return; }
   setPix({ qrCode: r.qrCode, qrCodeBase64: r.qrCodeBase64, ticketUrl: r.ticketUrl }); setWaiting(true);
  } catch (e) { setError(e instanceof Error ? e.message : 'Não foi possível gerar o Pix.'); }
  finally { setBusy(false); }
 };
 const onCardResult = useCallback((approved: boolean, message: string) => { if (approved) setPaid(true); else { setNotice(message); setWaiting(true); } }, []);
 if (paid) return <div className="notice stack">
  <strong>Pagamento aprovado. Sua conta foi ativada.</strong>
  <div><Button onClick={onPaid}><Check /> Continuar</Button></div>
 </div>;
 return <div className="stack">
  <div className="list-row px-0"><span>Plano</span><strong>{invoice.planName}</strong></div>
  <div className="list-row px-0"><span>Total</span><strong>{money(invoice.amountCents)}</strong></div>
  <label className="field">E-mail do pagador<input type="email" required value={payer} onChange={(e) => setPayer(e.target.value)} onBlur={() => setCardPayer(payer)} /></label>
  <div className="inline flex-wrap" style={{ gap: 8 }}>
   <Button type="button" variant={method === 'pix' ? 'default' : 'outline'} onClick={() => { setError(''); setMethod('pix'); }}><QrCode /> Pix</Button>
   <Button type="button" variant={method === 'card' ? 'default' : 'outline'} onClick={() => { setError(''); setCardPayer(payer); setMethod('card'); }}><CreditCard /> Crédito ou débito</Button>
  </div>
  {method === 'pix' && <div className="stack">
   {!checkout.pixEnabled ? <p className="notice error">Pagamento online indisponível no momento.</p> : <>
    <div><Button disabled={busy || !payer} onClick={() => void generatePix()}>{busy ? <LoaderCircle className="animate-spin" /> : <QrCode />} {pix ? 'Gerar novamente' : 'Gerar QR Code Pix'}</Button></div>
    {pix && <div className="panel p-4 stack" style={{ alignItems: 'center', textAlign: 'center' }}>
     {pix.qrCodeBase64 && <img src={`data:image/png;base64,${pix.qrCodeBase64}`} alt="QR Code Pix" width={224} height={224} />}
     {pix.qrCode && <>
      <textarea readOnly value={pix.qrCode} rows={3} style={{ width: '100%' }} onFocus={(e) => e.currentTarget.select()} />
      <Button variant="outline" onClick={() => { void navigator.clipboard.writeText(pix.qrCode!).then(() => setNotice('Código Pix copiado.')); }}><Copy /> Copiar código Pix</Button>
     </>}
     <p className="muted mb-0"><LoaderCircle className="inline animate-spin" size={14} /> Depois de pagar, a confirmação é automática.</p>
    </div>}
   </>}
  </div>}
  {method === 'card' && (checkout.cardEnabled && checkout.publicKey
   ? (cardPayer ? <CardForm invoice={invoice} publicKey={checkout.publicKey} payerEmail={cardPayer} onResult={onCardResult} /> : <p className="muted">Informe o e-mail do pagador.</p>)
   : <p className="notice error">Pagamento com cartão indisponível no momento. Use Pix.</p>)}
  {notice && <p className="notice">{notice}</p>}
  {error && <p role="alert" className="notice error">{error}</p>}
 </div>;
}

function PlanCard({ plan, selected, onSelect }: { plan: Plan; selected: boolean; onSelect: () => void }) {
 return <button type="button" onClick={onSelect} className="panel p-4 stack text-left" style={{ cursor: 'pointer', borderColor: selected ? 'var(--primary, #2563eb)' : undefined, boxShadow: selected ? '0 0 0 2px var(--primary, #2563eb)' : undefined }}>
  <div className="split"><strong>{plan.name}</strong>{selected && <span className="badge">Escolhido</span>}</div>
  {plan.description && <span className="muted">{plan.description}</span>}
  <span className="text-2xl font-semibold">{money(plan.priceCents)}<small className="muted"> /mês</small></span>
  <span>Até {plan.maxStores} {plan.maxStores === 1 ? 'loja' : 'lojas'}</span>
  {plan.features.length > 0 && <ul className="stack" style={{ gap: 4, margin: 0, paddingLeft: 0, listStyle: 'none' }}>{plan.features.map((f) => <li key={f} className="inline" style={{ gap: 6 }}><Check size={14} /> {f}</li>)}</ul>}
 </button>;
}

// ---------------------------------------------------------------- cadastro: plano → dados → pagamento na tela

type SignupOptions = { plans: Plan[]; billingReady: boolean; registrationEnabled: boolean; checkout: Checkout };

export function SignupWithPlan({ onRegistered, onLogin }: { onRegistered: () => void; onLogin: () => void }) {
 const [options, setOptions] = useState<SignupOptions | null>(null), [planId, setPlanId] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
 const [company, setCompany] = useState(''), [name, setName] = useState(''), [email, setEmail] = useState(''), [password, setPassword] = useState(''), [invoice, setInvoice] = useState<Invoice | null>(null);
 useEffect(() => {
  call<SignupOptions>('/api/plans')
   .then((o) => { setOptions(o); if (o.plans.length === 1) setPlanId(o.plans[0].id); })
   .catch(() => setOptions({ plans: [], billingReady: false, registrationEnabled: true, checkout: { pixEnabled: false, cardEnabled: false, publicKey: null } }));
 }, []);
 const submit = async (e: FormEvent) => {
  e.preventDefault();
  setBusy(true); setError('');
  try {
   const r = await call<{ invoice: Invoice | null }>('/api/auth/register', { accountName: company, displayName: name, email, password, planId });
   if (r.invoice) setInvoice(r.invoice); else onRegistered(); // administrador da plataforma: entra sem plano
  } catch (err) { setError(err instanceof Error ? err.message : 'Não foi possível criar a conta.'); }
  finally { setBusy(false); }
 };
 if (!options) return <p className="muted"><LoaderCircle className="inline animate-spin" size={16} /> Carregando planos…</p>;
 if (!options.registrationEnabled) return <p className="notice">O cadastro de novas contas está desativado. <button type="button" className="underline" onClick={onLogin}>Entrar</button></p>;
 if (invoice) return <div className="stack">
  <h2>Pagamento seguro</h2>
  <PaymentPanel invoice={invoice} checkout={options.checkout} defaultPayerEmail={email} onPaid={onRegistered} />
 </div>;
 const available = options.billingReady && options.plans.length > 0;
 return <div className="stack">
  {available ? <div className="cards">{options.plans.map((p) => <PlanCard key={p.id} plan={p} selected={p.id === planId} onSelect={() => setPlanId(p.id)} />)}</div>
   : <p className="notice">{options.billingReady ? 'Nenhum plano disponível no momento.' : 'A contratação online está indisponível no momento.'} Tente mais tarde.</p>}
  <p className="muted mb-0">Sem plano grátis. A conta é ativada após o pagamento confirmado.</p>
  <form className="form-grid" onSubmit={(e) => void submit(e)}>
   {available && <label className="field full">Plano<select required value={planId} onChange={(e) => setPlanId(e.target.value)}><option value="">Escolha o plano</option>{options.plans.map((p) => <option key={p.id} value={p.id}>{p.name} - {money(p.priceCents)}/mês</option>)}</select></label>}
   <label className="field">Empresa<input required minLength={2} maxLength={100} value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Nome da empresa" /></label>
   <label className="field">Seu nome<input required minLength={2} maxLength={100} value={name} onChange={(e) => setName(e.target.value)} placeholder="Nome do administrador" /></label>
   <label className="field">E-mail<input required type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="voce@empresa.com" /></label>
   <label className="field">Senha<input required type="password" minLength={8} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Mínimo de 8 caracteres" /></label>
   {error && <p role="alert" className="notice error full">{error}</p>}
   <div className="full"><Button className="w-full" disabled={busy}>{busy ? <LoaderCircle className="animate-spin" /> : <Check />} Continuar para pagamento</Button></div>
  </form>
  <p className="muted mb-0">Já tem conta? <button type="button" className="underline" onClick={onLogin}>Entrar</button></p>
 </div>;
}

// ---------------------------------------------------------------- conta criada que ainda não pagou

export function ActivationScreen({ ownerEmail, onActivated, onLogout }: { ownerEmail: string; onActivated: () => void; onLogout: () => void }) {
 const [view, setView] = useState<PageView | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [choosing, setChoosing] = useState(false), [planId, setPlanId] = useState('');
 const load = useCallback(async () => { try { setView(await call<PageView>('/api/subscription')); } catch (e) { setError(e instanceof Error ? e.message : 'Falha ao consultar.'); } }, []);
 useEffect(() => { void load(); }, [load]);
 const open = view?.invoices.find((i) => i.status === 'pending' || i.status === 'failed') ?? null;
 const choose = async (e: FormEvent) => {
  e.preventDefault();
  setBusy(true); setError('');
  try { await call('/api/subscription', { action: 'choose', planId }); setChoosing(false); await load(); }
  catch (err) { setError(err instanceof Error ? err.message : 'Não foi possível escolher o plano.'); }
  finally { setBusy(false); }
 };
 return <section className="panel login stack" style={{ maxWidth: 980 }}>
  <h1>Ative sua conta</h1>
  {!view ? <p className="muted"><LoaderCircle className="inline animate-spin" size={16} /> Carregando…</p>
   : open && !choosing ? <>
    <h2>Pagamento seguro</h2>
    <PaymentPanel key={open.id} invoice={open} checkout={view.checkout} defaultPayerEmail={ownerEmail} onPaid={onActivated} />
    <div><Button variant="ghost" onClick={() => { setPlanId(''); setChoosing(true); }}>Escolher outro plano</Button></div>
   </> : <form className="stack" onSubmit={(e) => void choose(e)}>
    {!view.billingReady || !view.plans.length ? <p className="notice">A contratação online está indisponível no momento. Tente mais tarde.</p> : <>
     <p>Escolha o plano para pagar e começar a usar.</p>
     <div className="cards">{view.plans.map((p) => <PlanCard key={p.id} plan={p} selected={p.id === planId} onSelect={() => setPlanId(p.id)} />)}</div>
     <div className="inline" style={{ gap: 8 }}><Button disabled={busy || !planId}>{busy ? <LoaderCircle className="animate-spin" /> : <Check />} Continuar para pagamento</Button>{open && <Button type="button" variant="outline" onClick={() => setChoosing(false)}>Voltar</Button>}</div>
    </>}
   </form>}
  {error && <p role="alert" className="notice error">{error}</p>}
  <p className="muted mb-0">Sem plano grátis. A conta é ativada após o pagamento confirmado. <button type="button" className="underline" onClick={onLogout}>Sair</button></p>
 </section>;
}

// ---------------------------------------------------------------- tela Assinatura (conta em uso)

export function SubscriptionPage({ ownerEmail, storesUsed, onChanged }: { ownerEmail: string; storesUsed: number; onChanged: () => void }) {
 const [view, setView] = useState<PageView | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [planId, setPlanId] = useState(''), [confirmCancel, setConfirmCancel] = useState(false);
 const load = useCallback(async () => { try { setView(await call<PageView>('/api/subscription')); } catch (e) { setError(e instanceof Error ? e.message : 'Falha ao consultar.'); } }, []);
 useEffect(() => { void load(); }, [load]);
 const act = async (body: unknown) => {
  setBusy(true); setError('');
  try { await call('/api/subscription', body); await load(); onChanged(); }
  catch (e) { setError(e instanceof Error ? e.message : 'Operação não concluída.'); }
  finally { setBusy(false); setConfirmCancel(false); }
 };
 if (!view) return <section className="panel p-6">{error ? <p role="alert" className="notice error">{error}</p> : <p className="muted"><LoaderCircle className="inline animate-spin" size={16} /> Carregando…</p>}</section>;
 const access = view.access;
 const platform = access.status === 'platform';
 const current = view.invoices.find((i) => i.status === 'paid');
 const open = view.invoices.find((i) => i.status === 'pending' || i.status === 'failed');
 const valid = access.accessUntil > Date.now() && ['active', 'trial', 'cancelled'].includes(access.status);
 return <div className="stack">
  <section className="panel p-6 stack">
   <div className="split"><h2>Plano atual</h2><Button variant="outline" size="sm" disabled={busy} onClick={() => void load()}><RefreshCw /> Atualizar</Button></div>
   <div className="list-row px-0"><span>Situação</span><strong>{ACCESS_LABEL[access.status] ?? access.status}</strong></div>
   {current && <div className="list-row px-0"><span>Plano</span><strong>{current.planName} · {money(current.amountCents)}/mês</strong></div>}
   {!platform && access.accessUntil > 0 && <div className="list-row px-0"><span>{valid ? 'Acesso até' : 'Acesso terminou em'}</span><strong>{date(access.accessUntil)}</strong></div>}
   <div className="list-row px-0"><span>Lojas</span><strong>{storesUsed} de {access.maxStores}</strong></div>
   {platform && <p className="notice">Conta de administrador da plataforma: liberada sem assinatura.</p>}
  </section>
  {!platform && open && <section className="panel p-6 stack">
   <h2>{valid ? 'Pagar a próxima mensalidade' : 'Pagamento pendente'}</h2>
   <PaymentPanel key={open.id} invoice={open} checkout={view.checkout} defaultPayerEmail={ownerEmail} onPaid={() => { void load(); onChanged(); }} />
  </section>}
  {!platform && view.billingReady && view.plans.length > 0 && <section className="panel p-6 stack">
   <h2>{current ? 'Trocar de plano' : 'Escolher plano'}</h2>
   <div className="cards">{view.plans.map((p) => <PlanCard key={p.id} plan={p} selected={p.id === planId} onSelect={() => setPlanId(p.id)} />)}</div>
   <div><Button disabled={busy || !planId} onClick={() => void act({ action: 'choose', planId })}><Check /> Continuar para pagamento</Button></div>
  </section>}
  {!platform && access.status === 'active' && <section className="panel p-6 stack">
   <h2>Cancelar renovação</h2>
   <p className="muted">Não serão geradas novas mensalidades. O acesso continua até o fim do período já pago.</p>
   {confirmCancel ? <div className="inline" style={{ gap: 8 }}><Button variant="destructive" disabled={busy} onClick={() => void act({ action: 'cancel' })}><X /> Confirmar cancelamento</Button><Button variant="outline" onClick={() => setConfirmCancel(false)}>Voltar</Button></div>
    : <div><Button variant="outline" disabled={busy} onClick={() => setConfirmCancel(true)}>Cancelar renovação</Button></div>}
  </section>}
  {view.invoices.length > 0 && <section className="panel p-6 stack">
   <h2>Pagamentos</h2>
   {view.invoices.map((i) => <div key={i.id} className="list-row px-0"><span>{i.planName} · {money(i.amountCents)} · {date(i.createdAt)}</span><strong>{INVOICE_LABEL[i.status] ?? i.status}{i.paidAt ? ` em ${date(i.paidAt)}` : ''}</strong></div>)}
  </section>}
  {error && <p role="alert" className="notice error">{error}</p>}
 </div>;
}

// ---------------------------------------------------------------- plataforma: cadastro dos planos

type Overview = { plans: Plan[]; adminMaxStores: number | null; billingProblems: string[]; accounts: { id: string; name: string; ownerEmail: string; status: string; accessUntil: number; maxStores: number; stores: number; planName: string; subscriptionStatus: string; platform: boolean }[] };
const toCents = (v: string) => { if (!/^\d+(?:[,.]\d{1,2})?$/.test(v.trim())) return NaN; const [a, b = ''] = v.trim().replace(',', '.').split('.'); return Number(a) * 100 + Number(b.padEnd(2, '0')); };

export function PlatformPage() {
 const [data, setData] = useState<Overview | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
 const [form, setForm] = useState<{ id?: string; name: string; price: string; maxStores: string; description: string; features: string; active: boolean } | null>(null), [adminStores, setAdminStores] = useState('');
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
  if (await run({ action: 'savePlan', id: form.id, name: form.name, priceCents, maxStores: Number(form.maxStores), description: form.description, features: form.features, active: form.active }, 'Plano salvo.')) setForm(null);
 };
 if (!data) return <section className="panel p-6">{error ? <p role="alert" className="notice error">{error}</p> : <p className="muted"><LoaderCircle className="inline animate-spin" size={16} /> Carregando…</p>}</section>;
 return <div className="stack">
  {error && <p role="alert" className="notice error">{error}</p>}
  {notice && <p className="notice">{notice}</p>}
  <section className="panel p-6 stack">
   <h2>Cobrança dos planos (Mercado Pago)</h2>
   {data.billingProblems.length ? <p className="notice error">Contratação online desligada. Configure no servidor: {data.billingProblems.join('; ')}.</p>
    : <p className="muted">Ativa. O cliente paga na tela por Pix; o cartão de crédito/débito aparece quando PLATFORM_MP_PUBLIC_KEY está configurada. A confirmação é feita por consulta ao Mercado Pago, sem webhook.</p>}
  </section>
  <section className="panel p-6 stack">
   <div className="split"><h2>Planos</h2><Button size="sm" onClick={() => setForm({ name: '', price: '', maxStores: '', description: '', features: '', active: true })}><Plus /> Novo plano</Button></div>
   <p className="muted">Cobrança mensal. Alterar preço ou limite vale para as próximas mensalidades.</p>
   {form && <form className="form-grid" onSubmit={(e) => void savePlan(e)}>
    <label className="field">Nome<input required maxLength={60} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
    <label className="field">Preço mensal (R$)<input required inputMode="decimal" placeholder="0,00" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} /></label>
    <label className="field">Limite de lojas<input required type="number" min={1} value={form.maxStores} onChange={(e) => setForm({ ...form, maxStores: e.target.value })} /></label>
    <label className="field full">Descrição (aparece na página de cadastro)<input maxLength={300} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Para quem é este plano" /></label>
    <label className="field full">Recursos (um por linha, aparecem no cartão do plano)<textarea rows={5} value={form.features} onChange={(e) => setForm({ ...form, features: e.target.value })} /></label>
    <label className="field inline" style={{ gap: 6 }}><input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} style={{ width: 'auto', height: 'auto' }} /> Disponível para contratar</label>
    <div className="form-actions full"><Button type="button" variant="outline" onClick={() => setForm(null)}>Cancelar</Button><Button type="submit" disabled={busy}><Check /> Salvar plano</Button></div>
   </form>}
   {!data.plans.length ? <p className="notice">Nenhum plano cadastrado. Sem plano disponível, contas novas não conseguem assinar.</p>
    : data.plans.map((p) => <div key={p.id} className="list-row px-0"><span>{p.name} · {money(p.priceCents)}/mês · até {p.maxStores} {p.maxStores === 1 ? 'loja' : 'lojas'}{p.active ? '' : ' · indisponível'}</span><Button size="sm" variant="outline" onClick={() => setForm({ id: p.id, name: p.name, price: (p.priceCents / 100).toFixed(2).replace('.', ','), maxStores: String(p.maxStores), description: p.description, features: p.features.join('\n'), active: p.active })}><Pencil /> Editar</Button></div>)}
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
   {data.accounts.map((a) => <div key={a.id} className="list-row px-0"><span><strong>{a.name}</strong> · {a.ownerEmail || 'sem titular'}<br /><small className="muted">{a.platform ? 'Administrador da plataforma' : `${ACCESS_LABEL[a.status] ?? a.status}${a.planName ? ` · ${a.planName}` : ''}${a.subscriptionStatus ? ` · último pagamento: ${INVOICE_LABEL[a.subscriptionStatus] ?? a.subscriptionStatus}` : ''}`}</small></span><small>{a.stores}/{a.platform ? data.adminMaxStores ?? 0 : a.maxStores} lojas{!a.platform && a.accessUntil > 0 ? ` · até ${date(a.accessUntil)}` : ''}</small></div>)}
  </section>
 </div>;
}
