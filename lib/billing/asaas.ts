import { RuleError } from '../errors.ts';

// API v3 (docs.asaas.com/reference): header access_token; sandbox em api-sandbox.asaas.com.
// Não presumir idempotência no POST /payments: antes de criar, consulta por externalReference.
export type BillingFetch = typeof globalThis.fetch;
export type AsaasPayment = { id: string; customer: string; externalReference: string; value: number; originalValue?: number; dueDate: string; status: string; deleted?: boolean; bankSlipUrl?: string; invoiceUrl?: string };
export class AsaasError extends RuleError {
 readonly uncertain: boolean;
 constructor(message: string, uncertain: boolean) { super(message, uncertain ? 503 : 422); this.uncertain = uncertain; }
}
export class AsaasClient {
 private key: string;
 private base: string;
 private fetcher: BillingFetch;
 constructor(key: string, environment: string, fetcher: BillingFetch = fetch) {
  if (!['SANDBOX','PRODUCTION'].includes(environment)) throw new RuleError('Ambiente Asaas não configurado.', 409);
  this.key = key; this.base = environment === 'SANDBOX' ? 'https://api-sandbox.asaas.com/v3' : 'https://api.asaas.com/v3'; this.fetcher = fetcher;
 }
 async call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let response: Response;
  try { response = await this.fetcher(this.base + path, { method, headers: { access_token: this.key, 'User-Agent': 'OmniHub', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000), redirect: 'error' }); }
  catch { throw new AsaasError('Comunicação incerta com o Asaas. Consulte a cobrança antes de qualquer novo envio.', true); }
  const parsed = await response.json().catch(() => null);
  if (!response.ok) {
   // Não ecoar o payload/segredo nem dados pessoais de erros remotos.
   throw new AsaasError(`Asaas recusou a operação (HTTP ${response.status}). Confira os dados e a configuração da conta.`, response.status >= 500 || response.status === 429);
  }
  if (!parsed || typeof parsed !== 'object') throw new AsaasError('Resposta inválida do Asaas; resultado desconhecido.', true);
  return parsed as T;
 }
 findPayment(ref: string) { return this.call<{data: AsaasPayment[]; hasMore: boolean}>('GET', '/payments?limit=100&externalReference=' + encodeURIComponent(ref)); }
 getPayment(id: string) { return this.call<AsaasPayment>('GET', '/payments/' + encodeURIComponent(id)); }
 createPayment(body: unknown) { return this.call<AsaasPayment>('POST', '/payments', body); }
 async cancelPayment(id: string) {
  const result = await this.call<{deleted: boolean}>('DELETE', '/payments/' + encodeURIComponent(id));
  if (result.deleted !== true) throw new AsaasError('Cancelamento ainda não confirmado pelo Asaas.', true);
 }
}
