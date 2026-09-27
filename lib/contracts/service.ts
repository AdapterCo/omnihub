import { RuleError } from '../errors.ts';
import { requirePermission, requireStoreAccess } from '../authz/service.ts';
import type { Actor } from '../domain.ts';
import { dayKey } from '../time.ts';
import type { ObjectStorage } from '../storage/index.ts';
import { storeDocument } from '../documents/service.ts';
import { currentTemplateFor, placeholdersOf, type ContractTemplate } from './templates.ts';
import { renderContractPdf } from './pdf.ts';

// Motor de contratos (instrucao-sistema-vendas.md §5–§8, §24, §33): dados do pedido →
// validação → snapshot → modelo versionado → PDF → hash → documento "Contrato gerado
// automaticamente". Cada geração é uma revisão imutável; gerar de novo substitui a anterior
// (SUPERSEDED), sem apagar nada. Envio ao Adapter Sign é a etapa seguinte (status SENT...).

// Status que travam o pedido: o contrato já saiu para assinatura (preenchidos na etapa do Adapter Sign).
export const CONTRACT_LOCKING_STATUSES = ['SENDING', 'SENT', 'CLIENT_SIGNED', 'FINALIZING', 'COMPLETED'] as const;

const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const digits = (v: string) => String(v ?? '').replace(/\D/g, '');
export const formatCpf = (v: string) => { const d = digits(v); return d.length === 11 ? `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}` : ''; };
export const formatCnpj = (v: string) => { const d = digits(v); return d.length === 14 ? `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}` : ''; };
const formatCep = (v: string) => { const d = digits(v); return d.length === 8 ? `${d.slice(0, 5)}-${d.slice(5)}` : ''; };
const formatPhone = (v: string) => {
 const d = digits(v).replace(/^55(?=\d{10,11}$)/, '');
 if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
 if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
 return '';
};
export const formatMoney = (cents: number) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(cents / 100).replace(/ /g, ' ');
const brDate = (iso: string) => (/^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso.split('-').reverse().join('/') : '');
const longDate = (iso: string) => { const [y, m, d] = iso.split('-').map(Number); return `${d} de ${MONTHS[m - 1]} de ${y}`; };
function addDays(iso: string, days: number): string {
 const [y, m, d] = iso.split('-').map(Number);
 return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export type ContractSource = {
 order: { id: string; number: number; type: 'VENDA' | 'LOCACAO'; status: string; storeId: string; customerId: string; total: number; purchaseDate: string; downPayment: number; downPaymentMethod: string; installments: number; firstDueDate: string; adhesionAmount: number; monthlyAmount: number; dueDay: number };
 store: { id: string; name: string; cnpj: string };
 customer: { name: string; document: string; docType: string; email: string; phone: string; zip: string; address: string; number: string; complement: string; district: string; city: string; state: string };
 unit: { serial: string; color: string; memory: string; condition: string; productName: string };
};

async function loadSource(db: D1Database, tenantId: string, orderId: string): Promise<ContractSource> {
 const o = await db
  .prepare('SELECT id, number, type, status, store_id AS storeId, customer_id AS customerId, unit_id AS unitId, total, purchase_date AS purchaseDate, down_payment AS downPayment, down_payment_method AS downPaymentMethod, installments, first_due_date AS firstDueDate, adhesion_amount AS adhesionAmount, monthly_amount AS monthlyAmount, due_day AS dueDay FROM orders WHERE id = ? AND tenant_id = ?')
  .bind(orderId, tenantId)
  .first<ContractSource['order'] & { unitId: string }>();
 if (!o) throw new RuleError('Pedido não encontrado.', 404);
 const store = await db.prepare('SELECT id, name, cnpj FROM stores WHERE id = ? AND tenant_id = ?').bind(o.storeId, tenantId).first<ContractSource['store']>();
 const customer = await db.prepare('SELECT name, document, doc_type AS docType, email, phone, zip, address, number, complement, district, city, state FROM customers WHERE id = ? AND tenant_id = ?').bind(o.customerId, tenantId).first<ContractSource['customer']>();
 const unit = await db.prepare('SELECT u.serial AS serial, u.color AS color, u.memory AS memory, u.condition AS condition, p.name AS productName FROM product_units u JOIN products p ON p.id = u.product_id WHERE u.id = ? AND u.tenant_id = ?').bind(o.unitId, tenantId).first<ContractSource['unit']>();
 if (!store || !customer || !unit) throw new RuleError('Dados do pedido incompletos (loja, cliente ou unidade não encontrados).', 404);
 const order = { ...o, number: Number(o.number), total: Number(o.total), downPayment: Number(o.downPayment), installments: Number(o.installments), adhesionAmount: Number(o.adhesionAmount), monthlyAmount: Number(o.monthlyAmount), dueDay: Number(o.dueDay) };
 return { order, store, customer, unit };
}

function paymentDescription(o: ContractSource['order']): string {
 if (o.installments === 0) return o.downPaymentMethod ? `À vista (${o.downPaymentMethod})` : '';
 const financed = o.total - o.downPayment;
 const boleto = `${formatMoney(financed)} em ${o.installments} parcela${o.installments > 1 ? 's' : ''} no boleto bancário, com 1º vencimento em ${brDate(o.firstDueDate)}`;
 return o.downPayment > 0 ? `Entrada de ${formatMoney(o.downPayment)} (${o.downPaymentMethod}) + ${boleto}` : boleto;
}

/**
 * Valores dos placeholders a partir dos dados reais. Campo ausente fica vazio (nunca um valor
 * "razoável"); a validação lista o que falta antes de gerar qualquer PDF.
 */
export function buildContractValues(template: ContractTemplate, src: ContractSource, now: number): Record<string, string> {
 const c = src.customer;
 const docDigits = digits(c.document);
 const isCpf = c.docType !== 'CNPJ' && docDigits.length === 11;
 const document = isCpf ? formatCpf(docDigits) : formatCnpj(docDigits);
 const addressOk = [c.address, c.number, c.district, c.city, c.state].every((v) => String(v ?? '').trim());
 const cep = formatCep(c.zip);
 const address = addressOk
  ? [c.address.trim(), c.number.trim(), String(c.complement ?? '').trim(), c.district.trim(), `${c.city.trim()} - ${c.state.trim().toUpperCase()}`, cep ? `CEP ${cep}` : ''].filter(Boolean).join(', ')
  : '';
 const phone = formatPhone(c.phone);
 const email = String(c.email ?? '').trim();
 const contractDate = dayKey(now);
 const o = src.order;
 const values: Record<string, string> = {
  'cliente.nome': c.name.trim(),
  'cliente.nome_assinatura': c.name.trim().toUpperCase(),
  'cliente.documento': document,
  'cliente.cpf': isCpf ? formatCpf(docDigits) : '',
  'cliente.endereco_completo': address,
  'cliente.email': email,
  'cliente.contato': [phone, email].filter(Boolean).join(' / '),
  'produto.modelo': src.unit.productName.trim(),
  'produto.cor': src.unit.color.trim(),
  'produto.chassi_serie': template.orderType === 'VENDA' ? src.unit.serial : '',
  'produto.imei': template.orderType === 'LOCACAO' ? src.unit.serial : '',
  'produto.memoria': src.unit.memory.trim(),
  'produto.estado_aparelho': src.unit.condition.trim(),
  'pedido.data_contrato': brDate(contractDate),
  'pedido.data_contrato_extenso': longDate(contractDate),
 };
 if (template.orderType === 'VENDA') {
  values['pedido.data_compra'] = brDate(o.purchaseDate);
  values['pedido.valor'] = o.total > 0 ? formatMoney(o.total) : '';
  values['pedido.forma_pagamento'] = paymentDescription(o);
  values['pedido.garantia_ate'] = template.warrantyDays && o.purchaseDate ? brDate(addDays(o.purchaseDate, template.warrantyDays)) : '';
 } else {
  values['pedido.valor_adesao'] = o.adhesionAmount > 0 ? formatMoney(o.adhesionAmount) : '';
  values['pedido.valor_mensalidade'] = o.monthlyAmount > 0 ? formatMoney(o.monthlyAmount) : '';
  values['pedido.dia_vencimento'] = o.dueDay >= 1 && o.dueDay <= 31 ? String(o.dueDay) : '';
 }
 return values;
}

export function missingFields(template: ContractTemplate, values: Record<string, string>): string[] {
 const missing = template.required.filter((r) => !values[r.key]).map((r) => r.label);
 // Qualquer placeholder usado no texto sem valor também bloqueia (defesa contra modelo novo sem regra).
 for (const key of placeholdersOf(template)) if (!values[key] && !template.required.some((r) => r.key === key)) missing.push(key);
 return missing;
}

export async function generateContract(db: D1Database, storage: ObjectStorage, tenantId: string, orderId: string, actor: Actor, now = Date.now()): Promise<{ contractId: string; documentId: string; externalRef: string }> {
 requirePermission(actor.permissions, 'ORDER_CREATE');
 const src = await loadSource(db, tenantId, orderId);
 requireStoreAccess(actor, src.order.storeId);
 if (src.order.status === 'CANCELLED') throw new RuleError('Pedido cancelado não gera contrato.', 409);
 const template = currentTemplateFor(src.order.type);
 // O texto do modelo cita a empresa: gerar para outra loja produziria um contrato com a parte errada.
 if (digits(src.store.cnpj) !== template.ownerCnpj) {
  throw new RuleError(`O modelo "${template.title}" (v${template.version}) é da empresa ${template.ownerName}, CNPJ ${formatCnpj(template.ownerCnpj)}. A loja ${src.store.name} está com CNPJ ${formatCnpj(src.store.cnpj) || 'não informado'}. Cadastre o CNPJ correto da loja ou peça um modelo de contrato para esta empresa.`, 409);
 }
 const locked = await db.prepare(`SELECT id FROM contracts WHERE tenant_id = ? AND order_id = ? AND internal_status IN (${CONTRACT_LOCKING_STATUSES.map(() => '?').join(',')})`).bind(tenantId, orderId, ...CONTRACT_LOCKING_STATUSES).first<{ id: string }>();
 if (locked) throw new RuleError('Este pedido já tem contrato enviado para assinatura. Cancele o envio antes de gerar outro.', 409);
 const values = buildContractValues(template, src, now);
 const missing = missingFields(template, values);
 if (missing.length) throw new RuleError(`Não foi possível gerar o contrato. Preencha: ${missing.join(', ')}.`, 400);

 const count = await db.prepare('SELECT COUNT(*) AS n FROM contracts WHERE tenant_id = ? AND order_id = ?').bind(tenantId, orderId).first<{ n: number }>();
 const revision = Number(count?.n ?? 0) + 1;
 const externalRef = `pedido-${src.order.number}-${template.key}-v${template.version}-r${revision}`;
 const title = `${template.orderType === 'VENDA' ? 'Contrato de venda' : 'Contrato de locação'} #${src.order.number} - ${values['cliente.nome']}`;
 const pdf = await renderContractPdf(template, values, { title, now });
 const contractId = crypto.randomUUID();
 const doc = await storeDocument(db, storage, tenantId, {
  storeId: src.order.storeId, customerId: src.order.customerId, orderId, contractId, type: 'CONTRATO_ORIGINAL',
  description: `Contrato gerado automaticamente (${template.key} v${template.version}, revisão ${revision})`,
  originalFilename: `${externalRef}.pdf`, bytes: pdf, source: 'system',
 }, actor, now);
 // Snapshot obrigatório (§8): o contrato não muda se o cadastro mudar depois.
 const snapshot = JSON.stringify({ template: { key: template.key, version: template.version }, order: { id: orderId, number: src.order.number, type: src.order.type }, storeId: src.store.id, values, generatedAt: now });
 await db.batch([
  db.prepare("UPDATE contracts SET internal_status = 'SUPERSEDED', updated_at = ? WHERE tenant_id = ? AND order_id = ? AND internal_status = 'GENERATED'").bind(now, tenantId, orderId),
  db.prepare(
   `INSERT INTO contracts (id, tenant_id, store_id, order_id, customer_id, contract_type, template_key, template_version, revision, external_ref, internal_status, original_document_id, original_sha256, payload_snapshot, generated_by, generated_by_name, generated_at, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,'GENERATED',?,?,?,?,?,?,?,?)`,
  ).bind(contractId, tenantId, src.order.storeId, orderId, src.order.customerId, src.order.type, template.key, template.version, revision, externalRef, doc.id, doc.sha256, snapshot, actor.userId, actor.displayName, now, now, now),
 ]);
 return { contractId, documentId: doc.id, externalRef };
}

/**
 * Alteração/cancelamento do pedido: contrato ainda não enviado vira SUPERSEDED/CANCELLED (os
 * dados mudaram); contrato já enviado para assinatura bloqueia a alteração.
 */
export async function assertOrderContractsEditable(db: D1Database, tenantId: string, orderId: string): Promise<void> {
 const locked = await db.prepare(`SELECT id FROM contracts WHERE tenant_id = ? AND order_id = ? AND internal_status IN (${CONTRACT_LOCKING_STATUSES.map(() => '?').join(',')})`).bind(tenantId, orderId, ...CONTRACT_LOCKING_STATUSES).first<{ id: string }>();
 if (locked) throw new RuleError('Este pedido tem contrato enviado para assinatura; não pode ser alterado nem cancelado por aqui.', 409);
}

export async function invalidateOrderContracts(db: D1Database, tenantId: string, orderId: string, reason: 'ORDER_UPDATED' | 'ORDER_CANCELLED', now = Date.now()): Promise<void> {
 await db.prepare(`UPDATE contracts SET internal_status = ?, updated_at = ? WHERE tenant_id = ? AND order_id = ? AND internal_status = 'GENERATED'`).bind(reason === 'ORDER_CANCELLED' ? 'CANCELLED' : 'SUPERSEDED', now, tenantId, orderId).run();
}

export type ContractRecord = { id: string; orderId: string; templateKey: string; templateVersion: number; revision: number; externalRef: string; status: string; adapterStatus: string; originalDocumentId: string; originalSha256: string; validationCode: string | null; generatedByName: string; generatedAt: number; sentAt: number | null; sentByName: string | null; completedAt: number | null; signedDocumentId: string | null; evidenceDocumentId: string | null; lastError: string };

export async function listContracts(db: D1Database, tenantId: string, actor: Actor): Promise<ContractRecord[]> {
 if (!actor.permissions.has('ORDER_VIEW')) return [];
 const rows = await db
  .prepare(
   `SELECT id, order_id AS orderId, store_id AS storeId, template_key AS templateKey, template_version AS templateVersion, revision, external_ref AS externalRef, internal_status AS status,
           original_document_id AS originalDocumentId, original_sha256 AS originalSha256, validation_code AS validationCode, generated_by_name AS generatedByName, generated_at AS generatedAt,
           adapter_status AS adapterStatus, sent_at AS sentAt, sent_by_name AS sentByName, completed_at AS completedAt, signed_document_id AS signedDocumentId, evidence_document_id AS evidenceDocumentId, last_error AS lastError
    FROM contracts WHERE tenant_id = ? ORDER BY generated_at DESC`,
  )
  .bind(tenantId)
  .all<ContractRecord & { storeId: string }>();
 return (rows.results ?? [])
  .filter((c) => !actor.storeId || c.storeId === actor.storeId)
  .map(({ storeId: _s, ...c }) => ({ ...c, templateVersion: Number(c.templateVersion), revision: Number(c.revision), generatedAt: Number(c.generatedAt), sentAt: c.sentAt == null ? null : Number(c.sentAt), completedAt: c.completedAt == null ? null : Number(c.completedAt), lastError: c.lastError ?? '' }));
}
