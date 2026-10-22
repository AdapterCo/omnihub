import { RuleError } from '../errors.ts';
import { requirePermission, requireStoreAccess } from '../authz/service.ts';
import type { Actor } from '../domain.ts';
import type { ObjectStorage } from '../storage/index.ts';
import type { Block, ContractTemplate } from './templates.ts';
import { renderContractPdf } from './pdf.ts';
import { CONTRACT_FIELDS, FIELD_BY_KEY, placeholdersIn, suspiciousFixedData, type OrderType } from './fields.ts';

// Modelos de contrato da própria loja (2026-10-21). O lojista importa o PDF que já usa, revisa o
// texto, marca os campos e publica. Regras:
// - rascunho é editável; publicado é imutável (alterar = nova versão); só um publicado por loja e
//   tipo de pedido — publicar arquiva o anterior. Contratos já gerados guardam a versão no snapshot;
// - nada é presumido: campo sem dado bloqueia a geração; condições da locação (multa, juros,
//   residual) são obrigatórias para publicar, porque os boletos usam esses valores;
// - dados que parecem do cliente de exemplo (CPF, e-mail, telefone...) fora dos campos exigem
//   confirmação antes de publicar (podem ser dados fixos da própria empresa).

const KEY = /^[a-z0-9][a-z0-9_-]{0,59}$/;
const ROLE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const MAX_LOGO = 1024 * 1024;

type ModelRow = {
 id: string; tenantId: string; storeId: string; orderType: OrderType; name: string; version: number; status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
 title: string; headerText: string; body: string; footerText: string; logoKey: string | null; logoMime: string | null;
 warrantyDays: number | null; fineBp: number | null; interestBp: number | null; residualCents: number | null;
 signTemplateKey: string; signCompanyRole: string; signClientRole: string; clientInitials: number; sourceFilename: string;
 createdByName: string; createdAt: number; updatedAt: number; publishedAt: number | null; publishedByName: string | null;
};
const SELECT = `SELECT id, tenant_id AS tenantId, store_id AS storeId, order_type AS orderType, name, version, status, title, header_text AS headerText, body, footer_text AS footerText,
 logo_key AS logoKey, logo_mime AS logoMime, warranty_days AS warrantyDays, fine_bp AS fineBp, interest_bp AS interestBp, residual_cents AS residualCents,
 sign_template_key AS signTemplateKey, sign_company_role AS signCompanyRole, sign_client_role AS signClientRole, client_initials AS clientInitials, source_filename AS sourceFilename,
 created_by_name AS createdByName, created_at AS createdAt, updated_at AS updatedAt, published_at AS publishedAt, published_by_name AS publishedByName FROM contract_models`;

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
function normalize(r: ModelRow): ModelRow {
 return { ...r, version: Number(r.version), warrantyDays: num(r.warrantyDays), fineBp: num(r.fineBp), interestBp: num(r.interestBp), residualCents: num(r.residualCents), clientInitials: Number(r.clientInitials), createdAt: Number(r.createdAt), updatedAt: Number(r.updatedAt), publishedAt: num(r.publishedAt) };
}

export type ContractModelView = Omit<ModelRow, 'tenantId' | 'logoKey' | 'logoMime' | 'clientInitials'> & { hasLogo: boolean; clientInitials: boolean };
const view = (r: ModelRow): ContractModelView => {
 const { tenantId: _t, logoKey, logoMime: _m, clientInitials, ...rest } = r;
 return { ...rest, hasLogo: !!logoKey, clientInitials: !!clientInitials };
};

async function load(db: D1Database, tenantId: string, id: string): Promise<ModelRow> {
 const row = await db.prepare(`${SELECT} WHERE id = ? AND tenant_id = ?`).bind(id, tenantId).first<ModelRow>();
 if (!row) throw new RuleError('Modelo de contrato não encontrado.', 404);
 return normalize(row);
}

function manage(actor: Actor, storeId: string) {
 requirePermission(actor.permissions, 'SIGNATURE_CONFIG');
 requireStoreAccess(actor, storeId);
}

export async function listContractModels(db: D1Database, tenantId: string, storeId: string, actor: Actor): Promise<ContractModelView[]> {
 manage(actor, storeId);
 const rows = await db.prepare(`${SELECT} WHERE tenant_id = ? AND store_id = ? ORDER BY order_type, version DESC`).bind(tenantId, storeId).all<ModelRow>();
 return (rows.results ?? []).map(normalize).map(view);
}

export async function getContractModel(db: D1Database, tenantId: string, id: string, actor: Actor): Promise<ContractModelView> {
 const row = await load(db, tenantId, id);
 manage(actor, row.storeId);
 return view(row);
}

export type ContractModelInput = {
 id?: string; storeId?: string; orderType?: string; name?: string; title?: string; headerText?: string; body?: string; footerText?: string;
 warrantyDays?: number | null; fineBp?: number | null; interestBp?: number | null; residualCents?: number | null;
 signTemplateKey?: string; signCompanyRole?: string; signClientRole?: string; clientInitials?: boolean; sourceFilename?: string;
};

function text(value: unknown, label: string, max: number): string {
 const s = String(value ?? '').replace(/\r\n?/g, '\n');
 if (s.length > max) throw new RuleError(`${label}: no máximo ${max} caracteres.`, 400);
 return s;
}
function optionalInt(value: unknown, label: string, max: number): number | null {
 if (value === null || value === undefined || value === '') return null;
 const n = Number(value);
 if (!Number.isSafeInteger(n) || n < 0 || n > max) throw new RuleError(`${label} inválido.`, 400);
 return n;
}

/** Cria ou atualiza um RASCUNHO. Publicado não muda: use "Nova versão". */
export async function saveContractModel(db: D1Database, tenantId: string, input: ContractModelInput, actor: Actor, now = Date.now()): Promise<string> {
 const name = text(input.name, 'Nome', 80).trim();
 if (!name) throw new RuleError('Dê um nome ao modelo (ex.: "Contrato de locação de celular").', 400);
 const fields = {
  name,
  title: text(input.title, 'Título', 200).trim(),
  headerText: text(input.headerText, 'Cabeçalho', 1000).trim(),
  body: text(input.body, 'Texto do contrato', 100_000).trim(),
  footerText: text(input.footerText, 'Rodapé', 200).trim(),
  warrantyDays: optionalInt(input.warrantyDays, 'Prazo de garantia', 3650),
  fineBp: optionalInt(input.fineBp, 'Multa', 10_000),
  interestBp: optionalInt(input.interestBp, 'Juros', 10_000),
  residualCents: optionalInt(input.residualCents, 'Valor residual', 100_000_000),
  signTemplateKey: String(input.signTemplateKey ?? '').trim(),
  signCompanyRole: String(input.signCompanyRole ?? '').trim(),
  signClientRole: String(input.signClientRole ?? '').trim(),
  clientInitials: input.clientInitials ? 1 : 0,
 };
 if (fields.signTemplateKey && !KEY.test(fields.signTemplateKey)) throw new RuleError('Identificador do modelo de assinatura inválido.', 400);
 for (const r of [fields.signCompanyRole, fields.signClientRole]) if (r && !ROLE.test(r)) throw new RuleError('Papel do modelo de assinatura inválido.', 400);
 if (input.id) {
  const row = await load(db, tenantId, input.id);
  manage(actor, row.storeId);
  if (row.status !== 'DRAFT') throw new RuleError('Modelo publicado não pode ser alterado. Use "Nova versão".', 409);
  await db
   .prepare('UPDATE contract_models SET name=?, title=?, header_text=?, body=?, footer_text=?, warranty_days=?, fine_bp=?, interest_bp=?, residual_cents=?, sign_template_key=?, sign_company_role=?, sign_client_role=?, client_initials=?, updated_at=? WHERE id=? AND status=\'DRAFT\'')
   .bind(fields.name, fields.title, fields.headerText, fields.body, fields.footerText, fields.warrantyDays, fields.fineBp, fields.interestBp, fields.residualCents, fields.signTemplateKey, fields.signCompanyRole, fields.signClientRole, fields.clientInitials, now, row.id)
   .run();
  return row.id;
 }
 const storeId = String(input.storeId ?? '');
 const orderType = input.orderType === 'VENDA' || input.orderType === 'LOCACAO' ? input.orderType : null;
 if (!orderType) throw new RuleError('Escolha o tipo de contrato: venda ou locação.', 400);
 const store = await db.prepare('SELECT id FROM stores WHERE id = ? AND tenant_id = ?').bind(storeId, tenantId).first<{ id: string }>();
 if (!store) throw new RuleError('Loja não encontrada.', 404);
 manage(actor, storeId);
 const draft = await db.prepare("SELECT version FROM contract_models WHERE tenant_id = ? AND store_id = ? AND order_type = ? AND status = 'DRAFT'").bind(tenantId, storeId, orderType).first<{ version: number }>();
 if (draft) throw new RuleError(`Já existe um rascunho (v${Number(draft.version)}) deste tipo de contrato nesta loja. Edite-o ou descarte antes de criar outro.`, 409);
 const max = await db.prepare('SELECT MAX(version) AS v FROM contract_models WHERE tenant_id = ? AND store_id = ? AND order_type = ?').bind(tenantId, storeId, orderType).first<{ v: number | null }>();
 const id = crypto.randomUUID();
 await db
  .prepare(`INSERT INTO contract_models (id, tenant_id, store_id, order_type, name, version, status, title, header_text, body, footer_text, warranty_days, fine_bp, interest_bp, residual_cents,
   sign_template_key, sign_company_role, sign_client_role, client_initials, source_filename, created_by, created_by_name, created_at, updated_at) VALUES (?,?,?,?,?,?,'DRAFT',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  .bind(id, tenantId, storeId, orderType, fields.name, Number(max?.v ?? 0) + 1, fields.title, fields.headerText, fields.body, fields.footerText, fields.warrantyDays, fields.fineBp, fields.interestBp, fields.residualCents,
   fields.signTemplateKey, fields.signCompanyRole, fields.signClientRole, fields.clientInitials, text(input.sourceFilename, 'Arquivo', 200), actor.userId, actor.displayName, now, now)
  .run();
 return id;
}

/** Copia um modelo (publicado ou arquivado) para um rascunho novo, com o próximo número de versão. */
export async function newContractModelVersion(db: D1Database, tenantId: string, id: string, actor: Actor, now = Date.now()): Promise<string> {
 const row = await load(db, tenantId, id);
 manage(actor, row.storeId);
 const draft = await db.prepare("SELECT id, version FROM contract_models WHERE tenant_id = ? AND store_id = ? AND order_type = ? AND status = 'DRAFT'").bind(tenantId, row.storeId, row.orderType).first<{ id: string; version: number }>();
 if (draft) throw new RuleError(`Já existe um rascunho (v${Number(draft.version)}) deste tipo de contrato. Edite-o.`, 409);
 const max = await db.prepare('SELECT MAX(version) AS v FROM contract_models WHERE tenant_id = ? AND store_id = ? AND order_type = ?').bind(tenantId, row.storeId, row.orderType).first<{ v: number }>();
 const newId = crypto.randomUUID();
 await db
  .prepare(`INSERT INTO contract_models (id, tenant_id, store_id, order_type, name, version, status, title, header_text, body, footer_text, logo_key, logo_mime, warranty_days, fine_bp, interest_bp, residual_cents,
   sign_template_key, sign_company_role, sign_client_role, client_initials, source_filename, created_by, created_by_name, created_at, updated_at) VALUES (?,?,?,?,?,?,'DRAFT',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  .bind(newId, tenantId, row.storeId, row.orderType, row.name, Number(max?.v ?? row.version) + 1, row.title, row.headerText, row.body, row.footerText, row.logoKey, row.logoMime, row.warrantyDays, row.fineBp, row.interestBp, row.residualCents,
   row.signTemplateKey, row.signCompanyRole, row.signClientRole, row.clientInitials, row.sourceFilename, actor.userId, actor.displayName, now, now)
  .run();
 return newId;
}

/** Rascunho descartado ou modelo publicado retirado de uso. Nunca apaga: contratos antigos citam a versão. */
export async function archiveContractModel(db: D1Database, tenantId: string, id: string, actor: Actor, now = Date.now()): Promise<void> {
 const row = await load(db, tenantId, id);
 manage(actor, row.storeId);
 if (row.status === 'ARCHIVED') return;
 await db.prepare("UPDATE contract_models SET status = 'ARCHIVED', updated_at = ? WHERE id = ?").bind(now, id).run();
}

const IMAGE_KINDS = [
 { mime: 'image/png', ext: 'png', test: (b: Uint8Array) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
 { mime: 'image/jpeg', ext: 'jpg', test: (b: Uint8Array) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
];

/** Logo do cabeçalho (PNG ou JPG, até 1 MB). Só em rascunho. bytes vazio remove o logo. */
export async function setContractModelLogo(db: D1Database, storage: ObjectStorage, tenantId: string, id: string, bytes: Uint8Array, actor: Actor, now = Date.now()): Promise<void> {
 const row = await load(db, tenantId, id);
 manage(actor, row.storeId);
 if (row.status !== 'DRAFT') throw new RuleError('Modelo publicado não pode ser alterado. Use "Nova versão".', 409);
 if (!bytes.length) {
  await db.prepare('UPDATE contract_models SET logo_key = NULL, logo_mime = NULL, updated_at = ? WHERE id = ?').bind(now, id).run();
  return;
 }
 if (bytes.length > MAX_LOGO) throw new RuleError('Logo maior que 1 MB. Reduza a imagem.', 413);
 const kind = IMAGE_KINDS.find((k) => k.test(bytes));
 if (!kind) throw new RuleError('Envie o logo em PNG ou JPG.', 400);
 const key = `contract-models/${tenantId}/${id}/logo-${crypto.randomUUID()}.${kind.ext}`;
 await storage.put(key, bytes);
 await db.prepare('UPDATE contract_models SET logo_key = ?, logo_mime = ?, updated_at = ? WHERE id = ?').bind(key, kind.mime, now, id).run();
}

/**
 * Texto do modelo → blocos do PDF. Parágrafos separados por linha em branco; parágrafo todo em
 * **negrito** e curto vira título de cláusula; "1. ..." / "a) ..." / "- ..." viram item recuado.
 */
export function parseModelBody(body: string): Block[] {
 const blocks: Block[] = [];
 for (const raw of String(body ?? '').split(/\n\s*\n/)) {
  const p = raw.replace(/\s*\n\s*/g, ' ').trim();
  if (!p) continue;
  if (/^\*\*[^*]+\*\*$/.test(p) && p.length <= 140) blocks.push({ kind: 'heading', text: p.slice(2, -2) });
  else if (/^(\d{1,3}\.|[a-z]\))\s/.test(p) || /^-\s/.test(p)) blocks.push({ kind: 'item', text: p.replace(/^-\s/, '• ') });
  else blocks.push({ kind: 'p', text: p });
 }
 return blocks;
}

const SIGNATURE_BLOCKS: Block[] = [
 { kind: 'space', size: 24 },
 { kind: 'signature', role: 'loja', label: '**{{loja.razao_social}}** - CNPJ {{loja.cnpj}}' },
 { kind: 'signature', role: 'cliente', label: '**{{cliente.nome_assinatura}}** - CPF/CNPJ {{cliente.documento}}' },
];

function modelTemplate(row: ModelRow, logo: { bytes: Uint8Array; mime: string } | null): ContractTemplate {
 const blocks: Block[] = [...(row.title ? [{ kind: 'title', text: row.title } as Block] : []), ...parseModelBody(row.body), ...SIGNATURE_BLOCKS];
 const used = new Set<string>(['cliente.nome', 'cliente.email']);
 for (const t of [row.title, row.headerText, row.body, row.footerText, ...SIGNATURE_BLOCKS.map((b) => ('label' in b ? b.label : ''))]) for (const k of placeholdersIn(t)) used.add(k);
 return {
  key: `modelo-loja-${row.orderType === 'VENDA' ? 'venda' : 'locacao'}`,
  version: row.version,
  orderType: row.orderType,
  title: row.name,
  style: { titleSize: 13, titleAlign: 'center', titleBold: true, headingSize: 10.5, headingBold: true, bodySize: 9.5, justify: true, pageNumbers: false },
  required: [...used].map((key) => ({ key, label: key === 'cliente.email' ? 'e-mail do cliente (necessário para o convite de assinatura)' : (FIELD_BY_KEY.get(key)?.label ?? key).toLowerCase() })),
  blocks,
  signatureRoles: row.signTemplateKey && row.signCompanyRole && row.signClientRole ? { company: row.signCompanyRole, client: row.signClientRole } : undefined,
  signTemplateKey: row.signTemplateKey || undefined,
  clientInitials: !!row.clientInitials,
  page: { headerText: row.headerText, footerText: row.footerText, logo },
  conditions: { warrantyDays: row.warrantyDays, fineBp: row.fineBp, interestBp: row.interestBp, residualCents: row.residualCents },
  modelId: row.id,
 };
}

async function loadLogo(storage: ObjectStorage, row: ModelRow) {
 if (!row.logoKey || !row.logoMime) return null;
 return { bytes: await storage.get(row.logoKey), mime: row.logoMime };
}

/** Modelo publicado da loja para o tipo de pedido (ou null: vale o modelo do código). */
export async function publishedTemplateFor(db: D1Database, storage: ObjectStorage, tenantId: string, storeId: string, orderType: OrderType): Promise<ContractTemplate | null> {
 const row = await db.prepare(`${SELECT} WHERE tenant_id = ? AND store_id = ? AND order_type = ? AND status = 'PUBLISHED' ORDER BY version DESC LIMIT 1`).bind(tenantId, storeId, orderType).first<ModelRow>();
 if (!row) return null;
 const r = normalize(row);
 return modelTemplate(r, await loadLogo(storage, r));
}

/** Valores de exemplo (claramente fictícios) para a pré-visualização. */
function sampleValues(row: ModelRow): Record<string, string> {
 const values: Record<string, string> = {};
 for (const f of CONTRACT_FIELDS) values[f.key] = f.example;
 const pct = (bp: number | null) => (bp == null ? '[defina em Condições]' : `${(bp / 100).toLocaleString('pt-BR', { maximumFractionDigits: 2 })}%`);
 values['contrato.multa'] = pct(row.fineBp);
 values['contrato.juros'] = pct(row.interestBp);
 values['contrato.residual'] = row.residualCents == null ? '[defina em Condições]' : (row.residualCents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
 values['contrato.garantia_dias'] = row.warrantyDays == null ? '[defina em Condições]' : String(row.warrantyDays);
 return values;
}

export async function previewContractModel(db: D1Database, storage: ObjectStorage, tenantId: string, id: string, actor: Actor, now = Date.now()): Promise<Uint8Array> {
 const row = await load(db, tenantId, id);
 manage(actor, row.storeId);
 const unknown = [row.title, row.headerText, row.body, row.footerText].flatMap(placeholdersIn).filter((k) => !FIELD_BY_KEY.has(k));
 if (unknown.length) throw new RuleError(`Campos desconhecidos no texto: ${[...new Set(unknown)].map((k) => `{{${k}}}`).join(', ')}. Use os campos da lista.`, 400);
 return renderContractPdf(modelTemplate(row, await loadLogo(storage, row)), sampleValues(row), { title: `Pré-visualização - ${row.name}`, now, clientInitials: !!row.clientInitials });
}

/** Confere o rascunho e publica (arquiva a versão publicada anterior do mesmo tipo). */
export async function publishContractModel(db: D1Database, storage: ObjectStorage, tenantId: string, id: string, options: { confirmFixedData?: boolean }, actor: Actor, now = Date.now()): Promise<void> {
 const row = await load(db, tenantId, id);
 manage(actor, row.storeId);
 if (row.status !== 'DRAFT') throw new RuleError('Só um rascunho pode ser publicado.', 409);
 const problems: string[] = [];
 if (!row.title) problems.push('preencha o título do contrato');
 if (!row.body) problems.push('o texto do contrato está vazio');
 const all = [row.title, row.headerText, row.body, row.footerText].flatMap(placeholdersIn);
 const unknown = [...new Set(all.filter((k) => !FIELD_BY_KEY.has(k)))];
 if (unknown.length) problems.push(`campos desconhecidos: ${unknown.map((k) => `{{${k}}}`).join(', ')}`);
 const wrongType = [...new Set(all.filter((k) => FIELD_BY_KEY.get(k) && !FIELD_BY_KEY.get(k)!.types.includes(row.orderType)))];
 if (wrongType.length) problems.push(`campos que não existem em ${row.orderType === 'VENDA' ? 'venda' : 'locação'}: ${wrongType.map((k) => FIELD_BY_KEY.get(k)!.label).join(', ')}`);
 const used = new Set(placeholdersIn(row.body));
 const needs: [boolean, string][] = [
  [used.has('cliente.nome') || used.has('cliente.nome_assinatura'), 'nome do cliente'],
  [used.has('cliente.documento') || used.has('cliente.cpf'), 'CPF/CNPJ do cliente'],
  [row.orderType === 'VENDA' ? used.has('produto.chassi_serie') : used.has('produto.imei'), row.orderType === 'VENDA' ? 'chassi/série do produto' : 'IMEI do aparelho'],
 ];
 const missing = needs.filter(([ok]) => !ok).map(([, label]) => label);
 if (missing.length) problems.push(`marque no texto os campos: ${missing.join(', ')}`);
 if (row.orderType === 'LOCACAO' && (row.fineBp == null || row.interestBp == null || row.residualCents == null)) problems.push('preencha multa, juros e valor residual em "Condições" (os boletos usam esses valores)');
 if ((all.includes('pedido.garantia_ate') || all.includes('contrato.garantia_dias')) && !row.warrantyDays) problems.push('preencha o prazo de garantia em "Condições" (o texto usa a garantia)');
 if (row.signTemplateKey && (!row.signCompanyRole || !row.signClientRole || row.signCompanyRole === row.signClientRole)) problems.push('escolha de novo o modelo de assinatura (papéis da empresa e do cliente)');
 if (problems.length) throw new RuleError(`Não foi possível publicar: ${problems.join('; ')}.`, 400);
 // Gera a pré-visualização: confirma que o PDF sai (caracteres suportados, logo válido).
 await renderContractPdf(modelTemplate(row, await loadLogo(storage, row)), sampleValues(row), { title: row.name, now });
 const suspicious = suspiciousFixedData([row.headerText, row.body, row.footerText].join('\n'));
 if (suspicious.length && !options.confirmFixedData) {
  throw new RuleError(`O texto ainda tem dados que parecem do contrato de exemplo: ${suspicious.join('; ')}. Se forem dados fixos da empresa (CNPJ, telefone, e-mail da loja), confirme; se forem do cliente de exemplo, troque pelo campo correspondente.`, 428);
 }
 await db.batch([
  db.prepare("UPDATE contract_models SET status = 'ARCHIVED', updated_at = ? WHERE tenant_id = ? AND store_id = ? AND order_type = ? AND status = 'PUBLISHED'").bind(now, tenantId, row.storeId, row.orderType),
  db.prepare("UPDATE contract_models SET status = 'PUBLISHED', published_at = ?, published_by_name = ?, updated_at = ? WHERE id = ? AND status = 'DRAFT'").bind(now, actor.displayName, now, id),
 ]);
}
