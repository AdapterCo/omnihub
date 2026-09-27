import { createHmac, timingSafeEqual } from 'node:crypto';

// Cliente da API do Adapter Sign (docs/api.md e docs/integracao-sistema-vendas.md do próprio
// Adapter Sign; formatos de resposta conferidos no código-fonte do serviço). O fetch é injetável:
// nos testes entra um MOCK explicitamente identificado; em produção, o fetch global.
//
// Contratos usados:
// - POST /envelopes/from-template (multipart file + data) → 201 { id, status, externalRef,
//   validationCode, replayed, documents[{id, filename, originalSha256}], signers[{id, role, name,
//   email, status, signingUrl, signingUrlExpiresAt}] }. Idempotente por externalRef.
// - POST /envelopes/{id}/signers/{signerId}/link → { signerId, signingUrl, expiresAt }
// - GET /envelopes/{id} → { id, status, validationCode, externalRef, completedAt, documents[{id,
//   finalAvailable, finalSha256}], signers[{id, roleKey, status, signedAt, declinedAt}] }
// - GET /envelopes/{id}/documents/{envelopeDocumentId}/final e GET /envelopes/{id}/evidence → PDF
// - POST /envelopes/{id}/cancel { reason? } com Idempotency-Key
// Erros: { error: { code, message, request_id, details? } }.

export const ADAPTER_SIGN_API = 'https://sign.adapterco.com.br/api/v1';

export type SignFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string | FormData }) => Promise<{ status: number; text(): Promise<string>; arrayBuffer(): Promise<ArrayBuffer> }>;

export class AdapterSignError extends Error {
 readonly status: number;
 readonly code: string;
 readonly requestId: string;
 readonly details: unknown;
 // Instabilidade (rede, 429, 5xx) ou contrato sendo processado agora: pode repetir com o mesmo externalRef.
 readonly retryable: boolean;
 constructor(status: number, code: string, message: string, requestId = '', details: unknown = null) {
  super(message);
  this.name = 'AdapterSignError';
  this.status = status;
  this.code = code;
  this.requestId = requestId;
  this.details = details;
  this.retryable = status === 0 || status === 429 || status >= 500 || code === 'CONTRACT_IN_PROGRESS';
 }
}

export type ContractSigner = { role: string; name: string; email: string; externalId?: string; cpf?: string; phone?: string };
export type SentEnvelope = {
 id: string; status: string; externalRef: string; validationCode: string | null; replayed: boolean;
 documents: { id: string; filename: string; originalSha256: string }[];
 signers: { id: string; role: string; name: string; status: string; signingUrl: string | null; signingUrlExpiresAt: string | null }[];
};
export type EnvelopeDetail = {
 id: string; status: string; externalRef: string | null; validationCode: string | null; completedAt: string | null;
 documents: { id: string; finalAvailable: boolean; finalSha256: string | null }[];
 signers: { id: string; roleKey: string | null; status: string; signedAt: string | null; declinedAt: string | null }[];
};

export class AdapterSignClient {
 private readonly apiKey: string;
 private readonly fetchImpl: SignFetch;
 private readonly baseUrl: string;
 constructor(apiKey: string, fetchImpl: SignFetch, baseUrl = ADAPTER_SIGN_API) {
  this.apiKey = apiKey;
  this.fetchImpl = fetchImpl;
  this.baseUrl = baseUrl.replace(/\/+$/, '');
 }

 private async call(method: string, path: string, body?: string | FormData, extraHeaders: Record<string, string> = {}) {
  const headers: Record<string, string> = { Authorization: `Bearer ${this.apiKey}`, Accept: 'application/json', ...extraHeaders };
  if (typeof body === 'string') headers['Content-Type'] = 'application/json';
  try {
   return await this.fetchImpl(`${this.baseUrl}${path}`, { method, headers, body });
  } catch {
   throw new AdapterSignError(0, 'NETWORK', 'Não foi possível falar com o Adapter Sign (rede).');
  }
 }

 private async json<T>(res: Awaited<ReturnType<SignFetch>>): Promise<T> {
  const text = await res.text();
  let parsed: unknown = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
  if (res.status >= 200 && res.status < 300) return parsed as T;
  const raw = (parsed as { error?: unknown } | null)?.error;
  // Formato de erro da API: { error: { code, message, request_id } }. Qualquer outra coisa (página
  // HTML, { "error": "Not found" } do front-end web) significa que a API não respondeu nesse
  // endereço (fora do ar ou endereço errado) — nada foi processado pelo Adapter Sign.
  const err = raw && typeof raw === 'object' && typeof (raw as { code?: unknown }).code === 'string' ? (raw as { code: string; message?: string; request_id?: string; details?: unknown }) : null;
  if (!err) throw new AdapterSignError(res.status, `HTTP_${res.status}`, `O Adapter Sign não respondeu como API no endereço ${this.baseUrl} (HTTP ${res.status}). Confira se o serviço está no ar e se o endereço (ADAPTER_SIGN_BASE_URL) está correto. Nada foi enviado.`);
  throw new AdapterSignError(res.status, err.code ?? `HTTP_${res.status}`, err.message ?? `Adapter Sign respondeu HTTP ${res.status}.`, err.request_id ?? '', err.details ?? null);
 }

 async sendFromTemplate(pdf: Uint8Array, filename: string, data: { template: string; externalRef: string; title: string; representing?: string; signers: ContractSigner[] }): Promise<SentEnvelope> {
  const form = new FormData();
  form.append('file', new Blob([Buffer.from(pdf)], { type: 'application/pdf' }), filename);
  form.append('data', JSON.stringify(data));
  return this.json<SentEnvelope>(await this.call('POST', '/envelopes/from-template', form));
 }

 async issueLink(envelopeId: string, signerId: string): Promise<{ signerId: string; signingUrl: string; expiresAt: string }> {
  return this.json(await this.call('POST', `/envelopes/${encodeURIComponent(envelopeId)}/signers/${encodeURIComponent(signerId)}/link`));
 }

 async getEnvelope(envelopeId: string): Promise<EnvelopeDetail> {
  return this.json(await this.call('GET', `/envelopes/${encodeURIComponent(envelopeId)}`));
 }

 async cancelEnvelope(envelopeId: string, reason: string, idempotencyKey: string): Promise<void> {
  await this.json(await this.call('POST', `/envelopes/${encodeURIComponent(envelopeId)}/cancel`, JSON.stringify({ reason }), { 'Idempotency-Key': idempotencyKey }));
 }

 private async pdf(path: string): Promise<Uint8Array> {
  const res = await this.call('GET', path, undefined, { Accept: 'application/pdf' });
  if (res.status < 200 || res.status >= 300) await this.json(res);
  return new Uint8Array(await res.arrayBuffer());
 }
 finalDocument(envelopeId: string, envelopeDocumentId: string) { return this.pdf(`/envelopes/${encodeURIComponent(envelopeId)}/documents/${encodeURIComponent(envelopeDocumentId)}/final`); }
 evidence(envelopeId: string) { return this.pdf(`/envelopes/${encodeURIComponent(envelopeId)}/evidence`); }
}

/**
 * Verificação do webhook (api.md, "Verificação da assinatura"):
 *   X-Adapter-Signature: v1=hex(HMAC_SHA256(secret, `${timestamp}.${eventId}.${rawBody}`))
 * com janela anti-replay de 300 s sobre X-Adapter-Timestamp (segundos). Corpo BRUTO, sem reserializar.
 */
export function verifyAdapterSignWebhook(params: { secret: string; signature: string; timestamp: string; eventId: string; rawBody: string; nowMs?: number }): boolean {
 const ts = Number(params.timestamp);
 const now = Math.floor((params.nowMs ?? Date.now()) / 1000);
 if (!Number.isInteger(ts) || Math.abs(now - ts) > 300 || !params.eventId) return false;
 const expected = 'v1=' + createHmac('sha256', params.secret).update(`${ts}.${params.eventId}.${params.rawBody}`).digest('hex');
 const got = String(params.signature ?? '');
 return got.length === expected.length && timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}
