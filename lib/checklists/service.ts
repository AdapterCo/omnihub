import { RuleError } from '../errors.ts';
import { requirePermission, requireStoreAccess } from '../authz/service.ts';
import type { Actor } from '../domain.ts';
import type { ObjectStorage } from '../storage/index.ts';
import { storeDocument } from '../documents/service.ts';
import type { Block, ContractTemplate } from '../contracts/templates.ts';
import { renderContractPdf } from '../contracts/pdf.ts';
import { missingFields, orderDocumentValues, CONTRACT_LOCKING_STATUSES } from '../contracts/service.ts';
import { publishedTemplateFor } from '../contracts/models.ts';
import { FIELD_BY_KEY, placeholdersIn, type OrderType } from '../contracts/fields.ts';

// Checklist de entrega (2026-10-22). Vinculado ao pedido: cliente, produto, chassi/IMEI, cor,
// garantia e loja vêm do pedido e do contrato; na entrega o vendedor só marca os itens e escreve
// as observações. Assinado à parte pelo cliente (Adapter Sign), no momento da entrega.
//
// Modelo por loja e tipo de pedido (checklist_templates): seções ("# VISUALIZAÇÃO EXTERNA") e
// itens (um por linha), texto da declaração (pode usar os campos do pedido) e modelo de assinatura.
// O checklist gerado é um registro de "contracts" com document_kind 'CHECKLIST' (mesmo fluxo de
// assinatura do contrato, sem se misturar com ele).

export type ChecklistSection = { title: string; items: string[] };
export type ChecklistTemplateView = {
 orderType: OrderType; title: string; items: string; sections: ChecklistSection[]; declaration: string;
 signTemplateKey: string; signCompanyRole: string; signClientRole: string; updatedByName: string; updatedAt: number;
};
type Row = Omit<ChecklistTemplateView, 'sections'> & { id: string; storeId: string };
const SELECT = 'SELECT id, store_id AS storeId, order_type AS orderType, title, items, declaration, sign_template_key AS signTemplateKey, sign_company_role AS signCompanyRole, sign_client_role AS signClientRole, updated_by_name AS updatedByName, updated_at AS updatedAt FROM checklist_templates';
const KEY = /^[a-z0-9][a-z0-9_-]{0,59}$/;
const ROLE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const MAX_ITEMS = 200;

/** "# Seção" abre uma seção; cada linha seguinte é um item. Linhas em branco são ignoradas. */
export function parseChecklistItems(text: string): ChecklistSection[] {
 const sections: ChecklistSection[] = [];
 for (const raw of String(text ?? '').split(/\r?\n/)) {
  const line = raw.trim();
  if (!line) continue;
  if (line.startsWith('#')) { sections.push({ title: line.replace(/^#+\s*/, '').trim(), items: [] }); continue; }
  if (!sections.length) sections.push({ title: '', items: [] });
  sections[sections.length - 1].items.push(line);
 }
 return sections.filter((s) => s.items.length);
}

const view = (r: Row): ChecklistTemplateView => ({
 orderType: r.orderType, title: r.title, items: r.items, sections: parseChecklistItems(r.items), declaration: r.declaration,
 signTemplateKey: r.signTemplateKey, signCompanyRole: r.signCompanyRole, signClientRole: r.signClientRole, updatedByName: r.updatedByName, updatedAt: Number(r.updatedAt),
});

async function templateFor(db: D1Database, tenantId: string, storeId: string, orderType: string): Promise<Row | null> {
 return db.prepare(`${SELECT} WHERE tenant_id = ? AND store_id = ? AND order_type = ?`).bind(tenantId, storeId, orderType).first<Row>();
}

export async function listChecklistTemplates(db: D1Database, tenantId: string, storeId: string, actor: Actor): Promise<ChecklistTemplateView[]> {
 requirePermission(actor.permissions, 'SIGNATURE_CONFIG');
 requireStoreAccess(actor, storeId);
 const rows = await db.prepare(`${SELECT} WHERE tenant_id = ? AND store_id = ? ORDER BY order_type`).bind(tenantId, storeId).all<Row>();
 return (rows.results ?? []).map(view);
}

export type ChecklistTemplateInput = { storeId?: string; orderType?: string; title?: string; items?: string; declaration?: string; signTemplateKey?: string; signCompanyRole?: string; signClientRole?: string };

export async function saveChecklistTemplate(db: D1Database, tenantId: string, input: ChecklistTemplateInput, actor: Actor, now = Date.now()): Promise<void> {
 requirePermission(actor.permissions, 'SIGNATURE_CONFIG');
 const storeId = String(input.storeId ?? '');
 const store = await db.prepare('SELECT id FROM stores WHERE id = ? AND tenant_id = ?').bind(storeId, tenantId).first<{ id: string }>();
 if (!store) throw new RuleError('Loja não encontrada.', 404);
 requireStoreAccess(actor, storeId);
 const orderType = input.orderType === 'VENDA' || input.orderType === 'LOCACAO' ? input.orderType : null;
 if (!orderType) throw new RuleError('Escolha o tipo: venda ou locação.', 400);
 const title = String(input.title ?? '').trim();
 if (!title || title.length > 120) throw new RuleError('Informe o título do checklist (até 120 caracteres), ex.: "DOCUMENTO DE ENTREGA".', 400);
 const items = String(input.items ?? '').replace(/\r\n?/g, '\n').trim();
 const sections = parseChecklistItems(items);
 const count = sections.reduce((n, s) => n + s.items.length, 0);
 if (!count) throw new RuleError('Cadastre pelo menos um item (um por linha; "# Nome da seção" para separar seções).', 400);
 if (count > MAX_ITEMS) throw new RuleError(`No máximo ${MAX_ITEMS} itens.`, 400);
 if (sections.some((s) => s.title.length > 120 || s.items.some((i) => i.length > 200))) throw new RuleError('Cada item pode ter até 200 caracteres (seção, até 120).', 400);
 if (/\{\{/.test(items)) throw new RuleError('Os itens do checklist não usam campos ({{...}}); campos do pedido entram na declaração.', 400);
 const declaration = String(input.declaration ?? '').replace(/\r\n?/g, '\n').trim();
 if (declaration.length > 3000) throw new RuleError('Declaração: no máximo 3000 caracteres.', 400);
 const used = placeholdersIn(declaration);
 const unknown = used.filter((k) => !FIELD_BY_KEY.has(k) && k !== 'checklist.observacoes');
 if (unknown.length) throw new RuleError(`Campos desconhecidos na declaração: ${unknown.map((k) => `{{${k}}}`).join(', ')}.`, 400);
 const wrong = used.filter((k) => FIELD_BY_KEY.get(k) && !FIELD_BY_KEY.get(k)!.types.includes(orderType));
 if (wrong.length) throw new RuleError(`Campos que não existem em ${orderType === 'VENDA' ? 'venda' : 'locação'}: ${wrong.map((k) => FIELD_BY_KEY.get(k)!.label).join(', ')}.`, 400);
 const signTemplateKey = String(input.signTemplateKey ?? '').trim();
 const signCompanyRole = String(input.signCompanyRole ?? '').trim();
 const signClientRole = String(input.signClientRole ?? '').trim();
 if (signTemplateKey && !KEY.test(signTemplateKey)) throw new RuleError('Modelo de assinatura inválido.', 400);
 if (signTemplateKey && !ROLE.test(signClientRole)) throw new RuleError('Escolha de novo o modelo de assinatura (papel do cliente).', 400);
 if (signCompanyRole && !ROLE.test(signCompanyRole)) throw new RuleError('Papel da empresa inválido.', 400);
 const existing = await templateFor(db, tenantId, storeId, orderType);
 if (existing) {
  await db.prepare('UPDATE checklist_templates SET title=?, items=?, declaration=?, sign_template_key=?, sign_company_role=?, sign_client_role=?, updated_by_name=?, updated_at=? WHERE id=?')
   .bind(title, items, declaration, signTemplateKey, signTemplateKey ? signCompanyRole : '', signTemplateKey ? signClientRole : '', actor.displayName, now, existing.id).run();
  return;
 }
 await db.prepare('INSERT INTO checklist_templates (id, tenant_id, store_id, order_type, title, items, declaration, sign_template_key, sign_company_role, sign_client_role, updated_by_name, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
  .bind(crypto.randomUUID(), tenantId, storeId, orderType, title, items, declaration, signTemplateKey, signTemplateKey ? signCompanyRole : '', signTemplateKey ? signClientRole : '', actor.displayName, now, now).run();
}

async function loadOrder(db: D1Database, tenantId: string, orderId: string) {
 const order = await db.prepare('SELECT id, number, type, status, store_id AS storeId, customer_id AS customerId FROM orders WHERE id = ? AND tenant_id = ?').bind(orderId, tenantId).first<{ id: string; number: number; type: OrderType; status: string; storeId: string; customerId: string }>();
 if (!order) throw new RuleError('Pedido não encontrado.', 404);
 return order;
}

/** Modelo de checklist que vale para o pedido (tela do pedido), ou null se a loja ainda não montou. */
export async function checklistTemplateForOrder(db: D1Database, tenantId: string, orderId: string, actor: Actor): Promise<ChecklistTemplateView | null> {
 requirePermission(actor.permissions, 'ORDER_VIEW');
 const order = await loadOrder(db, tenantId, orderId);
 requireStoreAccess(actor, order.storeId);
 const row = await templateFor(db, tenantId, order.storeId, order.type);
 return row ? view(row) : null;
}

export type ChecklistInput = { checked?: unknown; observations?: unknown; templateUpdatedAt?: unknown };

/**
 * Gera o PDF do checklist da entrega com os itens marcados. Revisão nova substitui a anterior
 * ainda não enviada; checklist já enviado/assinado trava (cancele o envio para gerar outro).
 */
export async function generateChecklist(db: D1Database, storage: ObjectStorage, tenantId: string, orderId: string, input: ChecklistInput, actor: Actor, now = Date.now()): Promise<{ contractId: string; documentId: string; externalRef: string }> {
 requirePermission(actor.permissions, 'ORDER_CREATE');
 const order = await loadOrder(db, tenantId, orderId);
 requireStoreAccess(actor, order.storeId);
 if (order.status === 'CANCELLED') throw new RuleError('Pedido cancelado não gera checklist de entrega.', 409);
 const row = await templateFor(db, tenantId, order.storeId, order.type);
 if (!row) throw new RuleError('Esta loja ainda não tem checklist de entrega. Monte em Minhas lojas > Checklist de entrega.', 409);
 if (input.templateUpdatedAt !== undefined && Number(input.templateUpdatedAt) !== Number(row.updatedAt)) throw new RuleError('O checklist da loja foi alterado enquanto você marcava. Recarregue o pedido e marque de novo.', 409);
 const locked = await db.prepare(`SELECT id FROM contracts WHERE tenant_id = ? AND order_id = ? AND document_kind = 'CHECKLIST' AND internal_status IN (${CONTRACT_LOCKING_STATUSES.map(() => '?').join(',')})`).bind(tenantId, orderId, ...CONTRACT_LOCKING_STATUSES).first<{ id: string }>();
 if (locked) throw new RuleError('Este pedido já tem checklist enviado para assinatura. Cancele o envio antes de gerar outro.', 409);
 const sections = parseChecklistItems(row.items);
 const checkedKeys = new Set(Array.isArray(input.checked) ? input.checked.map(String) : []);
 const valid = new Set(sections.flatMap((s, si) => s.items.map((_, ii) => `${si}:${ii}`)));
 for (const k of checkedKeys) if (!valid.has(k)) throw new RuleError('Item do checklist inválido. Recarregue o pedido.', 400);
 const observations = String(input.observations ?? '').trim();
 if (observations.length > 2000) throw new RuleError('Observações: no máximo 2000 caracteres.', 400);

 const { src, values } = await orderDocumentValues(db, tenantId, orderId, now);
 values['checklist.observacoes'] = observations || 'Sem observações.';
 const isSale = order.type === 'VENDA';
 const line = (parts: [string, string][]) => parts.filter(([, key]) => values[key]).map(([label, key]) => `**${label}:** {{${key}}}`).join('   ');
 const blocks: Block[] = [
  { kind: 'title', text: row.title },
  { kind: 'heading', text: 'Dados do pedido' },
  ...[
   line([['Pedido nº', 'pedido.numero'], ['Data da entrega', 'pedido.data_contrato']]),
   line([[isSale ? 'Comprador' : 'Locatário', 'cliente.nome'], ['CPF/CNPJ', 'cliente.documento']]),
   line([['Produto', 'produto.modelo'], ['Cor', 'produto.cor']]),
   line(isSale ? [['Chassi/série', 'produto.chassi_serie']] : [['IMEI', 'produto.imei'], ['Memória', 'produto.memoria'], ['Estado', 'produto.estado_aparelho']]),
   line([['Garantia até', 'pedido.garantia_ate'], ['Empresa', 'loja.razao_social']]),
  ].filter(Boolean).map((text) => ({ kind: 'p', text }) as Block),
 ];
 const snapshotSections = sections.map((s, si) => ({ title: s.title, items: s.items.map((label, ii) => ({ label, checked: checkedKeys.has(`${si}:${ii}`) })) }));
 for (const s of snapshotSections) {
  if (s.title) blocks.push({ kind: 'heading', text: s.title });
  for (const it of s.items) blocks.push({ kind: 'item', text: `(${it.checked ? 'X' : '   '}) ${it.label}` });
 }
 blocks.push({ kind: 'heading', text: 'Observações' }, { kind: 'p', text: '{{checklist.observacoes}}' });
 if (row.declaration) for (const p of row.declaration.split(/\n\s*\n/)) if (p.trim()) blocks.push({ kind: 'p', text: p.replace(/\s*\n\s*/g, ' ').trim() });
 const signRoles = row.signTemplateKey ? { company: row.signCompanyRole, client: row.signClientRole } : null;
 blocks.push({ kind: 'space', size: 24 });
 if (!signRoles || signRoles.company) blocks.push({ kind: 'signature', role: 'loja', label: '**{{loja.razao_social}}**' });
 blocks.push({ kind: 'signature', role: 'cliente', label: `**{{cliente.nome_assinatura}}** - ${isSale ? 'COMPRADOR' : 'LOCATÁRIO'}` });

 // Visual: o cabeçalho e o logo do modelo de contrato publicado da loja; sem ele, razão social e CNPJ.
 const contractModel = await publishedTemplateFor(db, storage, tenantId, order.storeId, order.type);
 const headerText = contractModel?.page?.headerText || [values['loja.razao_social'], values['loja.cnpj'] ? `CNPJ: ${values['loja.cnpj']}` : ''].filter(Boolean).join('\n');
 const used = new Set<string>(['cliente.nome', 'cliente.email']);
 for (const b of blocks) for (const k of placeholdersIn('text' in b ? b.text : 'label' in b ? b.label : '')) used.add(k);
 const template: ContractTemplate = {
  key: 'checklist-entrega', version: 1, orderType: order.type, title: row.title,
  style: { titleSize: 13, titleAlign: 'center', titleBold: true, headingSize: 10, headingBold: true, bodySize: 9.5, justify: false, pageNumbers: false },
  required: [...used].map((key) => ({ key, label: key === 'cliente.email' ? 'e-mail do cliente (necessário para o convite de assinatura)' : (FIELD_BY_KEY.get(key)?.label ?? key).toLowerCase() })),
  blocks,
  signatureRoles: signRoles ?? undefined,
  signTemplateKey: row.signTemplateKey || undefined,
  page: { headerText, footerText: 'Documento gerado em {{pedido.data_hora_geracao}}', logo: contractModel?.page?.logo ?? null },
 };
 const missing = missingFields(template, values);
 if (missing.length) throw new RuleError(`Não foi possível gerar o checklist. Preencha: ${missing.join(', ')}.`, 400);

 const count = await db.prepare("SELECT COUNT(*) AS n FROM contracts WHERE tenant_id = ? AND order_id = ? AND document_kind = 'CHECKLIST'").bind(tenantId, orderId).first<{ n: number }>();
 const revision = Number(count?.n ?? 0) + 1;
 const externalRef = `pedido-${src.order.number}-checklist-r${revision}`;
 const pdf = await renderContractPdf(template, values, { title: `${row.title} #${src.order.number} - ${values['cliente.nome']}`, now });
 const contractId = crypto.randomUUID();
 const doc = await storeDocument(db, storage, tenantId, {
  storeId: order.storeId, customerId: order.customerId, orderId, contractId, type: 'CHECKLIST_ENTREGA',
  description: `Checklist de entrega gerado (revisão ${revision})`, originalFilename: `${externalRef}.pdf`, bytes: pdf, source: 'system',
 }, actor, now);
 const snapshot = JSON.stringify({
  template: { key: template.key, version: 1, title: row.title, signTemplateKey: row.signTemplateKey || null, signatureRoles: signRoles, conditions: null },
  checklist: { sections: snapshotSections, observations, templateUpdatedAt: Number(row.updatedAt) },
  order: { id: orderId, number: src.order.number, type: order.type }, storeId: order.storeId, values, generatedAt: now,
 });
 await db.batch([
  db.prepare("UPDATE contracts SET internal_status = 'SUPERSEDED', updated_at = ? WHERE tenant_id = ? AND order_id = ? AND document_kind = 'CHECKLIST' AND internal_status = 'GENERATED'").bind(now, tenantId, orderId),
  db.prepare(
   `INSERT INTO contracts (id, tenant_id, store_id, order_id, customer_id, contract_type, document_kind, template_key, template_version, revision, external_ref, internal_status, original_document_id, original_sha256, payload_snapshot, generated_by, generated_by_name, generated_at, created_at, updated_at)
    VALUES (?,?,?,?,?,?,'CHECKLIST',?,?,?,?,'GENERATED',?,?,?,?,?,?,?,?)`,
  ).bind(contractId, tenantId, order.storeId, orderId, order.customerId, order.type, template.key, 1, revision, externalRef, doc.id, doc.sha256, snapshot, actor.userId, actor.displayName, now, now, now),
 ]);
 return { contractId, documentId: doc.id, externalRef };
}
