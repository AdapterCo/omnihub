import { randomBytes } from 'node:crypto';
import { RuleError } from '../errors.ts';
import { requirePermission, requireStoreAccess } from '../authz/service.ts';
import type { Actor } from '../domain.ts';
import { encryptPayload, decryptPayload, type EncryptedPayload } from '../fiscal/certificate.ts';
import type { ObjectStorage } from '../storage/index.ts';
import { storeDocument, sha256Hex } from '../documents/service.ts';
import { AdapterSignClient, AdapterSignError, verifyAdapterSignWebhook, ADAPTER_SIGN_API, type SignFetch, type EnvelopeDetail } from './adapterSign.ts';

// Assinatura eletrônica dos contratos pelo Adapter Sign (instrucao-sistema-vendas.md §10–§15;
// integracao-sistema-vendas.md do Adapter Sign). Regras:
// - a loja assina no envio, em nome do VENDEDOR LOGADO (papel "loja", externalId = id interno);
// - externalRef do contrato é a chave de idempotência: retentativa nunca duplica envelope;
// - o signingUrl do cliente é credencial temporária: devolvido à tela, NUNCA gravado;
// - status só muda a partir do próprio Adapter Sign (GET /envelopes/{id}); o webhook só avisa;
// - contrato só vira COMPLETED depois de baixar o PDF final E o relatório de evidências.

export type SignatureDeps = { fetch: SignFetch; storage: ObjectStorage; baseUrl?: string };

const TEMPLATE_KEY = /^[a-z0-9][a-z0-9_-]{0,59}$/;

const encryptSecret = (value: string) => JSON.stringify(encryptPayload(value));
const decryptSecret = (value: string) => {
 try {
  return decryptPayload(JSON.parse(value) as EncryptedPayload).toString('utf8');
 } catch {
  throw new RuleError('Não foi possível ler as credenciais do Adapter Sign salvas desta loja (a chave FISCAL_SECRET_KEY do servidor foi alterada?). Salve a API key e o segredo do webhook novamente em "Assinatura eletrônica".', 409);
 }
};

type ConfigRow = { id: string; tenantId: string; storeId: string; apiKeyEnc: string; webhookSecretEnc: string | null; webhookKey: string; motoTemplate: string; locacaoTemplate: string; updatedAt: number };
const CONFIG_SELECT = 'SELECT id, tenant_id AS tenantId, store_id AS storeId, api_key_enc AS apiKeyEnc, webhook_secret_enc AS webhookSecretEnc, webhook_key AS webhookKey, moto_template AS motoTemplate, locacao_template AS locacaoTemplate, updated_at AS updatedAt FROM signature_configs';

async function loadConfig(db: D1Database, tenantId: string, storeId: string): Promise<ConfigRow | null> {
 return db.prepare(`${CONFIG_SELECT} WHERE tenant_id = ? AND store_id = ?`).bind(tenantId, storeId).first<ConfigRow>();
}

export async function saveSignatureConfig(db: D1Database, tenantId: string, storeId: string, input: { apiKey?: string; webhookSecret?: string; motoTemplate?: string; locacaoTemplate?: string; motoInitials?: boolean; locacaoInitials?: boolean }, actor: Actor, now = Date.now()): Promise<void> {
 requirePermission(actor.permissions, 'SIGNATURE_CONFIG');
 const store = await db.prepare('SELECT id FROM stores WHERE id = ? AND tenant_id = ?').bind(storeId, tenantId).first<{ id: string }>();
 if (!store) throw new RuleError('Loja não encontrada.', 404);
 requireStoreAccess(actor, storeId);
 const apiKey = String(input.apiKey ?? '').trim();
 const secret = String(input.webhookSecret ?? '').trim();
 const moto = String(input.motoTemplate ?? '').trim();
 const locacao = String(input.locacaoTemplate ?? '').trim();
 for (const [label, key] of [['moto', moto], ['locação', locacao]] as const) {
  if (key && !TEMPLATE_KEY.test(key)) throw new RuleError(`Identificador do modelo de ${label} inválido (letras minúsculas, números, "-" e "_", até 60 caracteres), como aparece no Adapter Sign.`, 400);
 }
 if (apiKey && (apiKey.length < 10 || apiKey.length > 500 || /\s/.test(apiKey))) throw new RuleError('API key do Adapter Sign inválida.', 400);
 if (secret && (secret.length < 10 || secret.length > 500 || /\s/.test(secret))) throw new RuleError('Segredo do webhook inválido.', 400);
 const existing = await loadConfig(db, tenantId, storeId);
 if (!existing) {
  if (!apiKey) throw new RuleError('Informe a API key do Adapter Sign da loja (Configurações → API keys no Adapter Sign).', 400);
  await db
   .prepare('INSERT INTO signature_configs (id, tenant_id, store_id, api_key_enc, webhook_secret_enc, webhook_key, moto_template, locacao_template, updated_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
   .bind(crypto.randomUUID(), tenantId, storeId, encryptSecret(apiKey), secret ? encryptSecret(secret) : null, randomBytes(24).toString('hex'), moto, locacao, actor.userId, now, now)
   .run();
  await db.prepare('UPDATE signature_configs SET moto_initials=?,locacao_initials=? WHERE store_id=? AND tenant_id=?').bind(input.motoInitials?1:0,input.locacaoInitials?1:0,storeId,tenantId).run();
  return;
 }
 // Campo de segredo em branco mantém o valor já salvo (nunca é exibido de volta).
 await db
  .prepare('UPDATE signature_configs SET api_key_enc = ?, webhook_secret_enc = ?, moto_template = ?, locacao_template = ?, updated_by = ?, updated_at = ? WHERE id = ?')
  .bind(apiKey ? encryptSecret(apiKey) : existing.apiKeyEnc, secret ? encryptSecret(secret) : existing.webhookSecretEnc, moto, locacao, actor.userId, now, existing.id)
  .run();
 if(input.motoInitials!==undefined)await db.prepare('UPDATE signature_configs SET moto_initials=? WHERE store_id=? AND tenant_id=?').bind(input.motoInitials?1:0,storeId,tenantId).run();
 if(input.locacaoInitials!==undefined)await db.prepare('UPDATE signature_configs SET locacao_initials=? WHERE store_id=? AND tenant_id=?').bind(input.locacaoInitials?1:0,storeId,tenantId).run();
}

export type SignatureConfigSummary = { storeId: string; configured: boolean; hasWebhookSecret: boolean; motoTemplate: string; locacaoTemplate: string; motoInitials: boolean; locacaoInitials: boolean; webhookPath: string | null; updatedAt: number | null };

export async function getSignatureConfigSummary(db: D1Database, tenantId: string, storeId: string): Promise<SignatureConfigSummary> {
 const c = await loadConfig(db, tenantId, storeId);
 const initials=await db.prepare('SELECT moto_initials AS moto,locacao_initials AS locacao FROM signature_configs WHERE tenant_id=? AND store_id=?').bind(tenantId,storeId).first<{moto:number;locacao:number}>();
 return {
  storeId,
  configured: !!c,
  hasWebhookSecret: !!c?.webhookSecretEnc,
  motoTemplate: c?.motoTemplate ?? '',
  locacaoTemplate: c?.locacaoTemplate ?? '',
  motoInitials:!!initials?.moto,locacaoInitials:!!initials?.locacao,
  webhookPath: c ? `/api/signature/adapter-sign/webhook/${c.webhookKey}` : null,
  updatedAt: c ? Number(c.updatedAt) : null,
 };
}

function clientFor(config: ConfigRow, deps: SignatureDeps) {
 return new AdapterSignClient(decryptSecret(config.apiKeyEnc), deps.fetch, deps.baseUrl || (process.env.ADAPTER_SIGN_BASE_URL ?? '').trim() || ADAPTER_SIGN_API);
}

type ContractRow = {
 id: string; tenantId: string; storeId: string; orderId: string; customerId: string; contractType: 'VENDA' | 'LOCACAO'; templateKey: string; revision: number;
 externalRef: string; status: string; adapterStatus: string; envelopeId: string | null; validationCode: string | null; originalDocumentId: string;
 adapterDocumentId: string | null; signerLojaId: string | null; signerClienteId: string | null; sentBy: string | null; sentByName: string | null; sentByEmail: string | null;
 sendAttempts: number; payloadSnapshot: string; orderNumber: number; orderStatus: string;
};

async function loadContract(db: D1Database, tenantId: string, contractId: string): Promise<ContractRow> {
 const row = await db
  .prepare(
   `SELECT c.id AS id, c.tenant_id AS tenantId, c.store_id AS storeId, c.order_id AS orderId, c.customer_id AS customerId, c.contract_type AS contractType, c.template_key AS templateKey,
           c.revision AS revision, c.external_ref AS externalRef, c.internal_status AS status, c.adapter_status AS adapterStatus, c.envelope_id AS envelopeId, c.validation_code AS validationCode,
           c.original_document_id AS originalDocumentId, c.adapter_document_id AS adapterDocumentId, c.signer_loja_id AS signerLojaId, c.signer_cliente_id AS signerClienteId,
           c.sent_by AS sentBy, c.sent_by_name AS sentByName, c.sent_by_email AS sentByEmail, c.send_attempts AS sendAttempts, c.payload_snapshot AS payloadSnapshot,
           o.number AS orderNumber, o.status AS orderStatus
    FROM contracts c JOIN orders o ON o.id = c.order_id WHERE c.id = ? AND c.tenant_id = ?`,
  )
  .bind(contractId, tenantId)
  .first<ContractRow>();
 if (!row) throw new RuleError('Contrato não encontrado.', 404);
 return { ...row, revision: Number(row.revision), sendAttempts: Number(row.sendAttempts), orderNumber: Number(row.orderNumber) };
}

/** Mensagem para o usuário a partir do erro documentado do Adapter Sign (nunca o texto técnico cru sozinho). */
export function friendlySignError(error: AdapterSignError, templateKey = ''): string {
 const ref = error.requestId ? ` (código ${error.requestId})` : '';
 switch (error.code) {
  case 'VALIDATION_ERROR': {
   // contracts.service.ts do Adapter Sign devolve { missing, unknown } quando os papéis do modelo
   // não batem com os enviados (o OmniHub envia sempre "loja" e "cliente").
   const d = (error.details ?? {}) as { missing?: unknown; unknown?: unknown };
   const list = (x: unknown) => (Array.isArray(x) ? x.filter((k): k is string => typeof k === 'string').map((k) => `"${k}"`).join(', ') : '');
   const missing = list(d.missing), unknown = list(d.unknown);
   const roles = missing || unknown
    ? ` O modelo "${templateKey}" no Adapter Sign precisa ter exatamente os papéis "loja" (empresa, ordem 1) e "cliente" (ordem 2).${missing ? ` Papéis do modelo sem correspondência: ${missing}.` : ''}${unknown ? ` Papéis enviados que o modelo não tem: ${unknown}.` : ''}`
    : '';
   return `O Adapter Sign recusou os dados: ${error.message}${roles}${ref}`;
  }
  case 'TEMPLATE_NOT_FOUND': return `Modelo "${templateKey}" não encontrado (ou arquivado) no Adapter Sign. Confira o identificador em Minhas lojas > Assinatura eletrônica.${ref}`;
  case 'TEMPLATE_ANCHORS_MISMATCH': return `O PDF do contrato não tem os marcadores esperados pelo modelo no Adapter Sign (papéis "loja" e "cliente"). Nada foi criado.${ref}`;
  case 'COMPANY_SIGNATURE_NOT_AUTHORIZED': return `A loja ainda não autorizou a assinatura da empresa pela integração. O proprietário precisa aceitar em Adapter Sign → Configurações → Assinatura da empresa.${ref}`;
  case 'TEMPLATE_ORDER_UNSUPPORTED': return `No modelo do Adapter Sign, o papel da loja precisa vir antes do cliente.${ref}`;
  case 'PLAN_LIMIT_REACHED': return `Limite do plano do Adapter Sign atingido.${ref}`;
  case 'UNAUTHENTICATED': case 'HTTP_401': return 'API key do Adapter Sign recusada. Confira a chave em Minhas lojas > Assinatura eletrônica.';
  case 'FORBIDDEN': case 'HTTP_403': return `A API key do Adapter Sign não tem permissão para esta operação.${ref}`;
  default: return `${error.message}${ref}`;
 }
}

function digits(v: string) { return String(v ?? '').replace(/\D/g, ''); }

/**
 * Envia o contrato gerado para assinatura. Retentativa (contrato SENDING) usa o mesmo externalRef
 * e o mesmo vendedor do primeiro envio. Devolve o link do cliente só para esta resposta.
 */
export async function sendContractForSignature(db: D1Database, tenantId: string, contractId: string, actor: Actor | null, deps: SignatureDeps, now = Date.now()): Promise<{ signingUrl: string | null; signingUrlExpiresAt: string | null; replayed: boolean }> {
 const contract = await loadContract(db, tenantId, contractId);
 if (actor) {
  requirePermission(actor.permissions, 'ORDER_CREATE');
  requireStoreAccess(actor, contract.storeId);
 }
 if (contract.orderStatus === 'CANCELLED') throw new RuleError('Pedido cancelado: o contrato não pode ser enviado.', 409);
 if (!['GENERATED', 'SENDING'].includes(contract.status)) throw new RuleError(contract.status === 'SUPERSEDED' ? 'Este contrato foi substituído por uma revisão mais nova.' : 'Este contrato já foi enviado para assinatura.', 409);
 const config = await loadConfig(db, tenantId, contract.storeId);
 if (!config) throw new RuleError('Assinatura eletrônica não configurada nesta loja (Minhas lojas > Assinatura eletrônica).', 409);
 const templateKey = contract.contractType === 'VENDA' ? config.motoTemplate : config.locacaoTemplate;
 if (!templateKey) throw new RuleError(`Informe o identificador do modelo de ${contract.contractType === 'VENDA' ? 'moto' : 'locação'} do Adapter Sign em Minhas lojas > Assinatura eletrônica.`, 409);

 // Representante da loja: quem envia pela primeira vez (retentativas mantêm o mesmo).
 let seller = contract.sentBy ? { id: contract.sentBy, name: contract.sentByName ?? '', email: contract.sentByEmail ?? '' } : null;
 if (!seller) {
  if (!actor) throw new RuleError('Envio sem vendedor identificado.', 409);
  const user = await db.prepare('SELECT display_name AS name, email FROM users WHERE id = ?').bind(actor.userId).first<{ name: string; email: string | null }>();
  if (!user?.email) throw new RuleError('Seu usuário não tem e-mail cadastrado: o Adapter Sign exige o e-mail de quem assina pela loja.', 409);
  seller = { id: actor.userId, name: (actor.displayName || user.name).trim(), email: user.email };
 }
 const snapshot = JSON.parse(contract.payloadSnapshot) as { values: Record<string, string> };
 const v = snapshot.values;
 const customer = await db.prepare('SELECT phone FROM customers WHERE id = ? AND tenant_id = ?').bind(contract.customerId, tenantId).first<{ phone: string }>();
 const phoneDigits = digits(customer?.phone ?? '');
 const clientSigner: { role: string; name: string; email: string; cpf?: string; phone?: string } = { role: 'cliente', name: v['cliente.nome'], email: v['cliente.email'] };
 if (v['cliente.cpf']) clientSigner.cpf = v['cliente.cpf'];
 // Telefone com DDD (10/11 dígitos) → convite e código também pelo WhatsApp, conforme a integração.
 if (phoneDigits.length === 10 || phoneDigits.length === 11) clientSigner.phone = `+55${phoneDigits}`;

 const claimed = await db
  .prepare("UPDATE contracts SET internal_status = 'SENDING', sent_by = ?, sent_by_name = ?, sent_by_email = ?, send_attempts = send_attempts + 1, last_checked_at = ?, updated_at = ? WHERE id = ? AND internal_status IN ('GENERATED','SENDING')")
  .bind(seller.id, seller.name, seller.email, now, now, contractId)
  .run();
 if (claimed.meta.changes !== 1) throw new RuleError('O contrato mudou de situação. Atualize a tela.', 409);

 const doc = await db.prepare('SELECT storage_key AS storageKey FROM documents WHERE id = ? AND tenant_id = ?').bind(contract.originalDocumentId, tenantId).first<{ storageKey: string }>();
 if (!doc) throw new RuleError('PDF original do contrato não encontrado.', 404);
 const pdf = await deps.storage.get(doc.storageKey);
 const title = `${contract.contractType === 'VENDA' ? 'Contrato de venda' : 'Contrato de locação'} #${contract.orderNumber} - ${v['cliente.nome']}`.slice(0, 200);
 try {
  const sent = await clientFor(config, deps).sendFromTemplate(pdf, `${contract.externalRef}.pdf`, {
   template: templateKey,
   externalRef: contract.externalRef,
   title,
   signers: [{ role: 'loja', name: seller.name, email: seller.email, externalId: seller.id }, clientSigner],
  });
  const loja = sent.signers.find((s) => s.role === 'loja');
  const cliente = sent.signers.find((s) => s.role === 'cliente');
  const status = cliente?.status === 'SIGNED' || sent.status === 'COMPLETED' ? 'CLIENT_SIGNED' : 'SENT';
  await db
   .prepare('UPDATE contracts SET internal_status = ?, adapter_status = ?, envelope_id = ?, validation_code = ?, adapter_document_id = ?, signer_loja_id = ?, signer_cliente_id = ?, last_error = ?, sent_at = COALESCE(sent_at, ?), updated_at = ? WHERE id = ?')
   .bind(status, sent.status, sent.id, sent.validationCode ?? null, sent.documents[0]?.id ?? null, loja?.id ?? null, cliente?.id ?? null, '', now, now, contractId)
   .run();
  return { signingUrl: cliente?.signingUrl ?? null, signingUrlExpiresAt: cliente?.signingUrlExpiresAt ?? null, replayed: !!sent.replayed };
 } catch (error) {
  if (error instanceof AdapterSignError) {
   const message = friendlySignError(error, templateKey);
   if (error.retryable) {
    // Resultado incerto: fica SENDING (o pedido continua travado). Repetir usa o mesmo externalRef.
    await db.prepare('UPDATE contracts SET last_error = ?, updated_at = ? WHERE id = ?').bind(message, now, contractId).run();
    throw new RuleError(`Instabilidade no Adapter Sign: ${message} O envio será repetido automaticamente (sem risco de duplicar); você também pode tentar de novo.`, 503);
   }
   // Recusa definitiva: nada foi criado no Adapter Sign; volta a GENERATED para corrigir e reenviar.
   await db.prepare("UPDATE contracts SET internal_status = 'GENERATED', last_error = ?, updated_at = ? WHERE id = ? AND internal_status = 'SENDING'").bind(message, now, contractId).run();
   throw new RuleError(message, error.status === 402 ? 402 : 422);
  }
  await db.prepare('UPDATE contracts SET last_error = ?, updated_at = ? WHERE id = ?').bind('Falha inesperada no envio.', now, contractId).run();
  throw error;
 }
}

/** Link novo para o cliente (ex.: perdeu o e-mail). Não é gravado. */
export async function newSigningLink(db: D1Database, tenantId: string, contractId: string, actor: Actor, deps: SignatureDeps): Promise<{ signingUrl: string; expiresAt: string }> {
 requirePermission(actor.permissions, 'ORDER_CREATE');
 const contract = await loadContract(db, tenantId, contractId);
 requireStoreAccess(actor, contract.storeId);
 if (contract.status !== 'SENT' || !contract.envelopeId || !contract.signerClienteId) throw new RuleError('Só é possível gerar link novo enquanto o contrato aguarda a assinatura do cliente.', 409);
 const config = await loadConfig(db, tenantId, contract.storeId);
 if (!config) throw new RuleError('Assinatura eletrônica não configurada nesta loja.', 409);
 try {
  const link = await clientFor(config, deps).issueLink(contract.envelopeId, contract.signerClienteId);
  return { signingUrl: link.signingUrl, expiresAt: link.expiresAt };
 } catch (error) {
  if (error instanceof AdapterSignError) throw new RuleError(friendlySignError(error), error.retryable ? 503 : 409);
  throw error;
 }
}

/** Cancela o envelope no Adapter Sign (histórico preservado lá) e libera o pedido. */
export async function cancelSignature(db: D1Database, tenantId: string, contractId: string, reason: string, actor: Actor, deps: SignatureDeps, now = Date.now()): Promise<void> {
 requirePermission(actor.permissions, 'ORDER_CANCEL');
 const contract = await loadContract(db, tenantId, contractId);
 requireStoreAccess(actor, contract.storeId);
 const text = String(reason ?? '').trim();
 if (text.length < 5) throw new RuleError('Informe o motivo do cancelamento da assinatura (mínimo 5 caracteres).', 400);
 if (!['SENT', 'CLIENT_SIGNED'].includes(contract.status) || !contract.envelopeId) throw new RuleError('Só é possível cancelar um contrato aguardando assinatura.', 409);
 const config = await loadConfig(db, tenantId, contract.storeId);
 if (!config) throw new RuleError('Assinatura eletrônica não configurada nesta loja.', 409);
 try {
  await clientFor(config, deps).cancelEnvelope(contract.envelopeId, text, `cancel-${contract.id}`);
 } catch (error) {
  if (error instanceof AdapterSignError) {
   // O envelope pode ter sido concluído nesse meio tempo: atualiza pelo Adapter Sign e explica.
   if (!error.retryable) await syncContract(db, tenantId, contractId, deps, now).catch(() => undefined);
   throw new RuleError(`O Adapter Sign não cancelou o envelope: ${friendlySignError(error)}`, error.retryable ? 503 : 409);
  }
  throw error;
 }
 await db.prepare("UPDATE contracts SET internal_status = 'CANCELLED', adapter_status = 'CANCELLED', last_error = ?, updated_at = ? WHERE id = ?").bind(`Cancelado: ${text}`, now, contractId).run();
}

function mapEnvelope(env: EnvelopeDetail, clienteSignerId: string | null): string {
 if (env.status === 'COMPLETED') return 'COMPLETED';
 if (env.status === 'EXPIRED') return 'EXPIRED';
 if (env.status === 'DECLINED') return 'DECLINED';
 if (env.status === 'CANCELLED') return 'CANCELLED';
 const cliente = env.signers.find((s) => s.id === clienteSignerId || s.roleKey === 'cliente');
 return cliente?.status === 'SIGNED' ? 'CLIENT_SIGNED' : 'SENT';
}

/**
 * Atualiza o contrato pelo que o Adapter Sign diz (GET /envelopes/{id}). Concluído: baixa o PDF
 * final e as evidências, grava na aba Documentos e só então marca COMPLETED.
 */
export async function syncContract(db: D1Database, tenantId: string, contractId: string, deps: SignatureDeps, now = Date.now()): Promise<string> {
 const contract = await loadContract(db, tenantId, contractId);
 if (!contract.envelopeId) return contract.status;
 if (!['SENT', 'CLIENT_SIGNED', 'FINALIZING'].includes(contract.status)) return contract.status;
 const config = await loadConfig(db, tenantId, contract.storeId);
 if (!config) return contract.status;
 const client = clientFor(config, deps);
 const env = await client.getEnvelope(contract.envelopeId);
 if (env.id !== contract.envelopeId || env.externalRef !== contract.externalRef || !Array.isArray(env.documents) || !Array.isArray(env.signers)) {
  throw new AdapterSignError(0, 'INVALID_RESPONSE', 'O Adapter Sign retornou dados de outro contrato ou uma resposta incompleta.');
 }
 await db.prepare('UPDATE contracts SET adapter_status = ?, validation_code = COALESCE(?, validation_code), last_checked_at = ? WHERE id = ?').bind(env.status, env.validationCode ?? null, now, contractId).run();
 const target = mapEnvelope(env, contract.signerClienteId);
 if (target !== 'COMPLETED') {
  if (target !== contract.status && contract.status !== 'FINALIZING') {
   await db.prepare('UPDATE contracts SET internal_status = ?, updated_at = ? WHERE id = ? AND internal_status = ?').bind(target, now, contractId, contract.status).run();
  }
  return target;
 }
 const docInfo = env.documents.find((d) => d.id === contract.adapterDocumentId);
 if (!docInfo?.finalAvailable) {
  // Assinado, PDF final ainda sendo gerado: tenta de novo na próxima consulta.
  if (contract.status === 'SENT') await db.prepare("UPDATE contracts SET internal_status = 'CLIENT_SIGNED', updated_at = ? WHERE id = ? AND internal_status = 'SENT'").bind(now, contractId).run();
  return 'CLIENT_SIGNED';
 }
 // Reivindica a finalização: dois processamentos simultâneos (webhook + worker) não baixam duas vezes.
 const processingToken = crypto.randomUUID();
 const claim = await db.prepare("UPDATE contracts SET internal_status = 'FINALIZING', processing_token = ?, processing_until = ?, updated_at = ? WHERE id = ? AND internal_status IN ('SENT','CLIENT_SIGNED','FINALIZING') AND (processing_until IS NULL OR processing_until < ?)").bind(processingToken, now + 5 * 60_000, now, contractId, now).run();
 if (claim.meta.changes !== 1) return 'FINALIZING';
 try {
  const finalPdf = await client.finalDocument(env.id, docInfo.id);
  const evidencePdf = await client.evidence(env.id);
  if (![finalPdf,evidencePdf].every(pdf => Buffer.from(pdf.subarray(0,5)).toString() === '%PDF-')) throw new RuleError('Adapter Sign não retornou os dois arquivos em PDF.',502);
  if (docInfo.finalSha256 && sha256Hex(finalPdf) !== docInfo.finalSha256) throw new RuleError('Hash do PDF assinado diverge do informado pelo Adapter Sign.',502);
  const who = { userId: contract.sentBy ?? 'adapter-sign', displayName: 'Adapter Sign' };
  const existing = async (type: string, bytes: Uint8Array) => db.prepare('SELECT id FROM documents WHERE tenant_id = ? AND contract_id = ? AND type = ? AND sha256 = ? AND deleted_at IS NULL').bind(tenantId,contractId,type,sha256Hex(bytes)).first<{id:string}>();
  const signed = await existing('CONTRATO_ASSINADO',finalPdf) ?? await storeDocument(db, deps.storage, tenantId, { storeId: contract.storeId, customerId: contract.customerId, orderId: contract.orderId, contractId, type: 'CONTRATO_ASSINADO', description: `Contrato assinado (${contract.externalRef})`, originalFilename: `${contract.externalRef}-assinado.pdf`, bytes: finalPdf, source: 'adapter_sign' }, who, now);
  const evidence = await existing('EVIDENCIA_ASSINATURA',evidencePdf) ?? await storeDocument(db, deps.storage, tenantId, { storeId: contract.storeId, customerId: contract.customerId, orderId: contract.orderId, contractId, type: 'EVIDENCIA_ASSINATURA', description: `Relatório de evidências Adapter Sign (${contract.externalRef})`, originalFilename: `${contract.externalRef}-evidencias.pdf`, bytes: evidencePdf, source: 'adapter_sign' }, who, now);
  await db
   .prepare("UPDATE contracts SET internal_status = 'COMPLETED', signed_document_id = ?, evidence_document_id = ?, signed_sha256 = ?, completed_at = ?, last_error = '', updated_at = ? WHERE id = ?")
   .bind(signed.id, evidence.id, sha256Hex(finalPdf), now, now, contractId)
   .run();
  return 'COMPLETED';
 } catch (error) {
  await db.prepare("UPDATE contracts SET internal_status = 'CLIENT_SIGNED', last_error = ?, updated_at = ? WHERE id = ? AND internal_status = 'FINALIZING'").bind(error instanceof AdapterSignError ? friendlySignError(error) : 'Falha ao baixar o contrato assinado.', now, contractId).run();
  throw error;
 } finally {
  await db.prepare('UPDATE contracts SET processing_token = NULL, processing_until = NULL WHERE id = ? AND processing_token = ?').bind(contractId,processingToken).run();
 }
}

export async function refreshContractSignature(db: D1Database, tenantId: string, contractId: string, actor: Actor, deps: SignatureDeps, now = Date.now()): Promise<string> {
 requirePermission(actor.permissions, 'ORDER_VIEW');
 const contract = await loadContract(db, tenantId, contractId);
 requireStoreAccess(actor, contract.storeId);
 try {
  return await syncContract(db, tenantId, contractId, deps, now);
 } catch (error) {
  if (error instanceof AdapterSignError) throw new RuleError(friendlySignError(error), error.retryable ? 503 : 409);
  throw error;
 }
}

/**
 * Webhook: confere a assinatura HMAC com o corpo bruto, descarta evento repetido e só registra.
 * O processamento (consulta ao Adapter Sign + downloads) acontece fora da resposta.
 */
export async function receiveAdapterSignWebhook(db: D1Database, webhookKey: string, input: { signature: string; timestamp: string; eventId: string; rawBody: string }, now = Date.now()): Promise<{ status: number; eventRowId?: string; duplicate?: boolean }> {
 if (!/^[a-f0-9]{48}$/.test(webhookKey)) return { status: 404 };
 const config = await db.prepare(`${CONFIG_SELECT} WHERE webhook_key = ?`).bind(webhookKey).first<ConfigRow>();
 if (!config) return { status: 404 };
 if (!config.webhookSecretEnc) return { status: 401 };
 let secret: string;
 try { secret = decryptSecret(config.webhookSecretEnc); } catch { return { status: 500 }; }
 if (!verifyAdapterSignWebhook({ secret, signature: input.signature, timestamp: input.timestamp, eventId: input.eventId, rawBody: input.rawBody, nowMs: now })) return { status: 401 };
 let payload: { type?: string; data?: { envelope?: { id?: string; external_ref?: string } } };
 try { payload = JSON.parse(input.rawBody); } catch { return { status: 400 }; }
 const id = crypto.randomUUID();
 const inserted = await db
  .prepare('INSERT INTO adapter_sign_events (id, tenant_id, store_id, event_id, event_type, envelope_id, external_ref, status, received_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT (store_id, event_id) DO NOTHING')
  .bind(id, config.tenantId, config.storeId, input.eventId.slice(0, 200), String(payload.type ?? '').slice(0, 80), String(payload.data?.envelope?.id ?? '').slice(0, 80), String(payload.data?.envelope?.external_ref ?? '').slice(0, 200), 'RECEIVED', now)
  .run();
 if (inserted.meta.changes !== 1) return { status: 200, duplicate: true };
 return { status: 200, eventRowId: id };
}

/** Processa um evento recebido: localiza o contrato e sincroniza pelo Adapter Sign. */
export async function processAdapterSignEvent(db: D1Database, eventRowId: string, deps: SignatureDeps, now = Date.now()): Promise<void> {
 const ev = await db.prepare('SELECT id, tenant_id AS tenantId, store_id AS storeId, envelope_id AS envelopeId, external_ref AS externalRef, status FROM adapter_sign_events WHERE id = ?').bind(eventRowId).first<{ id: string; tenantId: string; storeId: string; envelopeId: string; externalRef: string; status: string }>();
 if (!ev || ev.status === 'PROCESSED' || ev.status === 'IGNORED') return;
 const contract = await db
  .prepare('SELECT id FROM contracts WHERE tenant_id = ? AND store_id = ? AND ((envelope_id IS NOT NULL AND envelope_id = ?) OR external_ref = ?) ORDER BY created_at DESC')
  .bind(ev.tenantId, ev.storeId, ev.envelopeId, ev.externalRef)
  .first<{ id: string }>();
 try {
  if (contract) await syncContract(db, ev.tenantId, contract.id, deps, now);
  await db.prepare("UPDATE adapter_sign_events SET status = ?, error = '', attempts = attempts + 1, processed_at = ? WHERE id = ?").bind(contract ? 'PROCESSED' : 'IGNORED', now, ev.id).run();
 } catch (error) {
  const message = error instanceof AdapterSignError ? friendlySignError(error) : error instanceof Error ? error.message : 'erro';
  await db.prepare("UPDATE adapter_sign_events SET status = 'FAILED', error = ?, attempts = attempts + 1 WHERE id = ?").bind(message.slice(0, 500), ev.id).run();
 }
}

/**
 * Reconciliação periódica (worker): eventos pendentes, envios com resultado incerto (SENDING) e
 * contratos aguardando assinatura sem notícia há algum tempo (caso um webhook se perca).
 */
export async function reconcileSignatures(db: D1Database, deps: SignatureDeps, now = Date.now()): Promise<{ events: number; resent: number; synced: number }> {
 const events = await db.prepare("SELECT id FROM adapter_sign_events WHERE status IN ('RECEIVED','FAILED') AND attempts < 10 ORDER BY received_at LIMIT 50").bind().all<{ id: string }>();
 for (const e of events.results ?? []) await processAdapterSignEvent(db, e.id, deps, now);
 const sending = await db.prepare("SELECT id, tenant_id AS tenantId FROM contracts WHERE internal_status = 'SENDING' AND (last_checked_at IS NULL OR last_checked_at < ?) AND send_attempts < 20 LIMIT 20").bind(now - 60_000).all<{ id: string; tenantId: string }>();
 let resent = 0;
 for (const c of sending.results ?? []) {
  try { await sendContractForSignature(db, c.tenantId, c.id, null, deps, now); resent++; } catch { /* erro já registrado no contrato */ }
 }
 const open = await db.prepare("SELECT id, tenant_id AS tenantId FROM contracts WHERE internal_status IN ('SENT','CLIENT_SIGNED','FINALIZING') AND (last_checked_at IS NULL OR last_checked_at < ?) LIMIT 50").bind(now - 10 * 60_000).all<{ id: string; tenantId: string }>();
 let synced = 0;
 for (const c of open.results ?? []) {
  try { await syncContract(db, c.tenantId, c.id, deps, now); synced++; } catch { /* registrado */ }
 }
 return { events: (events.results ?? []).length, resent, synced };
}
