import { isSameOrigin } from '@/app/auth';
import { database } from '@/db/database';
import { resolveWorkspaceSession } from '@/lib/http/workspaceSession';
import { RuleError } from '@/lib/domain';
import { cancelRenewal, checkInvoice, choosePlan, getSubscriptionPage, payInvoice, subscriptionDepsFromEnv } from '@/lib/subscriptions/service';
import { readJsonLimited, BodyTooLargeError } from '@/lib/http/body';
import { logger } from '@/lib/log';

export const dynamic = 'force-dynamic';
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } });

// Plano da conta (modelo do Adapter Connect): escolher o plano e pagar na tela por Pix ou cartão.
// Não exige acesso vigente — é por aqui que se ativa ou regulariza.
export async function GET(request: Request) {
 try {
  const session = await resolveWorkspaceSession();
  if (!session) return reply({ error: 'Entre na sua conta.', signIn: true }, 401);
  const invoiceId = new URL(request.url).searchParams.get('invoice');
  if (invoiceId) {
   const invoice = await checkInvoice(database(), session.tenantId, invoiceId, subscriptionDepsFromEnv());
   const fresh = await resolveWorkspaceSession();
   return reply({ invoice, access: fresh?.plan ?? session.plan });
  }
  return reply({ ...(await getSubscriptionPage(database(), session.tenantId)), access: session.plan });
 } catch (error) {
  if (error instanceof RuleError) return reply({ error: error.message }, error.status);
  const requestId = crypto.randomUUID();
  logger.error('assinatura.consulta.erro', { requestId, error });
  return reply({ error: 'Não foi possível consultar a assinatura.', requestId }, 500);
 }
}

export async function POST(request: Request) {
 try {
  if (!isSameOrigin(request)) return reply({ error: 'Origem inválida.' }, 403);
  const session = await resolveWorkspaceSession();
  if (!session) return reply({ error: 'Entre na sua conta.', signIn: true }, 401);
  const body = await readJsonLimited<Record<string, unknown>>(request, 8 * 1024);
  if (!body) return reply({ error: 'Dados inválidos.' }, 400);
  const db = database();
  if (body.action === 'choose') return reply({ invoice: await choosePlan(db, session.tenantId, session.actor, body.planId) });
  if (body.action === 'pay') return reply(await payInvoice(db, session.tenantId, String(body.invoiceId ?? ''), body, subscriptionDepsFromEnv()));
  if (body.action === 'cancel') {
   await cancelRenewal(db, session.tenantId, session.actor);
   return reply({ ok: true });
  }
  return reply({ error: 'Ação inválida.' }, 400);
 } catch (error) {
  if (error instanceof BodyTooLargeError) return reply({ error: error.message }, 413);
  if (error instanceof RuleError) return reply({ error: error.message }, error.status);
  const requestId = crypto.randomUUID();
  logger.error('assinatura.acao.erro', { requestId, error });
  return reply({ error: 'Não foi possível concluir. Tente novamente.', requestId }, 500);
 }
}
