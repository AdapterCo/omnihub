import { getCurrentUser, isSameOrigin } from '@/app/auth';
import { database } from '@/db/database';
import { RuleError } from '@/lib/domain';
import { getPlatformOverview, savePlatformPlan, setAdminMaxStores } from '@/lib/subscriptions/service';
import { readJsonLimited, BodyTooLargeError } from '@/lib/http/body';
import { logger } from '@/lib/log';

export const dynamic = 'force-dynamic';
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } });

// Painel do administrador da plataforma (e-mails em PLATFORM_ADMIN_EMAILS): planos, limite de lojas
// das contas dos administradores e situação de todas as contas. A permissão é conferida aqui no
// servidor a cada chamada (lib/subscriptions/service.ts), nunca pela tela.
export async function GET() {
 try {
  const user = await getCurrentUser();
  if (!user) return reply({ error: 'Entre na sua conta.', signIn: true }, 401);
  return reply(await getPlatformOverview(database(), user.email));
 } catch (error) {
  if (error instanceof RuleError) return reply({ error: error.message }, error.status);
  const requestId = crypto.randomUUID();
  logger.error('plataforma.consulta.erro', { requestId, error });
  return reply({ error: 'Não foi possível carregar o painel.', requestId }, 500);
 }
}

export async function POST(request: Request) {
 try {
  if (!isSameOrigin(request)) return reply({ error: 'Origem inválida.' }, 403);
  const user = await getCurrentUser();
  if (!user) return reply({ error: 'Entre na sua conta.', signIn: true }, 401);
  const body = await readJsonLimited<{ action?: unknown; id?: unknown; name?: unknown; priceCents?: unknown; maxStores?: unknown; active?: unknown; value?: unknown }>(request, 4 * 1024);
  if (!body) return reply({ error: 'Dados inválidos.' }, 400);
  const db = database();
  if (body.action === 'savePlan') {
   await savePlatformPlan(db, user.email, { id: typeof body.id === 'string' && body.id ? body.id : undefined, name: body.name, priceCents: body.priceCents, maxStores: body.maxStores, active: body.active });
  } else if (body.action === 'adminMaxStores') {
   await setAdminMaxStores(db, user.email, body.value);
  } else {
   return reply({ error: 'Ação inválida.' }, 400);
  }
  return reply(await getPlatformOverview(db, user.email));
 } catch (error) {
  if (error instanceof BodyTooLargeError) return reply({ error: error.message }, 413);
  if (error instanceof RuleError) return reply({ error: error.message }, error.status);
  const requestId = crypto.randomUUID();
  logger.error('plataforma.acao.erro', { requestId, error });
  return reply({ error: 'Não foi possível concluir. Tente novamente.', requestId }, 500);
 }
}
