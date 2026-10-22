'use client';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { ClipboardCheck, LoaderCircle, RefreshCw } from 'lucide-react';
import type { StoreRecord, OrderView } from '@/lib/domain';
import type { ContractField } from '@/lib/contracts/fields';

// Checklist de entrega: a loja monta os itens uma vez (Minhas lojas > Checklist de entrega); na
// entrega, dentro do pedido, o vendedor só marca os itens — cliente, produto, chassi/IMEI e
// garantia vêm do pedido. Regras no servidor (lib/checklists/service.ts).

type Template = { orderType: 'VENDA' | 'LOCACAO'; title: string; items: string; sections: { title: string; items: string[] }[]; declaration: string; signTemplateKey: string; signCompanyRole: string; signClientRole: string; updatedByName: string; updatedAt: number };
type SignOption = { key: string; name: string; roles: { key: string; label: string; isCompany: boolean }[]; companyRole: string | null; clientRole: string | null; problem: string | null };

async function api(url: string, init?: RequestInit) {
 try {
  const r = await fetch(url, { cache: 'no-store', ...init });
  return { ok: r.ok, data: (await r.json().catch(() => ({}))) as Record<string, unknown> };
 } catch { return { ok: false, data: { error: 'Falha de comunicação. Tente novamente.' } as Record<string, unknown> }; }
}

// Ponto de partida editável (itens do checklist de entrega de scooter que motivou a função).
const EXAMPLE_ITEMS = '# VISUALIZAÇÃO EXTERNA\nCarenagem completa\nParalama\nPainel\nFarol\nSetas\n\n# ACOMPANHA\n1 carregador\n2 jogos de chaves\n\n# TESTE\nLiga e desliga\nFreio';
const TYPE_LABEL = { VENDA: 'Venda (moto)', LOCACAO: 'Locação' } as const;

export function ChecklistTemplateDialog({ store, onClose }: { store: StoreRecord; onClose: () => void }) {
 const types = (['VENDA', 'LOCACAO'] as const).filter((t) => store.modalities?.includes(t === 'VENDA' ? 'VENDA_CONTRATO' : 'LOCACAO'));
 const [type, setType] = useState<'VENDA' | 'LOCACAO'>(types[0] ?? 'VENDA');
 const [templates, setTemplates] = useState<Template[] | null>(null), [fields, setFields] = useState<ContractField[]>([]);
 const [form, setForm] = useState({ title: '', items: '', declaration: '', signTemplateKey: '', signCompanyRole: '', signClientRole: '' });
 const [signOptions, setSignOptions] = useState<SignOption[] | null>(null);
 const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
 const fill = (list: Template[], t: 'VENDA' | 'LOCACAO') => {
  const cur = list.find((x) => x.orderType === t);
  setForm(cur ? { title: cur.title, items: cur.items, declaration: cur.declaration, signTemplateKey: cur.signTemplateKey, signCompanyRole: cur.signCompanyRole, signClientRole: cur.signClientRole }
   : { title: 'DOCUMENTO DE ENTREGA', items: '', declaration: '', signTemplateKey: '', signCompanyRole: '', signClientRole: '' });
 };
 const load = async (t = type) => {
  const r = await api(`/api/checklists/templates?storeId=${encodeURIComponent(store.id)}`);
  if (!r.ok) { setError(String(r.data.error ?? 'Não foi possível carregar.')); setTemplates([]); return; }
  const list = r.data.templates as Template[];
  setTemplates(list); setFields(r.data.fields as ContractField[]); fill(list, t);
 };
 useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
 const save = async () => {
  setBusy(true); setError(''); setNotice('');
  const r = await api('/api/checklists/templates', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ storeId: store.id, orderType: type, ...form }) });
  setBusy(false);
  if (!r.ok) { setError(String(r.data.error ?? 'Não foi possível salvar.')); return; }
  setNotice('Checklist salvo. Ele aparece em cada pedido deste tipo, na seção "Checklist de entrega".'); void load();
 };
 const loadSign = async () => {
  setBusy(true); setError('');
  const r = await api(`/api/signature/stores/${store.id}/templates?for=checklist`);
  setBusy(false);
  if (!r.ok) { setError(String(r.data.error ?? 'Não foi possível buscar os modelos.')); return; }
  setSignOptions(r.data.templates as SignOption[]);
 };
 const typeFields = fields.filter((f) => f.types.includes(type));
 const current = templates?.find((x) => x.orderType === type);
 return <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}><DialogContent className="sm:max-w-3xl max-h-[92vh] overflow-y-auto">
  <DialogHeader><DialogTitle>Checklist de entrega · {store.name}</DialogTitle>
   <DialogDescription>Os itens conferidos na entrega. Em cada pedido, o vendedor só marca o que foi conferido; cliente, produto e chassi/IMEI vêm do pedido. O cliente assina à parte, na entrega.</DialogDescription></DialogHeader>
  {error && <div className="notice error" role="alert">{error}</div>}
  {notice && <div className="notice">{notice}</div>}
  {!types.length ? <p className="muted">Esta loja não tem Venda com contrato nem Locação habilitadas.</p> : !templates ? <p className="muted"><LoaderCircle className="inline animate-spin" size={14} /> Carregando...</p> : <div className="stack">
   {types.length > 1 && <div className="inline" style={{ gap: 8 }}>{types.map((t) => <Button key={t} size="sm" variant={t === type ? 'default' : 'outline'} onClick={() => { setType(t); fill(templates, t); setNotice(''); setError(''); }}>{TYPE_LABEL[t]}</Button>)}</div>}
   <p className="muted" style={{ margin: 0 }}>{current ? `Última alteração por ${current.updatedByName} em ${new Date(current.updatedAt).toLocaleString('pt-BR')}.` : 'Ainda não montado para este tipo.'}</p>
   <label className="field">Título<input value={form.title} maxLength={120} onChange={(e) => setForm({ ...form, title: e.target.value })} /></label>
   <label className="field">Itens (um por linha; comece a linha com # para criar uma seção)
    <textarea rows={14} value={form.items} placeholder={EXAMPLE_ITEMS} onChange={(e) => setForm({ ...form, items: e.target.value })} style={{ fontSize: 13, lineHeight: 1.5 }} />
   </label>
   {!form.items && <div><Button type="button" size="sm" variant="outline" onClick={() => setForm({ ...form, items: EXAMPLE_ITEMS })}>Começar pelo exemplo</Button></div>}
   <label className="field">Declaração do cliente (opcional; pode usar campos do pedido, ex.: {'{{cliente.nome}}'}, {'{{cliente.cpf}}'})
    <textarea rows={5} value={form.declaration} onChange={(e) => setForm({ ...form, declaration: e.target.value })} placeholder="Eu, {{cliente.nome}}, CPF {{cliente.cpf}}, declaro que recebi o produto nas condições acima..." />
   </label>
   <details><summary className="muted" style={{ cursor: 'pointer' }}>Campos disponíveis na declaração</summary>
    <p className="muted" style={{ margin: '6px 0 0' }}>{typeFields.map((f) => `{{${f.key}}} = ${f.label}`).join(' · ')} · {'{{checklist.observacoes}}'} = observações da entrega</p>
   </details>
   <section className="stack" style={{ gap: 8 }}>
    <strong>Assinatura (Adapter Sign)</strong>
    <p className="muted" style={{ margin: 0 }}>Modelo de assinatura do checklist, criado no Adapter Sign. Pode ser assinado só pelo cliente.</p>
    <div className="inline flex-wrap" style={{ gap: 8 }}>
     {signOptions ? <select value={form.signTemplateKey} aria-label="Modelo de assinatura" onChange={(e) => { const o = signOptions.find((x) => x.key === e.target.value); setForm({ ...form, signTemplateKey: o?.key ?? '', signCompanyRole: o?.companyRole ?? '', signClientRole: o?.clientRole ?? '' }); }}>
      <option value="">Escolha o modelo</option>
      {signOptions.map((o) => <option key={o.key} value={o.key} disabled={!!o.problem}>{o.name} ({o.key}){o.problem ? ` — ${o.problem}` : ''}</option>)}
     </select> : form.signTemplateKey ? <span>Escolhido: <strong>{form.signTemplateKey}</strong></span> : <span className="muted">Nenhum escolhido (sem ele, o checklist é gerado mas não pode ser enviado para assinatura).</span>}
     <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void loadSign()}><RefreshCw size={14} /> {signOptions ? 'Atualizar lista' : 'Buscar modelos do Adapter Sign'}</Button>
    </div>
   </section>
   <div className="form-actions" style={{ marginTop: 0 }}><Button disabled={busy} onClick={() => void save()}>{busy ? <LoaderCircle className="animate-spin" size={15} /> : <ClipboardCheck size={15} />} Salvar checklist</Button></div>
  </div>}
 </DialogContent></Dialog>;
}

/** Marcação dos itens na entrega (dentro do pedido) e geração do PDF do checklist. */
export function ChecklistForm({ order, onGenerated, disabled }: { order: OrderView; onGenerated: () => Promise<unknown>; disabled: boolean }) {
 const [template, setTemplate] = useState<Template | null | undefined>(undefined);
 const [checked, setChecked] = useState<Set<string>>(new Set()), [observations, setObservations] = useState('');
 const [busy, setBusy] = useState(false), [error, setError] = useState('');
 useEffect(() => { void api(`/api/checklists/orders/${order.id}`).then((r) => { if (!r.ok) { setError(String(r.data.error ?? 'Não foi possível carregar o checklist.')); setTemplate(null); return; } setTemplate((r.data.template as Template | null) ?? null); }); }, [order.id]);
 if (template === undefined) return <p className="muted"><LoaderCircle className="inline animate-spin" size={14} /> Carregando checklist...</p>;
 if (!template) return <p className="muted">{error || 'Esta loja ainda não tem checklist de entrega. O administrador monta em Minhas lojas > Checklist de entrega.'}</p>;
 const toggle = (key: string) => setChecked((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; });
 const generate = async () => {
  setBusy(true); setError('');
  const r = await api(`/api/checklists/orders/${order.id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ checked: [...checked], observations, templateUpdatedAt: template.updatedAt }) });
  setBusy(false);
  if (!r.ok) { setError(String(r.data.error ?? 'Não foi possível gerar o checklist.')); return; }
  setChecked(new Set()); setObservations(''); await onGenerated();
 };
 return <div className="stack" style={{ gap: 8, marginTop: 8 }}>
  <p className="muted" style={{ margin: 0 }}>Marque o que foi conferido na entrega. Cliente, produto, {order.type === 'VENDA' ? 'chassi' : 'IMEI'} e garantia saem do pedido.</p>
  {template.sections.map((s, si) => <fieldset key={si} className="panel" style={{ padding: '10px 14px' }}>
   {s.title && <legend className="muted" style={{ fontWeight: 600, padding: '0 4px' }}>{s.title}</legend>}
   <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '4px 12px' }}>
    {s.items.map((label, ii) => { const key = `${si}:${ii}`; return <label key={key} className="inline" style={{ gap: 8, fontSize: '.9rem' }}><input type="checkbox" checked={checked.has(key)} onChange={() => toggle(key)} /> {label}</label>; })}
   </div>
  </fieldset>)}
  <label className="field">Observações da entrega<textarea rows={2} maxLength={2000} value={observations} onChange={(e) => setObservations(e.target.value)} placeholder="Sem observações." /></label>
  {error && <p className="notice error" style={{ margin: 0 }}>{error}</p>}
  <div><Button size="sm" disabled={busy || disabled} onClick={() => void generate()}>{busy ? <LoaderCircle className="animate-spin" size={15} /> : <ClipboardCheck size={15} />} Gerar checklist ({checked.size} {checked.size === 1 ? 'item marcado' : 'itens marcados'})</Button></div>
 </div>;
}
