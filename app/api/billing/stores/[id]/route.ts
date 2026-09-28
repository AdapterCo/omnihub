import { isSameOrigin } from '@/app/auth';
import { database } from '@/db/database';
import { resolveWorkspaceSession } from '@/lib/http/workspaceSession';
import { RuleError, requireActive } from '@/lib/domain';
import { getBillingConfigSummary, saveBillingConfig } from '@/lib/billing/service';
import { readJsonLimited, BodyTooLargeError } from '@/lib/http/body';
import { logger } from '@/lib/log';

export const dynamic = 'force-dynamic';
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } });

// Configuração do Asaas (boletos dos pedidos) por loja: Minhas lojas > Boletos (Asaas).
// A API key e o token do webhook são gravados cifrados e nunca voltam para a tela.
async function handle(request: Request, context: { params: Promise<{ id: string }> }, mutate: boolean) {
 try {
  if (mutate && !isSameOrigin(request)) return reply({ error: 'Origem inválida.' }, 403);
  const session = await resolveWorkspaceSession();
  if (!session) return reply({ error: 'Entre na sua conta.', signIn: true }, 401);
  const { id } = await context.params;
  if (!/^[A-Za-z0-9-]{1,80}$/.test(id)) return reply({ error: 'Loja inválida.' }, 400);
  const db = database();
  if (mutate) {
   requireActive(session.plan, Date.now());
   const body = await readJsonLimited<{ environment?: unknown; apiKey?: unknown; webhookSecret?: unknown; notificationsEnabled?: unknown }>(request, 8 * 1024);
   if (!body) return reply({ error: 'Dados inválidos.' }, 400);
   await saveBillingConfig(db, session.tenantId, id, {
    environment: String(body.environment ?? ''),
    apiKey: typeof body.apiKey === 'string' ? body.apiKey : undefined,
    webhookSecret: typeof body.webhookSecret === 'string' ? body.webhookSecret : undefined,
    notificationsEnabled: body.notificationsEnabled as boolean,
   }, session.actor);
  }
  return reply(await getBillingConfigSummary(db, session.tenantId, id, session.actor));
 } catch (error) {
  if (error instanceof BodyTooLargeError) return reply({ error: error.message }, 413);
  if (error instanceof RuleError) return reply({ error: error.message }, error.status);
  const requestId = crypto.randomUUID();
  logger.error('billing.config.erro', { requestId, error });
  return reply({ error: 'Não foi possível concluir. Tente novamente.', requestId }, 500);
 }
}
export const GET = (r: Request, c: { params: Promise<{ id: string }> }) => handle(r, c, false);
export const POST = (r: Request, c: { params: Promise<{ id: string }> }) => handle(r, c, true);
