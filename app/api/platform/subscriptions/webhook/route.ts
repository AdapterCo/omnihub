import { database } from '@/db/database';
import { verifyMercadoPagoSignature } from '@/lib/payments/mercadopago';
import { handlePlatformWebhook, subscriptionDepsFromEnv } from '@/lib/subscriptions/service';
import { readJsonLimited } from '@/lib/http/body';
import { logger } from '@/lib/log';

export const dynamic = 'force-dynamic';

// Webhook das assinaturas da plataforma (tópicos "subscription_preapproval" e
// "subscription_authorized_payment"), configurado na aplicação Mercado Pago da empresa com esta URL.
// Público por natureza: a autenticidade vem da x-signature (HMAC com PLATFORM_MP_WEBHOOK_SECRET).
// O corpo não decide nada — o acesso só muda por consulta autenticada ao Mercado Pago.
export async function POST(request: Request) {
 const url = new URL(request.url);
 let body: { type?: unknown; data?: { id?: unknown } } | null = null;
 try {
  body = await readJsonLimited(request, 64 * 1024);
 } catch {
  body = null;
 }
 const dataId = url.searchParams.get('data.id') ?? (body?.data?.id !== undefined ? String(body.data.id) : null);
 const type = url.searchParams.get('type') ?? (typeof body?.type === 'string' ? body.type : null);
 const signatureOk = verifyMercadoPagoSignature({
  xSignature: request.headers.get('x-signature'),
  xRequestId: request.headers.get('x-request-id'),
  dataId: url.searchParams.get('data.id'),
  secret: (process.env.PLATFORM_MP_WEBHOOK_SECRET ?? '').trim(),
 });
 try {
  const status = await handlePlatformWebhook(database(), { type, dataId, signatureOk }, subscriptionDepsFromEnv());
  return Response.json({ ok: status === 200 }, { status, headers: { 'Cache-Control': 'no-store' } });
 } catch (error) {
  logger.error('assinatura.webhook.erro', { error, type });
  return Response.json({ ok: false }, { status: 500 });
 }
}
