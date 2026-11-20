import { database } from '@/db/database';
import { RuleError } from '@/lib/domain';
import { toRuleError } from '@/lib/errors';
import { resolveWorkspaceSession } from '@/lib/http/workspaceSession';
import { searchCustomers } from '@/lib/customers/service';
import { logger } from '@/lib/log';

export const dynamic = 'force-dynamic';
const reply = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'private, no-store' } });

/** Busca de clientes da conta logada: GET /api/customers?q=<texto>&limit=<1-50>&offset=<n>. */
export async function GET(request: Request) {
 try {
  const session = await resolveWorkspaceSession();
  if (!session) return reply({ error: 'Sessão encerrada. Entre novamente.', signIn: true }, 401);
  const params = new URL(request.url).searchParams;
  const q = (params.get('q') ?? '').slice(0, 120);
  const limit = Number(params.get('limit') ?? 20);
  const offset = Number(params.get('offset') ?? 0);
  const result = await searchCustomers(database(), session.tenantId, session.actor, { q, limit: Number.isFinite(limit) ? limit : 20, offset: Number.isFinite(offset) ? offset : 0 });
  return reply(result);
 } catch (error) {
  const known = toRuleError(error);
  if (known instanceof RuleError) return reply({ error: known.message }, known.status);
  const requestId = crypto.randomUUID();
  logger.error('clientes.busca.erro', { requestId, error });
  return reply({ error: 'Não foi possível buscar os clientes.', requestId }, 500);
 }
}
