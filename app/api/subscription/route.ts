import { isSameOrigin } from '@/app/auth';
import { database } from '@/db/database';
import { resolveWorkspaceSession } from '@/lib/http/workspaceSession';
import { RuleError } from '@/lib/domain';
import { cancelAccountSubscription, getSubscriptionPage, refreshAccountSubscription, startSubscription, subscriptionDepsFromEnv } from '@/lib/subscriptions/service';
import { readJsonLimited, BodyTooLargeError } from '@/lib/http/body';
import { logger } from '@/lib/log';

export const dynamic = 'force-dynamic';
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } });

// Assinatura da conta (tela "Assinatura"): planos disponíveis, situação, assinar (devolve o link
// de pagamento do Mercado Pago) e cancelar. Não exige acesso vigente — é por aqui que se regulariza.
async function view(tenantId: string, plan: { status: string; accessUntil: number; maxStores: number }) {
 return { ...(await getSubscriptionPage(database(), tenantId)), access: plan };
}

export async function GET(request: Request) {
 try {
  const session = await resolveWorkspaceSession();
  if (!session) return reply({ error: 'Entre na sua conta.', signIn: true }, 401);
  if (new URL(request.url).searchParams.get('refresh') === '1') {
   await refreshAccountSubscription(database(), session.tenantId, subscriptionDepsFromEnv());
   const fresh = await resolveWorkspaceSession();
   if (fresh) return reply(await view(fresh.tenantId, fresh.plan));
  }
  return reply(await view(session.tenantId, session.plan));
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
  const body = await readJsonLimited<{ action?: unknown; planId?: unknown; payerEmail?: unknown }>(request, 4 * 1024);
  if (!body) return reply({ error: 'Dados inválidos.' }, 400);
  const db = database();
  const deps = subscriptionDepsFromEnv();
  if (body.action === 'start') {
   const result = await startSubscription(db, session.tenantId, session.actor, { planId: body.planId, payerEmail: body.payerEmail }, deps);
   return reply({ initPoint: result.initPoint });
  }
  if (body.action === 'cancel') {
   await cancelAccountSubscription(db, session.tenantId, session.actor, deps);
   const fresh = await resolveWorkspaceSession();
   return reply(await view(session.tenantId, fresh?.plan ?? session.plan));
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
