'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { LoaderCircle, Pencil, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { CustomerRecord } from '@/lib/customers/service';

/**
 * Busca de clientes no servidor (GET /api/customers), só na conta de quem está logado. A tela não carrega
 * mais a lista inteira: contas com milhares de clientes buscam enquanto digitam, 20 por vez.
 */
export function useCustomerSearch(q: string, { limit = 20, enabled = true, revision = 0 }: { limit?: number; enabled?: boolean; revision?: number } = {}) {
 const [items, setItems] = useState<CustomerRecord[]>([]);
 const [hasMore, setHasMore] = useState(false);
 const [loading, setLoading] = useState(false);
 const [error, setError] = useState('');
 const seq = useRef(0);
 const fetchPage = useCallback(async (offset: number) => {
  const id = ++seq.current;
  setLoading(true);
  try {
   const r = await fetch(`/api/customers?q=${encodeURIComponent(q.trim())}&limit=${limit}&offset=${offset}`, { cache: 'no-store' });
   const d = (await r.json()) as { items?: CustomerRecord[]; hasMore?: boolean; error?: string };
   if (id !== seq.current) return; // resposta de uma busca antiga: ignora
   if (!r.ok) { setError(d.error ?? 'Não foi possível buscar os clientes.'); return; }
   setError('');
   setItems((prev) => (offset ? [...prev, ...(d.items ?? [])] : d.items ?? []));
   setHasMore(!!d.hasMore);
  } catch {
   if (id === seq.current) setError('Sem conexão para buscar os clientes.');
  } finally {
   if (id === seq.current) setLoading(false);
  }
 }, [q, limit]);
 useEffect(() => {
  if (!enabled) return;
  const t = setTimeout(() => void fetchPage(0), q.trim() ? 250 : 0);
  return () => clearTimeout(t);
 }, [fetchPage, enabled, revision, q]);
 return { items, hasMore, loading, error, loadMore: () => fetchPage(items.length) };
}

const label = (c: { name: string; document?: string }) => `${c.name}${c.document ? ' · ' + c.document : ''}`;

/** Aba Clientes: busca no servidor por nome, CPF/CNPJ, telefone, e-mail ou cidade, com "Carregar mais". */
export function CustomersPage({ active, busy, revision, onEdit, onNew }: { active: boolean; busy: boolean; revision: number; onEdit: (c: CustomerRecord) => void; onNew: () => void }) {
 const [q, setQ] = useState('');
 const { items, hasMore, loading, error, loadMore } = useCustomerSearch(q, { limit: 50, revision });
 return <>
  <div className="toolbar"><label className="field flex-1"><span className="sr-only">Buscar cliente</span><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar por nome, CPF/CNPJ, telefone, e-mail ou cidade" /></label></div>
  <section className="panel">
   {error && <p className="notice error" style={{ margin: 12 }}>{error}</p>}
   {items.length ? <div className="table-pad"><Table><TableHeader><TableRow>{['Cliente', 'Documento', 'Contato', 'Cidade / UF', 'Ação'].map((h) => <TableHead key={h}>{h}</TableHead>)}</TableRow></TableHeader><TableBody>
    {items.map((c) => <TableRow key={c.id}><TableCell><strong>{c.name}</strong><div className="muted">{c.docType}</div></TableCell><TableCell>{c.document || '—'}</TableCell><TableCell>{c.phone || c.email || '—'}<div className="muted">{c.phone && c.email ? c.email : ''}</div></TableCell><TableCell>{c.city ? `${c.city} - ${c.state}` : '—'}</TableCell><TableCell><Button variant="ghost" size="icon" aria-label={'Editar ' + c.name} disabled={!active || busy} onClick={() => onEdit(c)}><Pencil size={16} /></Button></TableCell></TableRow>)}
   </TableBody></Table>
    <div className="list-row" style={{ justifyContent: 'center' }}>{hasMore ? <Button variant="outline" size="sm" disabled={loading} onClick={() => void loadMore()}>{loading ? <LoaderCircle className="animate-spin" size={14} /> : null} Carregar mais clientes</Button> : <span className="muted">{items.length} cliente(s){q.trim() ? ' encontrado(s)' : ''}.</span>}</div>
   </div>
    : loading ? <p className="muted" style={{ padding: 24, textAlign: 'center' }}><LoaderCircle className="inline animate-spin" size={14} /> Buscando clientes...</p>
    : <div style={{ padding: 32, textAlign: 'center' }}><strong>{q.trim() ? 'Nenhum cliente encontrado' : 'Cadastre seus clientes'}</strong><p className="muted">{q.trim() ? 'Tente outro nome, parte do CPF ou telefone.' : 'Cadastre clientes para vincular vendas e pedidos.'}</p>{!q.trim() && <Button disabled={!active} onClick={onNew}><Plus /> Novo cliente</Button>}</div>}
  </section>
 </>;
}

/** Campo Cliente do pedido: digita nome, CPF/CNPJ ou telefone e escolhe na lista (setas, Enter e Esc). */
export function CustomerPicker({ value, initialLabel, onChange }: { value: string; initialLabel?: string; onChange: (id: string) => void }) {
 const [chosen, setChosen] = useState(initialLabel ?? '');
 const [text, setText] = useState(initialLabel ?? '');
 const [open, setOpen] = useState(false);
 const [hi, setHi] = useState(0);
 const typing = open && text !== chosen;
 const { items, loading } = useCustomerSearch(typing ? text : '', { limit: 8, enabled: open });
 const pick = (c: CustomerRecord) => { onChange(c.id); setChosen(label(c)); setText(label(c)); setOpen(false); };
 return <div className="search-pick">
  <input value={text} placeholder="Digite o nome, CPF/CNPJ ou telefone do cliente" autoComplete="off" role="combobox" aria-expanded={open} aria-autocomplete="list"
   onFocus={(e) => { setOpen(true); setHi(0); e.currentTarget.select(); }}
   onBlur={() => setTimeout(() => { setOpen(false); setText(value ? chosen : ''); }, 150)}
   onChange={(e) => { setText(e.target.value); setOpen(true); setHi(0); if (value) { onChange(''); setChosen(''); } }}
   onKeyDown={(e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setHi((h) => Math.min(h + 1, items.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
    else if (e.key === 'Enter' && open && items[hi]) { e.preventDefault(); pick(items[hi]); }
    else if (e.key === 'Escape') setOpen(false);
   }} />
  {open && <ul className="search-pick-list" role="listbox">
   {items.length ? items.map((c, i) => <li key={c.id} role="option" aria-selected={c.id === value} className={i === hi ? 'active' : ''} onMouseDown={(e) => { e.preventDefault(); pick(c); }} onMouseEnter={() => setHi(i)}>{label(c)}</li>)
    : <li className="empty">{loading ? 'Buscando...' : 'Nenhum cliente encontrado. Cadastre na aba Clientes.'}</li>}
  </ul>}
 </div>;
}

/** Campo "Cliente (opcional)" do PDV: sugere clientes cadastrados (busca no servidor) e preenche o documento. */
export function PdvCustomerInput({ value, onChange, onPick }: { value: string; onChange: (v: string) => void; onPick: (c: CustomerRecord) => void }) {
 const { items } = useCustomerSearch(value, { limit: 8, enabled: value.trim().length >= 2 });
 return <>
  <input list="registered-customers" value={value} maxLength={160} placeholder="Nome do cliente"
   onChange={(e) => { const v = e.target.value; onChange(v); const found = items.find((c) => c.name === v); if (found) onPick(found); }} />
  <datalist id="registered-customers">{items.map((c) => <option key={c.id} value={c.name}>{label(c)}</option>)}</datalist>
 </>;
}
