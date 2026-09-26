'use client';
import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { Plus, X, Check, Pencil, MessageSquare, Trash2, PackagePlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Table, TableHeader, TableHead, TableBody, TableRow, TableCell } from '@/components/ui/table';
import { money, date, type Snapshot, type OrderView, type UnitView, type StoreRecord } from '@/lib/domain';

// Aba Pedidos (venda com contrato de moto e locação) e painel de unidades com chassi/IMEI.
// Toda regra fica no backend (lib/orders/service.ts); a tela só coleta e mostra os dados.

type Act = (command: unknown) => Promise<unknown>;
type Values = Record<string, string>;

const STORE_METHODS = ['Dinheiro', 'Pix', 'Cartão'];
const ORDER_STATUS: Record<string, { label: string; tone: string }> = {
 OPEN: { label: 'Em aberto (unidade reservada)', tone: 'warning' },
 COMPLETING: { label: 'Finalizando...', tone: 'warning' },
 COMPLETED: { label: 'Finalizado', tone: 'success' },
 CANCELLED: { label: 'Cancelado', tone: 'error' },
};
const UNIT_STATUS: Record<string, string> = { AVAILABLE: 'Disponível', RESERVED: 'Reservada', SOLD: 'Vendida', RENTED: 'Locada' };

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

export function OrdersPage({ data, act, stores, storeFilter, busy, active }: { data: Snapshot; act: Act; stores: StoreRecord[]; storeFilter: string; busy: boolean; active: boolean }) {
 const perms = new Set((data.actor.permissions as unknown as string[]) ?? []);
 const orders = (data.state.orders ?? []).filter((o) => storeFilter === 'all' || o.storeId === storeFilter);
 const [search, setSearch] = useState('');
 const [editing, setEditing] = useState<OrderView | 'new' | null>(null);
 const [viewing, setViewing] = useState<string | null>(null);
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
  {current && !editing && <OrderDetail order={current} act={act} perms={perms} busy={busy} active={active} onClose={() => setViewing(null)} onEdit={() => setEditing(current)} />}
 </>;
}

function OrderForm({ data, act, stores, order, busy, onClose, onSaved }: { data: Snapshot; act: Act; stores: StoreRecord[]; order: OrderView | null; busy: boolean; onClose: () => void; onSaved: (id?: string) => void }) {
 const [v, setV] = useState<Values>((): Values => order ? {
  storeId: order.storeId, type: order.type, customerId: order.customerId, unitId: order.unitId,
  total: fromCents(order.total), purchaseDate: order.purchaseDate, downPayment: fromCents(order.downPayment), downPaymentMethod: order.downPaymentMethod,
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
   Object.assign(terms, { total: toCents(v.total), purchaseDate: v.purchaseDate, installments, downPayment: installments === 0 ? toCents(v.total) : toCents(v.downPayment || '0'), downPaymentMethod: v.downPaymentMethod || undefined });
   if (installments > 0) terms.firstDueDate = v.firstDueDate;
  } else {
   Object.assign(terms, { adhesionAmount: toCents(v.adhesionAmount), monthlyAmount: toCents(v.monthlyAmount), dueDay: Number(v.dueDay), adhesionBilling: v.adhesionBilling || undefined, adhesionPaymentMethod: v.adhesionBilling === 'LOJA' ? v.adhesionPaymentMethod || undefined : undefined });
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
    <Field label="Parcelas no boleto" hint="0 = pagamento total na loja."><input type="number" min={0} max={60} value={v.installments ?? '0'} onChange={(e) => set('installments', e.target.value)} /></Field>
    {installments > 0 ? <Field label="Entrada recebida na loja (R$)" hint="0 se não houver entrada."><input inputMode="decimal" value={v.downPayment ?? ''} onChange={(e) => set('downPayment', e.target.value)} /></Field> : <div />}
    {(installments === 0 || toCents(v.downPayment || '0') > 0) && <Field label={installments === 0 ? 'Forma de pagamento na loja' : 'Forma da entrada'}><NativePick value={v.downPaymentMethod ?? ''} onChange={(x) => set('downPaymentMethod', x)} options={STORE_METHODS.map((m) => ({ value: m, label: m }))} /></Field>}
    {installments > 0 && <Field label="1º vencimento do boleto"><input type="date" value={v.firstDueDate ?? ''} onChange={(e) => set('firstDueDate', e.target.value)} /></Field>}
    {installments > 0 && Number.isFinite(financed) && financed > 0 && <p className="muted full">Financiado no boleto: {money(financed)} em {installments} parcela(s). Os boletos são gerados pelo Asaas na etapa de cobrança.</p>}
   </>}
   {type === 'LOCACAO' && <>
    <Field label="Valor da adesão (R$)"><input inputMode="decimal" value={v.adhesionAmount ?? ''} onChange={(e) => set('adhesionAmount', e.target.value)} /></Field>
    <Field label="Cobrança da adesão"><NativePick value={v.adhesionBilling ?? ''} onChange={(x) => set('adhesionBilling', x)} options={[{ value: 'BOLETO', label: 'Boleto (Asaas)' }, { value: 'LOJA', label: 'Paga na loja' }]} /></Field>
    {v.adhesionBilling === 'LOJA' && <Field label="Forma de pagamento da adesão"><NativePick value={v.adhesionPaymentMethod ?? ''} onChange={(x) => set('adhesionPaymentMethod', x)} options={STORE_METHODS.map((m) => ({ value: m, label: m }))} /></Field>}
    <Field label="Mensalidade (R$)"><input inputMode="decimal" value={v.monthlyAmount ?? ''} onChange={(e) => set('monthlyAmount', e.target.value)} /></Field>
    <Field label="Dia de vencimento (1 a 28)"><input type="number" min={1} max={28} value={v.dueDay ?? ''} onChange={(e) => set('dueDay', e.target.value)} /></Field>
    <p className="muted full">Contrato de locação v1: 12 mensalidades, geradas todas de uma vez no boleto na etapa de cobrança.</p>
   </>}
   {error && <p className="notice error full">{error}</p>}
  </fieldset>
  <div className="form-actions"><Button type="button" variant="outline" onClick={onClose}>Cancelar</Button><Button type="submit" disabled={busy}><Check /> {order ? 'Salvar alterações' : 'Criar pedido e reservar'}</Button></div>
  </form></DialogContent></Dialog>;
}

function OrderDetail({ order, act, perms, busy, active, onClose, onEdit }: { order: OrderView; act: Act; perms: Set<string>; busy: boolean; active: boolean; onClose: () => void; onEdit: () => void }) {
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
   ['Pagamento', order.installments ? `Entrada ${money(order.downPayment)}${order.downPaymentMethod ? ` (${order.downPaymentMethod})` : ''} + ${order.installments}x no boleto, 1º vencimento ${brDate(order.firstDueDate)}` : `À vista na loja (${order.downPaymentMethod})`],
  ] as [string, ReactNode][] : [
   ['Adesão', `${money(order.adhesionAmount)} · ${order.adhesionBilling === 'BOLETO' ? 'boleto' : `na loja (${order.adhesionPaymentMethod})`}`],
   ['Mensalidades', `12x ${money(order.monthlyAmount)}, todo dia ${order.dueDay}`],
  ] as [string, ReactNode][]),
  ['Criado em', date(order.createdAt)],
  ...(order.completedAt ? [['Finalizado em', date(order.completedAt)]] as [string, ReactNode][] : []),
  ...(order.cancelledAt ? [['Cancelado em', `${date(order.cancelledAt)} · ${order.cancelReason}`]] as [string, ReactNode][] : []),
 ];
 return <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}><DialogContent className="sm:max-w-3xl max-h-[90vh] overflow-y-auto"><DialogHeader><DialogTitle>Pedido #{order.number} · {order.type === 'VENDA' ? 'Venda com contrato (moto)' : 'Locação'}</DialogTitle><DialogDescription><span className={'badge ' + (ORDER_STATUS[order.status]?.tone ?? 'neutral')}>{ORDER_STATUS[order.status]?.label ?? order.status}</span></DialogDescription></DialogHeader>
  <div className="stack">
   <div className="order-summary">{rows.map(([k, val]) => <div key={k}><span className="muted">{k}</span><strong>{val}</strong></div>)}</div>
   <div className="notice">Contrato: a geração do PDF e o envio para assinatura (Adapter Sign) entram na próxima etapa. Nenhum contrato foi gerado ainda.</div>
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
   {confirmComplete && <div className="notice"><p>{order.type === 'VENDA' ? `Finalizar gera a venda no SEU caixa aberto: ${order.downPayment ? `${money(order.downPayment)} recebidos agora (${order.downPaymentMethod})` : 'sem valor recebido agora'}${order.installments ? ` + ${money(order.total - order.downPayment)} no boleto` : ''}. A unidade sai do estoque. A nota fiscal pode ser emitida depois na aba Vendas.` : `Finalizar entrega o aparelho ao cliente (sai do estoque como locado)${order.adhesionBilling === 'LOJA' ? ` e registra a adesão de ${money(order.adhesionAmount)} recebida na loja (${order.adhesionPaymentMethod})` : ''}.`}</p>
    <div className="form-actions" style={{ justifyContent: 'flex-start' }}><Button variant="outline" onClick={() => setConfirmComplete(false)}>Voltar</Button><Button disabled={busy} onClick={async () => { if (await act({ type: 'order.complete', id: order.id })) setConfirmComplete(false); }}>Confirmar finalização</Button></div></div>}
   {cancelReason !== null && <div className="notice error"><Field label="Motivo do cancelamento (a unidade volta a ficar disponível)" full><input value={cancelReason} maxLength={160} onChange={(e) => setCancelReason(e.target.value)} /></Field>
    <div className="form-actions" style={{ justifyContent: 'flex-start' }}><Button variant="outline" onClick={() => setCancelReason(null)}>Voltar</Button><Button disabled={busy || cancelReason.trim().length < 5} onClick={async () => { if (await act({ type: 'order.cancel', id: order.id, reason: cancelReason.trim() })) setCancelReason(null); }}>Confirmar cancelamento</Button></div></div>}
  </div>
 </DialogContent></Dialog>;
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
