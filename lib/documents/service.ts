import { createHash } from 'node:crypto';
import { RuleError } from '../errors.ts';
import { requirePermission, requireStoreAccess } from '../authz/service.ts';
import type { Actor } from '../domain.ts';
import type { ObjectStorage } from '../storage/index.ts';

// Documentos do pedido/cliente (instrucao-sistema-vendas.md §18, §25). Metadados no banco,
// arquivo no armazenamento. O tipo do arquivo é decidido pelo CONTEÚDO (assinatura binária),
// não pela extensão nem pelo MIME informado pelo navegador — um executável renomeado para .pdf
// é recusado. Exclusão é sempre lógica.

export const DOCUMENT_TYPES = ['ANEXO', 'CONTRATO_ORIGINAL', 'CONTRATO_ASSINADO', 'EVIDENCIA_ASSINATURA'] as const;
export type DocumentType = typeof DOCUMENT_TYPES[number];
export type DocumentSource = 'manual' | 'system' | 'adapter_sign';

// Limite técnico de upload (tamanho de arquivo aceito pelo servidor).
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

const KINDS = [
 { mime: 'application/pdf', ext: 'pdf', test: (b: Uint8Array) => b.length > 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2d }, // %PDF-
 { mime: 'image/png', ext: 'png', test: (b: Uint8Array) => b.length > 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => b[i] === v) },
 { mime: 'image/jpeg', ext: 'jpg', test: (b: Uint8Array) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
] as const;

export function detectFileType(bytes: Uint8Array): { mime: string; ext: string } | null {
 const kind = KINDS.find((k) => k.test(bytes));
 return kind ? { mime: kind.mime, ext: kind.ext } : null;
}

export const sha256Hex = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export type NewDocument = {
 storeId: string; customerId: string | null; orderId: string | null; contractId?: string | null;
 type: DocumentType; description: string; originalFilename?: string; bytes: Uint8Array; source: DocumentSource;
};

/** Grava arquivo + metadados. Uso interno (upload manual, contrato gerado, arquivos do Adapter Sign). */
export async function storeDocument(db: D1Database, storage: ObjectStorage, tenantId: string, input: NewDocument, actor: Pick<Actor, 'userId' | 'displayName'>, now = Date.now()): Promise<{ id: string; sha256: string }> {
 const kind = detectFileType(input.bytes);
 if (!kind) throw new RuleError('Tipo de arquivo não aceito. Envie PDF, JPG ou PNG.', 400);
 const id = crypto.randomUUID();
 const sha256 = sha256Hex(input.bytes);
 const scope = input.orderId ? `pedidos/${input.orderId}` : input.customerId ? `clientes/${input.customerId}` : `lojas/${input.storeId}`;
 const key = `t/${tenantId}/${scope}/${id}.${kind.ext}`;
 await storage.put(key, input.bytes);
 const filename = String(input.originalFilename ?? '').replace(/[\r\n"\\/]/g, '').slice(0, 160);
 await db
  .prepare('INSERT INTO documents (id, tenant_id, store_id, customer_id, order_id, contract_id, type, description, original_filename, storage_key, mime_type, size, sha256, source, uploaded_by, uploaded_by_name, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
  .bind(id, tenantId, input.storeId, input.customerId, input.orderId, input.contractId ?? null, input.type, input.description, filename, key, kind.mime, input.bytes.length, sha256, input.source, actor.userId, actor.displayName, now)
  .run();
 return { id, sha256 };
}

async function loadOrderScope(db: D1Database, tenantId: string, orderId: string) {
 const order = await db.prepare('SELECT id, store_id AS storeId, customer_id AS customerId FROM orders WHERE id = ? AND tenant_id = ?').bind(orderId, tenantId).first<{ id: string; storeId: string; customerId: string }>();
 if (!order) throw new RuleError('Pedido não encontrado.', 404);
 return order;
}

/** Anexo manual na aba Documentos do pedido (descrição + arquivo PDF/JPG/PNG). */
export async function uploadOrderDocument(db: D1Database, storage: ObjectStorage, tenantId: string, orderId: string, input: { description: string; filename: string; bytes: Uint8Array }, actor: Actor, now = Date.now()): Promise<string> {
 requirePermission(actor.permissions, 'ORDER_CREATE');
 const order = await loadOrderScope(db, tenantId, orderId);
 requireStoreAccess(actor, order.storeId);
 const description = String(input.description ?? '').trim();
 if (description.length < 3 || description.length > 160) throw new RuleError('Informe a descrição do documento (3 a 160 caracteres).', 400);
 if (!input.bytes.length) throw new RuleError('Arquivo vazio.', 400);
 if (input.bytes.length > MAX_UPLOAD_BYTES) throw new RuleError('Arquivo maior que 10 MB.', 413);
 const { id } = await storeDocument(db, storage, tenantId, { storeId: order.storeId, customerId: order.customerId, orderId: order.id, type: 'ANEXO', description, originalFilename: input.filename, bytes: input.bytes, source: 'manual' }, actor, now);
 return id;
}

export type DocumentRecord = { id: string; orderId: string | null; contractId: string | null; type: DocumentType; description: string; originalFilename: string; mimeType: string; size: number; sha256: string; source: DocumentSource; uploadedByName: string; createdAt: number };

export async function listOrderDocuments(db: D1Database, tenantId: string, actor: Actor): Promise<DocumentRecord[]> {
 if (!actor.permissions.has('ORDER_VIEW')) return [];
 const rows = await db
  .prepare(
   `SELECT d.id AS id, d.order_id AS orderId, d.contract_id AS contractId, d.type AS type, d.description AS description, d.original_filename AS originalFilename,
           d.mime_type AS mimeType, d.size AS size, d.sha256 AS sha256, d.source AS source, d.uploaded_by_name AS uploadedByName, d.created_at AS createdAt, d.store_id AS storeId
    FROM documents d WHERE d.tenant_id = ? AND d.order_id IS NOT NULL AND d.deleted_at IS NULL ORDER BY d.created_at DESC`,
  )
  .bind(tenantId)
  .all<DocumentRecord & { storeId: string }>();
 return (rows.results ?? [])
  .filter((d) => !actor.storeId || d.storeId === actor.storeId)
  .map(({ storeId: _s, ...d }) => ({ ...d, size: Number(d.size), createdAt: Number(d.createdAt) }));
}

/** Download autorizado: o arquivo só sai por aqui (nunca por URL pública). */
export async function readDocument(db: D1Database, storage: ObjectStorage, tenantId: string, id: string, actor: Actor): Promise<{ bytes: Uint8Array; mimeType: string; filename: string }> {
 requirePermission(actor.permissions, 'ORDER_VIEW');
 const doc = await db.prepare('SELECT store_id AS storeId, storage_key AS storageKey, mime_type AS mimeType, original_filename AS originalFilename, description, type, deleted_at AS deletedAt FROM documents WHERE id = ? AND tenant_id = ?').bind(id, tenantId).first<{ storeId: string; storageKey: string; mimeType: string; originalFilename: string; description: string; type: string; deletedAt: number | null }>();
 if (!doc || doc.deletedAt != null) throw new RuleError('Documento não encontrado.', 404);
 requireStoreAccess(actor, doc.storeId);
 const bytes = await storage.get(doc.storageKey);
 const ext = doc.mimeType === 'application/pdf' ? 'pdf' : doc.mimeType === 'image/png' ? 'png' : 'jpg';
 const base = (doc.originalFilename || doc.description || doc.type).replace(/\.[A-Za-z0-9]{1,5}$/, '').replace(/[^\p{L}\p{N} ._-]/gu, '').trim().slice(0, 80) || 'documento';
 return { bytes, mimeType: doc.mimeType, filename: `${base}.${ext}` };
}

/** Exclusão lógica (o arquivo continua guardado). Só OWNER/ADMIN (DOCUMENT_DELETE). */
export async function deleteDocument(db: D1Database, tenantId: string, id: string, actor: Actor, now = Date.now()): Promise<{ type: string; description: string }> {
 requirePermission(actor.permissions, 'DOCUMENT_DELETE');
 const doc = await db.prepare('SELECT store_id AS storeId, type, description, contract_id AS contractId FROM documents WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL').bind(id, tenantId).first<{ storeId: string; type: string; description: string; contractId: string | null }>();
 if (!doc) throw new RuleError('Documento não encontrado.', 404);
 requireStoreAccess(actor, doc.storeId);
 // O PDF original de um contrato ainda vigente é a base do envio para assinatura: não some.
 if (doc.type === 'CONTRATO_ORIGINAL' && doc.contractId) {
  const contract = await db.prepare('SELECT internal_status AS status FROM contracts WHERE id = ?').bind(doc.contractId).first<{ status: string }>();
  if (contract && !['SUPERSEDED', 'CANCELLED'].includes(contract.status)) throw new RuleError('Este é o PDF de um contrato vigente. Gere um novo contrato (a versão atual fica substituída) em vez de excluir.', 409);
 }
 await db.prepare('UPDATE documents SET deleted_at = ?, deleted_by = ? WHERE id = ? AND deleted_at IS NULL').bind(now, actor.userId, id).run();
 return { type: doc.type, description: doc.description };
}
