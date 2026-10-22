'use client';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Eye, FileUp, LoaderCircle, Plus, RefreshCw, Send } from 'lucide-react';
import type { StoreRecord } from '@/lib/domain';
import type { ContractField } from '@/lib/contracts/fields';

// Modelos de contrato da loja: o lojista importa o PDF que já usa, revisa o texto, marca os campos
// (seleciona o dado do cliente de exemplo e escolhe o campo), define as condições e o modelo de
// assinatura do Adapter Sign, confere a pré-visualização e publica. Regras no servidor
// (lib/contracts/models.ts); esta tela só edita e envia.

type Model = {
 id: string; storeId: string; orderType: 'VENDA' | 'LOCACAO'; name: string; version: number; status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
 title: string; headerText: string; body: string; footerText: string; hasLogo: boolean;
 warrantyDays: number | null; fineBp: number | null; interestBp: number | null; residualCents: number | null;
 signTemplateKey: string; signCompanyRole: string; signClientRole: string; clientInitials: boolean; sourceFilename: string;
 createdByName: string; updatedAt: number; publishedAt: number | null; publishedByName: string | null;
};
type SignOption = { key: string; name: string; description: string; roles: { key: string; label: string; isCompany: boolean }[]; companyRole: string | null; clientRole: string | null; problem: string | null };
type Form = { id: string; orderType: 'VENDA' | 'LOCACAO'; name: string; title: string; headerText: string; body: string; footerText: string; warranty: string; fine: string; interest: string; residual: string; signTemplateKey: string; signCompanyRole: string; signClientRole: string; clientInitials: boolean; hasLogo: boolean; sourceFilename: string };

const TYPE_LABEL = { VENDA: 'Venda (moto)', LOCACAO: 'Locação' } as const;
const STATUS: Record<Model['status'], { label: string; tone: string }> = { DRAFT: { label: 'Rascunho', tone: 'warning' }, PUBLISHED: { label: 'Em uso', tone: 'success' }, ARCHIVED: { label: 'Arquivado', tone: 'neutral' } };
const toDecimal = (v: number | null, div: number) => (v == null ? '' : String(v / div).replace('.', ','));
/** "2", "2,5", "19,90" → número inteiro em centésimos (bp ou centavos). Vazio = null; inválido = NaN. */
const fromDecimal = (s: string) => { const t = s.trim(); if (!t) return null; if (!/^\d+(?:[,.]\d{1,2})?$/.test(t)) return NaN; const [a, b = ''] = t.replace(',', '.').split('.'); return Number(a) * 100 + Number(b.padEnd(2, '0')); };

function toForm(m: Model): Form {
 return { id: m.id, orderType: m.orderType, name: m.name, title: m.title, headerText: m.headerText, body: m.body, footerText: m.footerText, warranty: m.warrantyDays == null ? '' : String(m.warrantyDays), fine: toDecimal(m.fineBp, 100), interest: toDecimal(m.interestBp, 100), residual: toDecimal(m.residualCents, 100), signTemplateKey: m.signTemplateKey, signCompanyRole: m.signCompanyRole, signClientRole: m.signClientRole, clientInitials: m.clientInitials, hasLogo: m.hasLogo, sourceFilename: m.sourceFilename };
}

async function api(url: string, init?: RequestInit): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
 try {
  const r = await fetch(url, { cache: 'no-store', ...init });
  const data = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: r.ok, status: r.status, data };
 } catch { return { ok: false, status: 0, data: { error: 'Falha de comunicação. Tente novamente.' } }; }
}

export function ContractModelsDialog({ store, onClose }: { store: StoreRecord; onClose: () => void }) {
 const [models, setModels] = useState<Model[] | null>(null), [fields, setFields] = useState<ContractField[]>([]);
 const [form, setForm] = useState<Form | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
 const [warnings, setWarnings] = useState<string[]>([]), [confirmData, setConfirmData] = useState(''), [importType, setImportType] = useState<'VENDA' | 'LOCACAO' | ''>('');
 const [signOptions, setSignOptions] = useState<SignOption[] | null>(null), [field, setField] = useState(''), [allOccurrences, setAllOccurrences] = useState(true);
 const bodyRef = useRef<HTMLTextAreaElement>(null), pdfRef = useRef<HTMLInputElement>(null), logoRef = useRef<HTMLInputElement>(null);

 const load = async () => {
  const r = await api(`/api/contract-models?storeId=${encodeURIComponent(store.id)}`);
  if (!r.ok) { setError(String(r.data.error ?? 'Não foi possível carregar os modelos.')); setModels([]); return; }
  setModels(r.data.models as Model[]); setFields(r.data.fields as ContractField[]);
 };
 useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

 const post = async (body: Record<string, unknown>) => api('/api/contract-models', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
 const payload = (f: Form) => {
  const fineBp = fromDecimal(f.fine), interestBp = fromDecimal(f.interest), residualCents = fromDecimal(f.residual);
  if ([fineBp, interestBp, residualCents].some((v) => Number.isNaN(v))) throw new Error('Confira multa, juros e valor residual (use números, ex.: 2 ou 19,90).');
  if (f.warranty && !/^\d{1,4}$/.test(f.warranty)) throw new Error('Prazo de garantia: informe só o número de dias.');
  return { id: f.id || undefined, storeId: store.id, orderType: f.orderType, name: f.name, title: f.title, headerText: f.headerText, body: f.body, footerText: f.footerText, warrantyDays: f.warranty ? Number(f.warranty) : null, fineBp, interestBp, residualCents, signTemplateKey: f.signTemplateKey, signCompanyRole: f.signCompanyRole, signClientRole: f.signClientRole, clientInitials: f.clientInitials, sourceFilename: f.sourceFilename };
 };
 /** Salva o rascunho e devolve o id (ou null se falhou). */
 const save = async (f: Form, quiet = false): Promise<string | null> => {
  setError('');
  let body;
  try { body = payload(f); } catch (e) { setError((e as Error).message); return null; }
  const r = await post({ action: 'save', ...body });
  if (!r.ok) { setError(String(r.data.error ?? 'Não foi possível salvar.')); return null; }
  const id = String(r.data.id);
  setForm({ ...f, id });
  if (!quiet) setNotice('Rascunho salvo.');
  void load();
  return id;
 };
 const run = async (fn: () => Promise<void>) => { setBusy(true); setNotice(''); try { await fn(); } finally { setBusy(false); } };

 const importPdf = (file: File) => run(async () => {
  if (!importType) { setError('Escolha antes se o contrato é de venda ou de locação.'); return; }
  setError(''); setWarnings([]);
  const fd = new FormData(); fd.append('file', file);
  const r = await api('/api/contract-models/extract', { method: 'POST', body: fd });
  if (!r.ok) { setError(String(r.data.error ?? 'Não foi possível ler o PDF.')); return; }
  const d = r.data as { title: string; headerText: string; body: string; footerText: string; warnings: string[]; sourceFilename: string };
  const draft: Form = { id: '', orderType: importType, name: d.title ? d.title.slice(0, 80) : `Contrato de ${importType === 'VENDA' ? 'venda' : 'locação'}`, title: d.title, headerText: d.headerText, body: d.body, footerText: d.footerText, warranty: '', fine: '', interest: '', residual: '', signTemplateKey: '', signCompanyRole: '', signClientRole: '', clientInitials: false, hasLogo: false, sourceFilename: d.sourceFilename };
  setWarnings(d.warnings ?? []);
  if (await save(draft, true)) setNotice('Texto importado e salvo como rascunho. Agora troque os dados do cliente de exemplo pelos campos.');
 });
 const newBlank = (orderType: 'VENDA' | 'LOCACAO') => run(async () => {
  setWarnings([]);
  await save({ id: '', orderType, name: `Contrato de ${orderType === 'VENDA' ? 'venda' : 'locação'}`, title: '', headerText: '', body: '', footerText: 'Documento gerado em {{pedido.data_hora_geracao}}', warranty: '', fine: '', interest: '', residual: '', signTemplateKey: '', signCompanyRole: '', signClientRole: '', clientInitials: false, hasLogo: false, sourceFilename: '' }, true);
 });
 const preview = (f: Form) => run(async () => {
  const id = await save(f, true);
  if (id) window.open(`/api/contract-models/${id}/preview`, '_blank', 'noopener,noreferrer');
 });
 const publish = (f: Form, confirmFixedData = false) => run(async () => {
  const id = await save(f, true);
  if (!id) return;
  const r = await post({ action: 'publish', id, confirmFixedData });
  if (r.status === 428) { setConfirmData(String(r.data.error ?? '')); return; }
  if (!r.ok) { setError(String(r.data.error ?? 'Não foi possível publicar.')); return; }
  setConfirmData(''); setForm(null); setWarnings([]); setNotice('Modelo publicado. Os próximos contratos desta loja usam esta versão; os já gerados não mudam.'); void load();
 });
 const action = (body: Record<string, unknown>, done: string) => run(async () => {
  const r = await post(body);
  if (!r.ok) { setError(String(r.data.error ?? 'Não foi possível concluir.')); return; }
  setNotice(done); await load();
  if (body.action === 'newVersion' && r.data.id) {
   const fresh = await api(`/api/contract-models?storeId=${encodeURIComponent(store.id)}`);
   const m = (fresh.data.models as Model[] | undefined)?.find((x) => x.id === r.data.id);
   if (m) setForm(toForm(m));
  }
 });
 const uploadLogo = (file: File) => run(async () => {
  if (!form) return;
  const id = await save(form, true);
  if (!id) return;
  const fd = new FormData(); fd.append('file', file);
  const r = await api(`/api/contract-models/${id}/logo`, { method: 'POST', body: fd });
  if (!r.ok) { setError(String(r.data.error ?? 'Não foi possível enviar o logo.')); return; }
  setForm((f) => (f ? { ...f, id, hasLogo: true } : f)); setNotice('Logo enviado.');
 });
 const removeLogo = () => run(async () => {
  if (!form?.id) return;
  const r = await api(`/api/contract-models/${form.id}/logo`, { method: 'DELETE' });
  if (!r.ok) { setError(String(r.data.error ?? 'Não foi possível remover o logo.')); return; }
  setForm((f) => (f ? { ...f, hasLogo: false } : f));
 });
 const loadSignOptions = () => run(async () => {
  setError('');
  const r = await api(`/api/signature/stores/${store.id}/templates`);
  if (!r.ok) { setError(String(r.data.error ?? 'Não foi possível buscar os modelos do Adapter Sign.')); return; }
  setSignOptions(r.data.templates as SignOption[]);
 });

 /** Troca o texto selecionado no corpo (e, se marcado, todas as ocorrências) pelo campo escolhido. */
 const markSelection = () => {
  const el = bodyRef.current;
  if (!form || !el || !field) return;
  const selected = form.body.slice(el.selectionStart, el.selectionEnd);
  const token = `{{${field}}}`;
  if (!selected.trim()) {
   const at = el.selectionStart;
   setForm({ ...form, body: form.body.slice(0, at) + token + form.body.slice(at) });
   return;
  }
  const body = allOccurrences ? form.body.split(selected).join(token) : form.body.slice(0, el.selectionStart) + token + form.body.slice(el.selectionEnd);
  setForm({ ...form, body });
 };

 const typeFields = form ? fields.filter((f) => f.types.includes(form.orderType)) : [];
 const groups = [...new Set(typeFields.map((f) => f.group))];
 const set = (patch: Partial<Form>) => setForm((f) => (f ? { ...f, ...patch } : f));
 const chosenSign = signOptions?.find((o) => o.key === form?.signTemplateKey);

 return <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}><DialogContent className="sm:max-w-4xl max-h-[92vh] overflow-y-auto">
  <DialogHeader>
   <DialogTitle>Modelos de contrato · {store.name}</DialogTitle>
   <DialogDescription>O contrato que esta loja usa nos pedidos. Importe o PDF que a loja já tem, marque onde entram os dados do pedido e publique.</DialogDescription>
  </DialogHeader>
  {error && <div className="notice error" role="alert">{error}</div>}
  {notice && <div className="notice">{notice}</div>}

  {!form && <div className="stack">
   <section className="notice" style={{ marginBottom: 0 }}>
    <strong>Como funciona</strong>
    <ol style={{ margin: '6px 0 0 18px', listStyle: 'decimal' }}>
     <li>Escolha o tipo e importe o PDF do contrato (precisa ter texto; digitalização/foto não serve).</li>
     <li>No texto, selecione cada dado do cliente de exemplo (nome, CPF, endereço, IMEI...) e troque pelo campo correspondente.</li>
     <li>Preencha as condições (garantia; na locação, multa, juros e residual) e escolha o modelo de assinatura do Adapter Sign.</li>
     <li>Confira a pré-visualização e publique. Os próximos contratos usam esta versão.</li>
    </ol>
   </section>
   <div className="inline flex-wrap" style={{ gap: 8 }}>
    <select value={importType} onChange={(e) => setImportType(e.target.value as Form['orderType'])} aria-label="Tipo do contrato">
     <option value="">Tipo do contrato</option><option value="VENDA">Venda (moto)</option><option value="LOCACAO">Locação</option>
    </select>
    <Button disabled={busy || !importType} onClick={() => pdfRef.current?.click()}>{busy ? <LoaderCircle className="animate-spin" size={15} /> : <FileUp size={15} />} Importar PDF do contrato</Button>
    <Button variant="outline" disabled={busy || !importType} onClick={() => importType && void newBlank(importType)}><Plus size={15} /> Começar em branco</Button>
    <input ref={pdfRef} type="file" accept="application/pdf" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void importPdf(f); }} />
   </div>
   {!models ? <p className="muted"><LoaderCircle className="inline animate-spin" size={14} /> Carregando...</p>
    : !models.length ? <p className="muted">Nenhum modelo ainda. Sem modelo próprio, esta loja só gera contrato se usar um dos modelos padrão do sistema (exclusivos das empresas donas do texto).</p>
    : <div className="panel">{models.map((m) => <div key={m.id} className="list-row">
     <span><strong>{m.name}</strong><span className="muted"> · {TYPE_LABEL[m.orderType]} · v{m.version}</span><br />
      <small className="muted">{m.status === 'PUBLISHED' && m.publishedAt ? `Publicado em ${new Date(m.publishedAt).toLocaleString('pt-BR')}${m.publishedByName ? ` por ${m.publishedByName}` : ''}` : `Atualizado em ${new Date(m.updatedAt).toLocaleString('pt-BR')}`}{m.signTemplateKey ? ` · assinatura: ${m.signTemplateKey}` : ''}</small></span>
     <span className="inline flex-wrap" style={{ gap: 6, justifyContent: 'flex-end' }}>
      <span className={'badge ' + STATUS[m.status].tone}>{STATUS[m.status].label}</span>
      <Button size="sm" variant="outline" onClick={() => window.open(`/api/contract-models/${m.id}/preview`, '_blank', 'noopener,noreferrer')}><Eye size={14} /> Ver</Button>
      {m.status === 'DRAFT' && <Button size="sm" onClick={() => { setWarnings([]); setForm(toForm(m)); }}>Editar</Button>}
      {m.status !== 'DRAFT' && <Button size="sm" variant="outline" disabled={busy} onClick={() => void action({ action: 'newVersion', id: m.id }, 'Rascunho da nova versão criado.')}>Nova versão</Button>}
      {m.status === 'DRAFT' && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void action({ action: 'archive', id: m.id }, 'Rascunho descartado.')}>Descartar</Button>}
      {m.status === 'PUBLISHED' && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void action({ action: 'archive', id: m.id }, 'Modelo arquivado: novos contratos voltam ao modelo padrão do sistema, se houver.')}>Arquivar</Button>}
     </span>
    </div>)}</div>}
  </div>}

  {form && <div className="stack">
   {warnings.length > 0 && <div className="notice warning"><strong>Ao importar</strong><ul style={{ margin: '4px 0 0 18px', listStyle: 'disc' }}>{warnings.map((w) => <li key={w}>{w}</li>)}</ul></div>}
   <div className="form-grid">
    <label className="field">Nome do modelo<input value={form.name} maxLength={80} onChange={(e) => set({ name: e.target.value })} /></label>
    <label className="field">Tipo<input value={TYPE_LABEL[form.orderType]} disabled /></label>
    <label className="field full">Título do contrato<input value={form.title} maxLength={200} onChange={(e) => set({ title: e.target.value })} placeholder="CONTRATO DE ..." /></label>
    <label className="field full">Cabeçalho da empresa (1ª página, uma informação por linha; a 1ª linha sai em negrito)<textarea rows={4} value={form.headerText} onChange={(e) => set({ headerText: e.target.value })} /></label>
    <div className="field full">Logo do cabeçalho (PNG ou JPG, até 1 MB)
     <div className="inline flex-wrap" style={{ gap: 8 }}>
      <span className="muted">{form.hasLogo ? 'Logo enviado.' : 'Sem logo.'}</span>
      <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => logoRef.current?.click()}>{form.hasLogo ? 'Trocar logo' : 'Enviar logo'}</Button>
      {form.hasLogo && <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void removeLogo()}>Remover</Button>}
      <input ref={logoRef} type="file" accept="image/png,image/jpeg" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void uploadLogo(f); }} />
     </div>
    </div>
   </div>

   <section className="stack" style={{ gap: 8 }}>
    <div className="split"><strong>Texto do contrato</strong><span className="muted text-xs">Parágrafos separados por linha em branco · **negrito** · título de cláusula = parágrafo todo em negrito</span></div>
    <div className="inline flex-wrap" style={{ gap: 8 }}>
     <select value={field} onChange={(e) => setField(e.target.value)} aria-label="Campo">
      <option value="">Escolha o campo</option>
      {groups.map((g) => <optgroup key={g} label={g}>{typeFields.filter((f) => f.group === g).map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}</optgroup>)}
     </select>
     <Button type="button" size="sm" disabled={!field} onClick={markSelection}>Usar no trecho selecionado</Button>
     <label className="inline muted" style={{ gap: 6 }}><input type="checkbox" checked={allOccurrences} onChange={(e) => setAllOccurrences(e.target.checked)} /> trocar todas as ocorrências</label>
    </div>
    <p className="muted" style={{ margin: 0 }}>Selecione no texto o dado do cliente de exemplo (ex.: o nome) e clique em “Usar no trecho selecionado”. Sem seleção, o campo entra onde está o cursor. Os campos aparecem como {'{{cliente.nome}}'}.</p>
    <textarea ref={bodyRef} rows={20} value={form.body} onChange={(e) => set({ body: e.target.value })} style={{ fontSize: 13, lineHeight: 1.5 }} />
    <label className="field">Rodapé (todas as páginas, com “Página 01” à direita)<input value={form.footerText} maxLength={200} onChange={(e) => set({ footerText: e.target.value })} /></label>
   </section>

   <section className="stack" style={{ gap: 8 }}>
    <strong>Condições do contrato</strong>
    <p className="muted" style={{ margin: 0 }}>Valores que o sistema usa além do texto: a garantia calcula a data “Garantia até”; na locação, multa, juros e residual entram nos boletos. Coloque exatamente o que está no contrato.</p>
    <div className="form-grid">
     <label className="field">Prazo de garantia (dias)<input inputMode="numeric" value={form.warranty} onChange={(e) => set({ warranty: e.target.value })} placeholder="ex.: 90" /></label>
     {form.orderType === 'LOCACAO' && <>
      <label className="field">Multa por atraso (%)<input inputMode="decimal" value={form.fine} onChange={(e) => set({ fine: e.target.value })} placeholder="ex.: 2" /></label>
      <label className="field">Juros por atraso (% ao mês)<input inputMode="decimal" value={form.interest} onChange={(e) => set({ interest: e.target.value })} placeholder="ex.: 1" /></label>
      <label className="field">Valor residual da compra (R$)<input inputMode="decimal" value={form.residual} onChange={(e) => set({ residual: e.target.value })} placeholder="ex.: 19,90" /></label>
     </>}
    </div>
   </section>

   <section className="stack" style={{ gap: 8 }}>
    <strong>Assinatura eletrônica (Adapter Sign)</strong>
    <p className="muted" style={{ margin: 0 }}>Escolha o modelo de assinatura que você criou no Adapter Sign. Ele precisa ter um papel da empresa (quem assina pela loja) e um do cliente. Sem escolha, vale o modelo informado em “Assinatura eletrônica” da loja.</p>
    <div className="inline flex-wrap" style={{ gap: 8 }}>
     {signOptions ? <select value={form.signTemplateKey} onChange={(e) => { const o = signOptions.find((x) => x.key === e.target.value); set({ signTemplateKey: o?.key ?? '', signCompanyRole: o?.companyRole ?? '', signClientRole: o?.clientRole ?? '' }); }} aria-label="Modelo de assinatura">
      <option value="">Usar o da configuração da loja</option>
      {signOptions.map((o) => <option key={o.key} value={o.key} disabled={!!o.problem}>{o.name} ({o.key}){o.problem ? ` — ${o.problem}` : ''}</option>)}
     </select> : form.signTemplateKey ? <span>Escolhido: <strong>{form.signTemplateKey}</strong> (empresa: {form.signCompanyRole}, cliente: {form.signClientRole})</span> : <span className="muted">Nenhum escolhido.</span>}
     <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void loadSignOptions()}><RefreshCw size={14} /> {signOptions ? 'Atualizar lista' : 'Buscar modelos do Adapter Sign'}</Button>
    </div>
    {chosenSign && <p className="muted" style={{ margin: 0 }}>Papéis: {chosenSign.roles.map((r) => `${r.label} (${r.isCompany ? 'empresa' : 'cliente'})`).join(' · ')}</p>}
    <label className="inline" style={{ gap: 6 }}><input type="checkbox" checked={form.clientInitials} onChange={(e) => set({ clientInitials: e.target.checked })} /> Rubrica do cliente em todas as páginas</label>
   </section>

   {confirmData && <div className="notice warning" role="alert">
    <p style={{ margin: 0 }}>{confirmData}</p>
    <div className="inline" style={{ gap: 8, marginTop: 8 }}>
     <Button size="sm" disabled={busy} onClick={() => void publish(form, true)}>São dados fixos da empresa: publicar</Button>
     <Button size="sm" variant="outline" onClick={() => setConfirmData('')}>Voltar e corrigir</Button>
    </div>
   </div>}
   <div className="form-actions" style={{ marginTop: 0 }}>
    <Button variant="ghost" disabled={busy} onClick={() => { setForm(null); setWarnings([]); setConfirmData(''); setError(''); void load(); }}>Voltar à lista</Button>
    <Button variant="outline" disabled={busy} onClick={() => void run(async () => { await save(form); })}>Salvar rascunho</Button>
    <Button variant="outline" disabled={busy} onClick={() => void preview(form)}><Eye size={15} /> Pré-visualizar</Button>
    <Button disabled={busy} onClick={() => void publish(form)}>{busy ? <LoaderCircle className="animate-spin" size={15} /> : <Send size={15} />} Publicar</Button>
   </div>
  </div>}
 </DialogContent></Dialog>;
}
