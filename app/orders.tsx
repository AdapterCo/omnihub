'use client';
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { Plus, X, Check, Pencil, MessageSquare, Trash2, PackagePlus, FileSignature, Paperclip, Eye, Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Table, TableHeader, TableHead, TableBody, TableRow, TableCell } from '@/components/ui/table';
import { money, date, type Snapshot, type OrderView, type UnitView, type StoreRecord, type ContractView, type DocumentView } from '@/lib/domain';
import { OrderBilling } from './order-billing';

// Aba Pedidos (venda com contrato de moto e locação) e painel de unidades com chassi/IMEI.
// Toda regra fica no backend (lib/orders/service.ts); a tela só coleta e mostra os dados.

type Act = (command: unknown) => Promise<unknown>;
type Values = Record<string, string>;

const STORE_METHODS = ['Dinheiro', 'Pix', 'Cartão de crédito', 'Cartão de débito'];
// Mesmos valores de lib/fiscal/operation.ts (SALE_CHANNELS): definem o indPres da nota fiscal.
const SALE_CHANNEL_LABEL: Record<string, string> = { PRESENCIAL: 'Na loja (presencial)', INTERNET: 'Pela internet / WhatsApp', ENTREGA: 'Entrega em domicílio' };
const SALE_CHANNEL_OPTIONS = Object.entries(SALE_CHANNEL_LABEL).map(([value, label]) => ({ value, label }));
const ORDER_STATUS: Record<string, { label: string; tone: string }> = {
 OPEN: { label: 'Em aberto (unidade reservada)', tone: 'warning' },
 COMPLETING: { label: 'Finalizando...', tone: 'warning' },
 COMPLETED: { label: 'Finalizado', tone: 'success' },
 CANCELLED: { label: 'Cancelado', tone: 'error' },
};
const UNIT_STATUS: Record<string, string> = { AVAILABLE: 'Disponível', RESERVED: 'Reservada', SOLD: 'Vendida', RENTED: 'Locada' };
// Status técnico do contrato (guardado separado) → texto para o usuário (§15 da especificação).
const CONTRACT_STATUS: Record<string, { label: string; tone: string }> = {
 GENERATED: { label: 'Gerado: aguardando envio para assinatura', tone: 'warning' },
 SUPERSEDED: { label: 'Substituído por uma revisão mais nova', tone: 'neutral' },
 CANCELLED: { label: 'Cancelado', tone: 'error' },
 SENDING: { label: 'Enviando: aguardando confirmação do Adapter Sign', tone: 'warning' },
 SENT: { label: 'Aguardando assinatura do cliente', tone: 'warning' },
 CLIENT_SIGNED: { label: 'Cliente assinou: finalizando', tone: 'warning' },
 FINALIZING: { label: 'Baixando o contrato assinado', tone: 'warning' },
 COMPLETED: { label: 'Contrato assinado', tone: 'success' },
 EXPIRED: { label: 'Expirado: gere e envie de novo', tone: 'error' },
 DECLINED: { label: 'Recusado pelo cliente', tone: 'error' },
};
// Status que ainda permitem gerar uma revisão nova do contrato (nada pendente no Adapter Sign).
const REGENERABLE = ['GENERATED', 'CANCELLED', 'EXPIRED', 'DECLINED'];
export function addMonthsKey(key: string, months: number): string { const [y, m, d] = key.split('-').map(Number); const dt = new Date(Date.UTC(y, m - 1 + months, 1)); const last = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 0)).getUTCDate(); return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`; }
const DOC_TYPE: Record<string, string> = { ANEXO: 'Anexo', CONTRATO_ORIGINAL: 'Contrato gerado automaticamente', CONTRATO_ASSINADO: 'Contrato assinado', EVIDENCIA_ASSINATURA: 'Relatório de evidências Adapter Sign', BOLETOS: 'Boletos (arquivo único)' };
const ACCEPT = 'application/pdf,image/jpeg,image/png,.pdf,.jpg,.jpeg,.png';

const toCents = (v: string | undefined) => {
 const n = Number(String(v ?? '').replace(/\./g, '').replace(',', '.'));
 return Number.isFinite(n) ? Math.round(n * 100) : NaN;
};
const fromCents = (c: number) => (c / 100).toFixed(2).replace('.', ',');
const brDate = (iso: string) => (iso ? iso.split('-').reverse().join('/') : '—');
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());

function Field({ label, children, full, hint }: { label: string; children: ReactNode; full?: boolean; hint?: string }) {
 return <label className={'field ' + (full ? 'full' : '')}>{label}{children}{hint && <small className="muted">{hint}</small>}</label>;
}
function NativePick({ value, onChange, options, placeholder }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; placeholder?: string }) {
 return <select className="native-select" value={value} onChange={(e) => onChange(e.target.value)}>
  <option value="">{placeholder ?? 'Selecione'}</option>
  {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
 </select>;
}

export function OrdersPage({ data, act, stores, storeFilter, busy, active, refresh, focusOrderId, onFocused }: { data: Snapshot; act: Act; stores: StoreRecord[]; storeFilter: string; busy: boolean; active: boolean; refresh: () => Promise<unknown>; focusOrderId?: string | null; onFocused?: () => void }) {
 const perms = new Set((data.actor.permissions as unknown as string[]) ?? []);
 const orders = (data.state.orders ?? []).filter((o) => storeFilter === 'all' || o.storeId === storeFilter);
 const [search, setSearch] = useState('');
 const [editing, setEditing] = useState<OrderView | 'new' | null>(null);
 const [viewing, setViewing] = useState<string | null>(null);
 // Aberto a partir da aba Boletos e inadimplência ("Abrir pedido").
 useEffect(() => { if (focusOrderId) { setEditing(null); setViewing(focusOrderId); onFocused?.(); } }, [focusOrderId]); // eslint-disable-line react-hooks/exhaustive-deps
 const current = viewing ? (data.state.orders ?? []).find((o) => o.id === viewing) ?? null : null;
 const q = search.trim().toLowerCase();
 const list = q ? orders.filter((o) => [String(o.number), o.customerName, o.serial, o.productName, o.sellerName].some((x) => x.toLowerCase().includes(q))) : orders;
 const orderStores = stores.filter((s) => s.modalities?.includes('VENDA_CONTRATO') || s.modalities?.includes('LOCACAO'));
 return <>
  <div className="toolbar">
   <input className="search-input" placeholder="Buscar por número, cliente, chassi/IMEI ou vendedor" value={search} onChange={(e) => setSearch(e.target.value)} />
   {perms.has('ORDER_CREATE') && <Button disabled={!active || busy || !orderStores.length} onClick={() => setEditing('new')}><Plus /> Novo pedido</Button>}
  </div>
  {!orderStores.length && <div className="notice">Nenhuma loja tem as modalidades Venda com contrato ou Locação. Habilite em Minhas lojas &gt; Editar.</div>}
  <section className="panel">
   {list.length ? <div className="table-pad"><Table><TableHeader><TableRow>{['Pedido', 'Cliente', 'Produto / unidade', 'Condições', 'Status', 'Ação'].map((h) => <TableHead key={h}>{h}</TableHead>)}</TableRow></TableHeader>
    <TableBody>{list.map((o) => <TableRow key={o.id}>
     <TableCell><strong>#{o.number}</strong><div className="muted">{o.type === 'VENDA' ? 'Venda (moto)' : 'Locação'} · {date(o.createdAt)}</div><div className="muted">{o.sellerName}</div></TableCell>
     <TableCell>{o.customerName}<div className="muted">{o.customerDocument}</div></TableCell>
     <TableCell>{o.productName}<div className="muted">{o.type === 'VENDA' ? 'Chassi' : 'IMEI'} {o.serial}</div></TableCell>
     <TableCell>{o.type === 'VENDA' ? <>{money(o.total)}<div className="muted">{o.installments ? `Entrada ${money(o.downPayment)} + ${o.installments}x boleto` : `À vista na loja (${o.downPaymentMethod})`}</div></> : <>Adesão {money(o.adhesionAmount)}<div className="muted">12x {money(o.monthlyAmount)} · dia {o.dueDay}</div></>}</TableCell>
     <TableCell><span className={'badge ' + (ORDER_STATUS[o.status]?.tone ?? 'neutral')}>{ORDER_STATUS[o.status]?.label ?? o.status}</span></TableCell>
     <TableCell><Button variant="outline" size="sm" onClick={() => setViewing(o.id)}>Abrir</Button></TableCell>
    </TableRow>)}</TableBody></Table></div>
    : <div className="list-row"><span className="muted">{orders.length ? 'Nenhum pedido encontrado na busca.' : 'Nenhum pedido ainda. O pedido reserva a unidade (chassi/IMEI) até ser finalizado ou cancelado.'}</span></div>}
  </section>
  {editing && <OrderForm data={data} act={act} stores={orderStores} order={editing === 'new' ? null : editing} busy={busy} onClose={() => setEditing(null)} onSaved={(id) => { setEditing(null); if (id) setViewing(id); }} />}
  {current && !editing && <OrderDetail order={current} contracts={(data.state.contracts ?? []).filter((c) => c.orderId === current.id)} documents={(data.state.documents ?? []).filter((d) => d.orderId === current.id)} act={act} refresh={refresh} perms={perms} busy={busy} active={active} onClose={() => setViewing(null)} onEdit={() => setEditing(current)} />}
 </>;
}

function OrderForm({ data, act, stores, order, busy, onClose, onSaved }: { data: Snapshot; act: Act; stores: StoreRecord[]; order: OrderView | null; busy: boolean; onClose: () => void; onSaved: (id?: string) => void }) {
 const [v, setV] = useState<Values>((): Values => order ? {
  storeId: order.storeId, type: order.type, customerId: order.customerId, unitId: order.unitId,
  total: fromCents(order.total), purchaseDate: order.purchaseDate, downPayment: fromCents(order.downPayment), downPaymentMethod: order.downPaymentMethod, saleChannel: order.saleChannel,
  installments: String(order.installments), firstDueDate: order.firstDueDate,
  adhesionAmount: fromCents(order.adhesionAmount), adhesionBilling: order.adhesionBilling, adhesionPaymentMethod: order.adhesionPaymentMethod,
  monthlyAmount: fromCents(order.monthlyAmount), dueDay: order.dueDay ? String(order.dueDay) : '',
 } : { storeId: stores.length === 1 ? stores[0].id : '', type: '', customerId: '', unitId: '', purchaseDate: today(), installments: '0', downPayment: '', total: '' });
 const [error, setError] = useState('');
 const set = (k: string, value: string) => setV((p) => ({ ...p, [k]: value }));
 const store = stores.find((s) => s.id === v.storeId);
 const types = [store?.modalities?.includes('VENDA_CONTRATO') && { value: 'VENDA', label: 'Venda com contrato (moto)' }, store?.modalities?.includes('LOCACAO') && { value: 'LOCACAO', label: 'Locação com opção de compra' }].filter(Boolean) as { value: string; label: string }[];
 const type = v.type || (types.length === 1 ? types[0].value : '');
 const kind = type === 'VENDA' ? 'MOTO' : type === 'LOCACAO' ? 'LOCACAO' : '';
 const units = (data.state.units ?? []).filter((u) => u.storeId === v.storeId && u.kind === kind && (u.status === 'AVAILABLE' || u.id === order?.unitId));
 const customers = data.state.customers ?? [];
 const installments = Number(v.installments || 0);
 const financed = toCents(v.total) - toCents(v.downPayment || '0');
 const submit = async (e: FormEvent) => {
  e.preventDefault();
  setError('');
  if (!v.storeId || !type || !v.customerId || !v.unitId) { setError('Escolha a loja, o tipo, o cliente e a unidade.'); return; }
  const terms: Record<string, unknown> = { customerId: v.customerId, unitId: v.unitId };
  if (type === 'VENDA') {
   Object.assign(terms, { total: toCents(v.total), purchaseDate: v.purchaseDate, installments, downPayment: installments === 0 ? toCents(v.total) : toCents(v.downPayment || '0'), downPaymentMethod: v.downPaymentMethod || undefined, saleChannel: v.saleChannel || undefined });
   if (installments > 0) terms.firstDueDate = v.firstDueDate;
  } else {
   Object.assign(terms, { adhesionAmount: toCents(v.adhesionAmount), monthlyAmount: toCents(v.monthlyAmount), firstDueDate: v.firstDueDate, adhesionBilling: 'LOJA', adhesionPaymentMethod: v.adhesionPaymentMethod || undefined });
  }
  for (const value of Object.values(terms)) if (typeof value === 'number' && Number.isNaN(value)) { setError('Confira os valores em R$ (use vírgula para os centavos).'); return; }
  const result = await act(order ? { type: 'order.update', id: order.id, ...terms } : { type: 'order.create', storeId: v.storeId, orderType: type, ...terms }) as { resultId?: string } | null;
  if (result) onSaved(order ? order.id : result.resultId);
 };
 return <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}><DialogContent className="sm:max-w-3xl max-h-[90vh] overflow-y-auto"><DialogHeader><DialogTitle>{order ? `Editar pedido #${order.number}` : 'Novo pedido'}</DialogTitle><DialogDescription>O pedido reserva a unidade escolhida. Os dados aqui são os que vão para o contrato.</DialogDescription></DialogHeader>
  <form onSubmit={submit}><fieldset disabled={busy} className="form-grid">
   {!order && <Field label="Loja"><NativePick value={v.storeId} onChange={(x) => { set('storeId', x); set('unitId', ''); set('type', ''); }} options={stores.map((s) => ({ value: s.id, label: s.name }))} /></Field>}
   {!order && <Field label="Tipo do pedido"><NativePick value={type} onChange={(x) => { set('type', x); set('unitId', ''); }} options={types} /></Field>}
   <Field label="Cliente" full hint={customers.length ? undefined : 'Cadastre o cliente na aba Clientes antes (nome, CPF, endereço, e-mail e telefone vão para o contrato).'}><NativePick value={v.customerId} onChange={(x) => set('customerId', x)} options={customers.map((c) => ({ value: c.id, label: `${c.name}${c.document ? ' · ' + c.document : ''}` }))} /></Field>
   <Field label={kind === 'LOCACAO' ? 'Aparelho (IMEI)' : 'Unidade (chassi/série)'} full hint={kind && !units.length ? 'Nenhuma unidade disponível desta loja. Cadastre em Produtos e estoque > Unidades.' : undefined}><NativePick value={v.unitId} onChange={(x) => set('unitId', x)} options={units.map((u) => ({ value: u.id, label: `${u.productName} · ${u.serial} · ${u.color}${u.memory ? ' · ' + u.memory : ''}${u.condition ? ' · ' + u.condition : ''}` }))} /></Field>
   {type === 'VENDA' && <>
    <Field label="Valor da venda (R$)"><input inputMode="decimal" value={v.total ?? ''} onChange={(e) => set('total', e.target.value)} /></Field>
    <Field label="Data da compra"><input type="date" value={v.purchaseDate ?? ''} onChange={(e) => set('purchaseDate', e.target.value)} /></Field>
    <Field label="Como o cliente comprou" hint="Internet e entrega exigem a UF no cadastro do cliente (venda para outro estado ainda não é emitida)."><NativePick value={v.saleChannel ?? ''} onChange={(x) => set('saleChannel', x)} options={SALE_CHANNEL_OPTIONS} /></Field>
    <Field label="Parcelas no boleto" hint="0 = pagamento total na loja."><input type="number" min={0} max={60} value={v.installments ?? '0'} onChange={(e) => set('installments', e.target.value)} /></Field>
    {installments > 0 ? <Field label="Entrada recebida na loja (R$)" hint="0 se não houver entrada."><input inputMode="decimal" value={v.downPayment ?? ''} onChange={(e) => set('downPayment', e.target.value)} /></Field> : <div />}
    {(installments === 0 || toCents(v.downPayment || '0') > 0) && <Field label={installments === 0 ? 'Forma de pagamento na loja' : 'Forma da entrada'}><NativePick value={v.downPaymentMethod ?? ''} onChange={(x) => set('downPaymentMethod', x)} options={STORE_METHODS.map((m) => ({ value: m, label: m }))} /></Field>}
    {installments > 0 && <Field label="1º vencimento do boleto"><input type="date" value={v.firstDueDate ?? ''} onChange={(e) => set('firstDueDate', e.target.value)} /></Field>}
    {installments > 0 && Number.isFinite(financed) && financed > 0 && <p className="muted full">Financiado no boleto: {money(financed)} em {installments} parcela(s). Os boletos são gerados pelo Asaas na etapa de cobrança.</p>}
   </>}
   {type === 'LOCACAO' && <>
    <Field label="Valor da adesão (R$)"><input inputMode="decimal" value={v.adhesionAmount ?? ''} onChange={(e) => set('adhesionAmount', e.target.value)} /></Field>
    <Field label="Forma de pagamento da adesão" hint="A adesão é paga na loja, no ato da assinatura (não gera boleto)."><NativePick value={v.adhesionPaymentMethod ?? ''} onChange={(x) => set('adhesionPaymentMethod', x)} options={STORE_METHODS.map((m) => ({ value: m, label: m }))} /></Field>
    <Field label="Mensalidade (R$)"><input inputMode="decimal" value={v.monthlyAmount ?? ''} onChange={(e) => set('monthlyAmount', e.target.value)} /></Field>
    <Field label="Vencimento da 1ª mensalidade" hint="Combinado com o cliente (dia 1 a 28). As outras 11 vencem no mesmo dia dos meses seguintes."><input type="date" value={v.firstDueDate ?? ''} onChange={(e) => set('firstDueDate', e.target.value)} /></Field>
    {v.firstDueDate && /^\d{4}-\d{2}-\d{2}$/.test(v.firstDueDate) && <p className="muted full">12 boletos de mensalidade: de {brDate(v.firstDueDate)} a {brDate(addMonthsKey(v.firstDueDate, 11))}, todo dia {Number(v.firstDueDate.slice(8, 10))}. Gerados todos de uma vez na etapa de cobrança.</p>}
   </>}
   {error && <p className="notice error full">{error}</p>}
  </fieldset>
  <div className="form-actions"><Button type="button" variant="outline" onClick={onClose}>Cancelar</Button><Button type="submit" disabled={busy}><Check /> {order ? 'Salvar alterações' : 'Criar pedido e reservar'}</Button></div>
  </form></DialogContent></Dialog>;
}

function OrderDetail({ order, contracts, documents, act, refresh, perms, busy, active, onClose, onEdit }: { order: OrderView; contracts: ContractView[]; documents: DocumentView[]; act: Act; refresh: () => Promise<unknown>; perms: Set<string>; busy: boolean; active: boolean; onClose: () => void; onEdit: () => void }) {
 const [note, setNote] = useState('');
 const [cancelReason, setCancelReason] = useState<string | null>(null);
 const [confirmComplete, setConfirmComplete] = useState(false);
 const open = order.status === 'OPEN';
 const rows: [string, ReactNode][] = [
  ['Cliente', <>{order.customerName}<div className="muted">{order.customerDocument}</div></>],
  ['Vendedor', order.sellerName],
  ['Produto', order.productName],
  [order.type === 'VENDA' ? 'Chassi/série' : 'IMEI', order.serial],
  ['Cor', order.color],
  ...(order.type === 'LOCACAO' ? [['Memória', order.memory], ['Estado do aparelho', order.condition]] as [string, ReactNode][] : []),
  ...(order.type === 'VENDA' ? [
   ['Valor', money(order.total)], ['Data da compra', brDate(order.purchaseDate)],
   ['Como comprou', SALE_CHANNEL_LABEL[order.saleChannel] ?? 'Não informado — edite o pedido antes de emitir a nota'],
   ['Pagamento', order.installments ? `Entrada ${money(order.downPayment)}${order.downPaymentMethod ? ` (${order.downPaymentMethod})` : ''} + ${order.installments}x no boleto, 1º vencimento ${brDate(order.firstDueDate)}` : `À vista na loja (${order.downPaymentMethod})`],
  ] as [string, ReactNode][] : [
   ['Adesão', `${money(order.adhesionAmount)} · ${order.adhesionBilling === 'BOLETO' ? 'boleto' : `na loja (${order.adhesionPaymentMethod})`}`],
   ['Mensalidades', order.firstDueDate ? `12x ${money(order.monthlyAmount)}, de ${brDate(order.firstDueDate)} a ${brDate(addMonthsKey(order.firstDueDate, 11))} (todo dia ${order.dueDay})` : `12x ${money(order.monthlyAmount)}, todo dia ${order.dueDay}`],
  ] as [string, ReactNode][]),
  ['Criado em', date(order.createdAt)],
  ...(order.completedAt ? [['Finalizado em', date(order.completedAt)]] as [string, ReactNode][] : []),
  ...(order.cancelledAt ? [['Cancelado em', `${date(order.cancelledAt)} · ${order.cancelReason}`]] as [string, ReactNode][] : []),
 ];
 return <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}><DialogContent className="sm:max-w-3xl max-h-[90vh] overflow-y-auto"><DialogHeader><DialogTitle>Pedido #{order.number} · {order.type === 'VENDA' ? 'Venda com contrato (moto)' : 'Locação'}</DialogTitle><DialogDescription><span className={'badge ' + (ORDER_STATUS[order.status]?.tone ?? 'neutral')}>{ORDER_STATUS[order.status]?.label ?? order.status}</span></DialogDescription></DialogHeader>
  <div className="stack">
   <div className="order-summary">{rows.map(([k, val]) => <div key={k}><span className="muted">{k}</span><strong>{val}</strong></div>)}</div>
   <ContractSection order={order} contracts={contracts} act={act} refresh={refresh} perms={perms} busy={busy} active={active} />
   <DocumentsSection order={order} documents={documents} act={act} refresh={refresh} perms={perms} busy={busy} active={active} />
   <OrderBilling order={order} perms={perms} active={active} refresh={refresh} />
   <section><h3 className="section-title"><MessageSquare size={16} /> Observações</h3>
    {order.notes.length ? order.notes.map((n) => <div key={n.id} className="note"><div className="muted">{n.author} · {date(n.createdAt)}</div><p>{n.text}</p></div>) : <p className="muted">Nenhuma observação.</p>}
    {perms.has('ORDER_VIEW') && <form className="inline" style={{ gap: 8, marginTop: 8 }} onSubmit={async (e) => { e.preventDefault(); if (!note.trim()) return; if (await act({ type: 'order.note', id: order.id, text: note.trim() })) setNote(''); }}>
     <input className="search-input" placeholder="Nova observação" value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} /><Button type="submit" variant="outline" disabled={busy || !active}>Adicionar</Button></form>}
   </section>
   {open && <div className="form-actions" style={{ justifyContent: 'flex-start', flexWrap: 'wrap' }}>
    {perms.has('ORDER_CREATE') && <Button variant="outline" disabled={busy || !active} onClick={onEdit}><Pencil /> Editar</Button>}
    {perms.has('ORDER_COMPLETE') && <Button disabled={busy || !active} onClick={() => setConfirmComplete(true)}><Check /> Finalizar na loja</Button>}
    {perms.has('ORDER_CANCEL') && <Button variant="outline" disabled={busy || !active} onClick={() => setCancelReason('')}><X /> Cancelar pedido</Button>}
   </div>}
   {confirmComplete && <div className="notice"><p>{order.type === 'VENDA' ? `Finalizar gera a venda no SEU caixa aberto: ${order.downPayment ? `${money(order.downPayment)} recebidos agora (${order.downPaymentMethod})` : 'sem valor recebido agora'}${order.installments ? ` + ${money(order.total - order.downPayment)} no boleto` : ''}. A unidade sai do estoque.` : `Finalizar entrega o aparelho ao cliente (sai do estoque como locado)${order.adhesionBilling === 'LOJA' ? ` e registra a adesão de ${money(order.adhesionAmount)} recebida na loja (${order.adhesionPaymentMethod})` : ''}.`}</p>
    <div className="form-actions" style={{ justifyContent: 'flex-start' }}><Button variant="outline" onClick={() => setConfirmComplete(false)}>Voltar</Button><Button disabled={busy} onClick={async () => { if (await act({ type: 'order.complete', id: order.id })) setConfirmComplete(false); }}>Confirmar finalização</Button></div></div>}
   {cancelReason !== null && <div className="notice error"><Field label="Motivo do cancelamento (a unidade volta a ficar disponível)" full><input value={cancelReason} maxLength={160} onChange={(e) => setCancelReason(e.target.value)} /></Field>
    <div className="form-actions" style={{ justifyContent: 'flex-start' }}><Button variant="outline" onClick={() => setCancelReason(null)}>Voltar</Button><Button disabled={busy || cancelReason.trim().length < 5} onClick={async () => { if (await act({ type: 'order.cancel', id: order.id, reason: cancelReason.trim() })) setCancelReason(null); }}>Confirmar cancelamento</Button></div></div>}
  </div>
 </DialogContent></Dialog>;
}

const docUrl = (id: string, download = false) => `/api/documents/${id}${download ? '?download=1' : ''}`;

/** Chama as ações de assinatura (rota própria: a resposta pode trazer o link do cliente, que não é gravado). */
async function signatureAction(contractId: string, action: 'send' | 'link' | 'refresh' | 'cancel', body?: unknown): Promise<{ ok: boolean; data: Record<string, unknown> }> {
 const r = await fetch(`/api/signature/contracts/${contractId}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
 const data = (await r.json().catch(() => ({}))) as Record<string, unknown>;
 return { ok: r.ok, data };
}

function ContractSection({ order, contracts, act, refresh, perms, busy, active }: { order: OrderView; contracts: ContractView[]; act: Act; refresh: () => Promise<unknown>; perms: Set<string>; busy: boolean; active: boolean }) {
 const [history, setHistory] = useState(false);
 const [working, setWorking] = useState(false);
 const [error, setError] = useState('');
 const [link, setLink] = useState<{ url: string; expiresAt: string | null } | null>(null);
 const [copied, setCopied] = useState(false);
 const [cancelReason, setCancelReason] = useState<string | null>(null);
 // O mais recente é o vigente (as revisões anteriores ficam no histórico).
 const current = contracts.find((c) => c.status !== 'SUPERSEDED') ?? null;
 const canGenerate = perms.has('ORDER_CREATE') && order.status !== 'CANCELLED' && (!current || REGENERABLE.includes(current.status));
 const run = async (action: 'send' | 'link' | 'refresh' | 'cancel', body?: unknown) => {
  if (!current) return;
  setWorking(true); setError(''); setCopied(false);
  try {
   const { ok, data } = await signatureAction(current.id, action, body);
   if (!ok) { setError(String(data.error ?? 'Não foi possível concluir.')); if (action === 'send') await refresh(); return; }
   if ((action === 'send' || action === 'link') && typeof data.signingUrl === 'string') setLink({ url: data.signingUrl, expiresAt: (data.signingUrlExpiresAt ?? data.expiresAt ?? null) as string | null });
   if (action === 'cancel') setCancelReason(null);
   await refresh();
  } finally { setWorking(false); }
 };
 const copy = async () => { if (!link) return; try { await navigator.clipboard.writeText(link.url); setCopied(true); } catch { setCopied(false); } };
 const templateLabel = order.type === 'VENDA' ? 'Contrato de compra e venda (moto)' : 'Contrato de locação com opção de compra';
 return <section><h3 className="section-title"><FileSignature size={16} /> Contrato</h3>
  <div className="notice" style={{ marginBottom: 8 }}>
   <div><strong>{templateLabel}</strong>{current && <> · modelo {current.templateKey} v{current.templateVersion}, revisão {current.revision}</>}</div>
   {current ? <div className="stack" style={{ gap: 6, marginTop: 6 }}>
    <div><span className={'badge ' + (CONTRACT_STATUS[current.status]?.tone ?? 'neutral')}>{CONTRACT_STATUS[current.status]?.label ?? current.status}</span></div>
    <div className="muted">Gerado por {current.generatedByName} em {date(current.generatedAt)} · referência {current.externalRef}{current.validationCode ? ` · código de validação ${current.validationCode}` : ''}</div>
    <div className="muted" style={{ wordBreak: 'break-all' }}>SHA-256 do PDF original: {current.originalSha256}</div>
    {current.sentAt && <div className="muted">Enviado por {current.sentByName} em {date(current.sentAt)} (a loja assina no envio, em nome de quem enviou)</div>}
    {current.completedAt && <div className="muted">Assinado em {date(current.completedAt)}. Conferência pública: sign.adapterco.com.br/verify{current.validationCode ? ` (código ${current.validationCode})` : ''}</div>}
    {current.lastError && current.status !== 'COMPLETED' && <div className="notice error" style={{ margin: 0 }}>{current.lastError}</div>}
   </div> : <p className="muted" style={{ marginTop: 6 }}>Nenhum contrato gerado. Confira os dados do pedido e do cliente e gere o PDF para revisar antes do envio.</p>}
   <div className="inline flex-wrap" style={{ gap: 6, marginTop: 10 }}>
    {current && <Button variant="outline" size="sm" onClick={() => window.open(docUrl(current.originalDocumentId), '_blank', 'noopener')}><Eye size={15} /> Visualizar PDF</Button>}
    {canGenerate && <Button size="sm" variant={current ? 'outline' : 'default'} disabled={busy || working || !active} onClick={() => void act({ type: 'contract.generate', orderId: order.id })}><FileSignature size={15} /> {current ? 'Gerar nova revisão' : 'Gerar contrato'}</Button>}
    {current && perms.has('ORDER_CREATE') && (current.status === 'GENERATED' || current.status === 'SENDING') && <Button size="sm" disabled={working || !active} onClick={() => void run('send')}><FileSignature size={15} /> {current.status === 'SENDING' ? 'Tentar enviar de novo' : 'Enviar para assinatura'}</Button>}
    {current?.status === 'SENT' && perms.has('ORDER_CREATE') && <Button variant="outline" size="sm" disabled={working || !active} onClick={() => void run('link')}>Gerar novo link para o cliente</Button>}
    {current && ['SENT', 'CLIENT_SIGNED', 'FINALIZING'].includes(current.status) && <Button variant="outline" size="sm" disabled={working} onClick={() => void run('refresh')}>Atualizar situação</Button>}
    {current && ['SENT', 'CLIENT_SIGNED'].includes(current.status) && perms.has('ORDER_CANCEL') && <Button variant="outline" size="sm" disabled={working || !active} onClick={() => setCancelReason('')}><X size={15} /> Cancelar assinatura</Button>}
    {current?.signedDocumentId && <Button variant="outline" size="sm" onClick={() => window.open(docUrl(current.signedDocumentId!), '_blank', 'noopener')}><Eye size={15} /> Contrato assinado</Button>}
    {current?.evidenceDocumentId && <Button variant="outline" size="sm" onClick={() => window.open(docUrl(current.evidenceDocumentId!), '_blank', 'noopener')}><Eye size={15} /> Evidências</Button>}
   </div>
   {working && <p className="muted" style={{ marginTop: 8 }}>Falando com o Adapter Sign...</p>}
   {error && <p className="notice error" style={{ marginTop: 8, marginBottom: 0 }}>{error}</p>}
   {link && <div className="stack" style={{ gap: 6, marginTop: 10 }}>
    <strong>Link de assinatura do cliente</strong>
    <div className="muted">O cliente também recebe o convite por e-mail e, com telefone cadastrado, pelo WhatsApp. Este link não fica salvo no sistema: se precisar de novo, use "Gerar novo link".{link.expiresAt ? ` Válido até ${date(Date.parse(link.expiresAt))}.` : ''}</div>
    <div className="inline" style={{ gap: 6 }}><input className="search-input" readOnly value={link.url} onFocus={(e) => e.currentTarget.select()} /><Button size="sm" variant="outline" onClick={() => void copy()}>{copied ? 'Copiado' : 'Copiar'}</Button></div>
   </div>}
   {cancelReason !== null && <div className="stack" style={{ gap: 6, marginTop: 10 }}>
    <label className="field">Motivo do cancelamento da assinatura (o envelope é cancelado no Adapter Sign e o pedido volta a poder ser alterado)<input value={cancelReason} maxLength={160} onChange={(e) => setCancelReason(e.target.value)} /></label>
    <div className="inline" style={{ gap: 6 }}><Button size="sm" variant="outline" onClick={() => setCancelReason(null)}>Voltar</Button><Button size="sm" disabled={working || cancelReason.trim().length < 5} onClick={() => void run('cancel', { reason: cancelReason.trim() })}>Confirmar cancelamento</Button></div>
   </div>}
  </div>
  {contracts.length > 1 && <button className="muted" style={{ textDecoration: 'underline', fontSize: '.8rem' }} onClick={() => setHistory(!history)}>{history ? 'Ocultar' : 'Ver'} revisões anteriores ({contracts.length - (current ? 1 : 0)})</button>}
  {history && contracts.filter((c) => c !== current).map((c) => <div key={c.id} className="note"><div className="muted">Revisão {c.revision} · {date(c.generatedAt)} · {CONTRACT_STATUS[c.status]?.label ?? c.status}</div><button className="muted" style={{ textDecoration: 'underline' }} onClick={() => window.open(docUrl(c.originalDocumentId), '_blank', 'noopener')}>Ver PDF desta revisão</button></div>)}
 </section>;
}

function DocumentsSection({ order, documents, act, refresh, perms, busy, active }: { order: OrderView; documents: DocumentView[]; act: Act; refresh: () => Promise<unknown>; perms: Set<string>; busy: boolean; active: boolean }) {
 const [description, setDescription] = useState('');
 const [file, setFile] = useState<File | null>(null);
 const [sending, setSending] = useState(false);
 const [error, setError] = useState('');
 const [inputKey, setInputKey] = useState(0);
 const upload = async (e: FormEvent) => {
  e.preventDefault();
  setError('');
  if (!file) { setError('Selecione um arquivo PDF, JPG ou PNG.'); return; }
  if (!/\.(pdf|jpe?g|png)$/i.test(file.name)) { setError('Tipo de arquivo não aceito. Envie PDF, JPG ou PNG.'); return; }
  if (file.size > 10 * 1024 * 1024) { setError('Arquivo maior que 10 MB.'); return; }
  if (description.trim().length < 3) { setError('Informe a descrição do documento.'); return; }
  setSending(true);
  try {
   const form = new FormData();
   form.set('orderId', order.id);
   form.set('description', description.trim());
   form.set('file', file);
   const r = await fetch('/api/documents', { method: 'POST', body: form });
   const d = await r.json().catch(() => ({})) as { error?: string };
   if (!r.ok) { setError(d.error ?? 'Não foi possível enviar o arquivo.'); return; }
   setDescription(''); setFile(null); setInputKey((k) => k + 1);
   await refresh();
  } finally { setSending(false); }
 };
 return <section><h3 className="section-title"><Paperclip size={16} /> Documentos</h3>
  {documents.length ? documents.map((d) => <div key={d.id} className="note split" style={{ alignItems: 'flex-start' }}>
   <div><strong>{d.description}</strong><div className="muted">{DOC_TYPE[d.type] ?? d.type}{d.source !== 'manual' ? ' · automático' : ''} · {date(d.createdAt)}{d.uploadedByName ? ` · ${d.uploadedByName}` : ''} · {(d.size / 1024).toFixed(0)} KB</div></div>
   <div className="inline" style={{ gap: 4 }}>
    <Button variant="outline" size="sm" onClick={() => window.open(docUrl(d.id), '_blank', 'noopener')}><Eye size={15} /> Ver</Button>
    <Button variant="outline" size="sm" onClick={() => window.open(docUrl(d.id, true), '_blank', 'noopener')}><Download size={15} /> Baixar</Button>
    {perms.has('DOCUMENT_DELETE') && <Button variant="outline" size="sm" disabled={busy || !active} onClick={() => void act({ type: 'document.delete', id: d.id })}><Trash2 size={15} /> Excluir</Button>}
   </div>
  </div>) : <p className="muted">Nenhum documento.</p>}
  {perms.has('ORDER_CREATE') && order.status !== 'CANCELLED' && <form className="form-grid" style={{ marginTop: 8 }} onSubmit={upload}>
   <Field label="Descrição"><input value={description} maxLength={160} placeholder="Ex.: RG do cliente" onChange={(e) => setDescription(e.target.value)} /></Field>
   <Field label="Arquivo (PDF, JPG ou PNG, até 10 MB)"><input key={inputKey} type="file" accept={ACCEPT} onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></Field>
   {error && <p className="notice error full">{error}</p>}
   <div className="full"><Button type="submit" variant="outline" disabled={sending || !active}><Paperclip size={15} /> {sending ? 'Enviando...' : 'Anexar documento'}</Button></div>
  </form>}
 </section>;
}

/** Unidades físicas (chassi/IMEI) dos produtos Moto e Locação, dentro de Produtos e estoque. */
export function UnitsPanel({ data, act, stores, storeFilter, busy, active }: { data: Snapshot; act: Act; stores: StoreRecord[]; storeFilter: string; busy: boolean; active: boolean }) {
 const perms = new Set((data.actor.permissions as unknown as string[]) ?? []);
 const products = data.state.products.filter((p) => p.kind && p.kind !== 'COMUM');
 const units = (data.state.units ?? []).filter((u) => storeFilter === 'all' || u.storeId === storeFilter);
 const [adding, setAdding] = useState(false);
 const [v, setV] = useState<Values>({});
 const [error, setError] = useState('');
 const storeName = useMemo(() => Object.fromEntries(stores.map((s) => [s.id, s.name])), [stores]);
 if (!products.length) return null;
 const product = products.find((p) => p.id === v.productId);
 const set = (k: string, value: string) => setV((p) => ({ ...p, [k]: value }));
 const submit = async (e: FormEvent) => {
  e.preventDefault();
  setError('');
  if (!v.storeId || !v.productId) { setError('Escolha a loja e o produto.'); return; }
  const ok = await act({ type: 'unit.register', storeId: v.storeId, productId: v.productId, serial: v.serial ?? '', color: v.color || undefined, memory: v.memory || undefined, condition: v.condition || undefined });
  if (ok) { setV({ storeId: v.storeId, productId: v.productId }); setAdding(false); }
 };
 return <section className="panel mt-6">
  <div className="panel-heading"><div><h2>Unidades com chassi / IMEI</h2><p>Motos e aparelhos de locação são controlados por unidade física. O saldo do estoque acompanha estas unidades.</p></div>
   {perms.has('STOCK_ADJUST') && <Button disabled={!active || busy} onClick={() => { setV({ storeId: storeFilter !== 'all' ? storeFilter : '' }); setAdding(true); }}><PackagePlus /> Cadastrar unidade</Button>}</div>
  {units.length ? <div className="table-pad"><Table><TableHeader><TableRow>{['Produto', 'Chassi / IMEI', 'Detalhes', 'Loja', 'Situação', ''].map((h) => <TableHead key={h}>{h}</TableHead>)}</TableRow></TableHeader>
   <TableBody>{units.map((u: UnitView) => <TableRow key={u.id}><TableCell>{u.productName}</TableCell><TableCell><strong>{u.serial}</strong></TableCell><TableCell>{[u.color, u.memory, u.condition].filter(Boolean).join(' · ')}</TableCell><TableCell>{storeName[u.storeId] ?? '—'}</TableCell>
    <TableCell><span className={'badge ' + (u.status === 'AVAILABLE' ? 'success' : u.status === 'RESERVED' ? 'warning' : 'neutral')}>{UNIT_STATUS[u.status] ?? u.status}</span></TableCell>
    <TableCell>{u.status === 'AVAILABLE' && perms.has('STOCK_ADJUST') && <Button variant="outline" size="sm" disabled={!active || busy} onClick={() => void act({ type: 'unit.remove', id: u.id })}><Trash2 size={15} /> Remover</Button>}</TableCell></TableRow>)}</TableBody></Table></div>
   : <div className="list-row"><span className="muted">Nenhuma unidade cadastrada.</span></div>}
  {adding && <Dialog open onOpenChange={(o) => { if (!o) setAdding(false); }}><DialogContent><DialogHeader><DialogTitle>Cadastrar unidade</DialogTitle><DialogDescription>Cada unidade entra no estoque da loja escolhida.</DialogDescription></DialogHeader>
   <form onSubmit={submit}><fieldset disabled={busy} className="form-grid">
    <Field label="Loja"><NativePick value={v.storeId ?? ''} onChange={(x) => set('storeId', x)} options={stores.map((s) => ({ value: s.id, label: s.name }))} /></Field>
    <Field label="Produto"><NativePick value={v.productId ?? ''} onChange={(x) => set('productId', x)} options={products.map((p) => ({ value: p.id, label: `${p.name} (${p.kind === 'MOTO' ? 'moto' : 'locação'})` }))} /></Field>
    <Field label={product?.kind === 'LOCACAO' ? 'IMEI (15 dígitos)' : 'Chassi / série'} full><input value={v.serial ?? ''} maxLength={40} onChange={(e) => set('serial', e.target.value)} /></Field>
    <Field label="Cor"><input value={v.color ?? ''} maxLength={80} onChange={(e) => set('color', e.target.value)} /></Field>
    {product?.kind === 'LOCACAO' && <><Field label="Memória"><input value={v.memory ?? ''} maxLength={80} placeholder="Ex.: 128 GB" onChange={(e) => set('memory', e.target.value)} /></Field>
     <Field label="Estado do aparelho" full><input value={v.condition ?? ''} maxLength={80} onChange={(e) => set('condition', e.target.value)} /></Field></>}
    {error && <p className="notice error full">{error}</p>}
   </fieldset><div className="form-actions"><Button type="button" variant="outline" onClick={() => setAdding(false)}>Cancelar</Button><Button type="submit" disabled={busy}><Check /> Cadastrar</Button></div></form>
  </DialogContent></Dialog>}
 </section>;
}

/**
 * Assinatura eletrônica (Adapter Sign) da loja: API key e segredo do webhook (cifrados no servidor,
 * nunca exibidos de volta), identificadores dos modelos no Adapter Sign e a URL do webhook.
 */
export function SignatureConfigDialog({ data, store, act, busy, onClose }: { data: Snapshot; store: StoreRecord; act: Act; busy: boolean; onClose: () => void }) {
 const summary = data.state.signatureConfigs?.[store.id];
 const [motoInitials,setMotoInitials]=useState(summary?.motoInitials??false);
 const [locacaoInitials,setLocacaoInitials]=useState(summary?.locacaoInitials??false);
 const [v, setV] = useState<Values>({ apiKey: '', webhookSecret: '', motoTemplate: summary?.motoTemplate ?? '', locacaoTemplate: summary?.locacaoTemplate ?? '' });
 const [copied, setCopied] = useState(false);
 const set = (k: string, value: string) => setV((p) => ({ ...p, [k]: value }));
 const webhookUrl = summary?.webhookPath ? `${typeof window === 'undefined' ? '' : window.location.origin}${summary.webhookPath}` : '';
 const usesSale = store.modalities?.includes('VENDA_CONTRATO');
 const usesRent = store.modalities?.includes('LOCACAO');
 const submit = async (e: FormEvent) => {
  e.preventDefault();
  const ok = await act({ type: 'signature.config.save', storeId: store.id, apiKey: v.apiKey.trim() || undefined, webhookSecret: v.webhookSecret.trim() || undefined, motoTemplate: v.motoTemplate.trim(), locacaoTemplate: v.locacaoTemplate.trim(),motoInitials,locacaoInitials });
  if (ok) set('apiKey', ''), set('webhookSecret', '');
 };
 return <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}><DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto"><DialogHeader><DialogTitle>Assinatura eletrônica · {store.name}</DialogTitle><DialogDescription>Integração com o Adapter Sign. Cada loja usa a organização dela no Adapter Sign (plano, modelos, API key e webhook próprios).</DialogDescription></DialogHeader>
  <form onSubmit={submit}><fieldset disabled={busy} className="form-grid">
   <div className="full inline flex-wrap" style={{ gap: 6 }}>
    <span className={'badge ' + (summary?.configured ? 'success' : 'neutral')}>{summary?.configured ? 'API key salva' : 'Sem API key'}</span>
    <span className={'badge ' + (summary?.hasWebhookSecret ? 'success' : 'warning')}>{summary?.hasWebhookSecret ? 'Segredo do webhook salvo' : 'Sem segredo do webhook'}</span>
   </div>
   <Field label={summary?.configured ? 'API key (deixe em branco para manter a salva)' : 'API key do Adapter Sign'} full hint="Adapter Sign → Configurações → API keys. Ela aparece uma única vez lá."><input type="password" autoComplete="off" value={v.apiKey} onChange={(e) => set('apiKey', e.target.value)} /></Field>
   <Field label={summary?.hasWebhookSecret ? 'Segredo do webhook (em branco mantém o salvo)' : 'Segredo do webhook (whsec_...)'} full hint="Adapter Sign → Configurações → Webhooks, ao cadastrar a URL abaixo."><input type="password" autoComplete="off" value={v.webhookSecret} onChange={(e) => set('webhookSecret', e.target.value)} /></Field>
   {usesSale && <Field label="Identificador do modelo de venda (moto) no Adapter Sign" hint="Ex.: o identificador que você criou em Modelos (papéis loja e cliente)."><input value={v.motoTemplate} maxLength={60} onChange={(e) => set('motoTemplate', e.target.value)} /></Field>}
   {usesRent && <Field label="Identificador do modelo de locação no Adapter Sign"><input value={v.locacaoTemplate} maxLength={60} onChange={(e) => set('locacaoTemplate', e.target.value)} /></Field>}
   {usesSale&&<label><input type="checkbox" checked={motoInitials} onChange={e=>setMotoInitials(e.target.checked)}/> Rubrica do cliente em cada página — moto</label>}
   {usesRent&&<label><input type="checkbox" checked={locacaoInitials} onChange={e=>setLocacaoInitials(e.target.checked)}/> Rubrica do cliente em cada página — locação</label>}
   <p className="muted full">Rubricas valem para novos PDFs. Documentos existentes permanecem inalterados; confira os campos no teste de modelo do Adapter Sign.</p>
   {!usesSale && !usesRent && <p className="notice full">Esta loja não tem as modalidades Venda com contrato ou Locação: não há contratos para assinar.</p>}
   {webhookUrl && <div className="field full">URL do webhook (cadastre no Adapter Sign com os eventos signer.signed, signer.declined, envelope.completed, envelope.expired e envelope.cancelled)
    <div className="inline" style={{ gap: 6 }}><input className="search-input" readOnly value={webhookUrl} onFocus={(e) => e.currentTarget.select()} /><Button type="button" size="sm" variant="outline" onClick={async () => { try { await navigator.clipboard.writeText(webhookUrl); setCopied(true); } catch { setCopied(false); } }}>{copied ? 'Copiado' : 'Copiar'}</Button></div></div>}
   {!webhookUrl && <p className="muted full">A URL do webhook aparece depois de salvar a API key.</p>}
   <p className="muted full">Antes do primeiro envio, o proprietário da conta no Adapter Sign precisa aceitar a autorização em Configurações → Assinatura da empresa. Sem ela, o envio é recusado com explicação.</p>
  </fieldset>
  <div className="form-actions"><Button type="button" variant="outline" onClick={onClose}>Fechar</Button><Button type="submit" disabled={busy}><Check /> Salvar</Button></div>
  </form></DialogContent></Dialog>;
}
