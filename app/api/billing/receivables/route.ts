import { database } from '@/db/database';
import { resolveWorkspaceSession } from '@/lib/http/workspaceSession';
import { RuleError } from '@/lib/domain';
import { listReceivablesOverview, customerReminders, type ReceivableFilter } from '@/lib/billing/service';
import { logger } from '@/lib/log';
export const dynamic = 'force-dynamic';
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } });

// Controle de boletos/inadimplência (GET ?filter=overdue|open|paid|all) e lembretes do Asaas
// configurados para o cliente de uma cobrança (GET ?reminders=<receivableId>). Somente leitura.
export async function GET(request: Request) {
 try {
  const session = await resolveWorkspaceSession();
  if (!session) return reply({ error: 'Entre na sua conta.' }, 401);
  const url = new URL(request.url);
  const reminders = url.searchParams.get('reminders');
  if (reminders) return reply(await customerReminders(database(), session.tenantId, reminders, session.actor));
  return reply(await listReceivablesOverview(database(), session.tenantId, session.actor, (url.searchParams.get('filter') ?? 'overdue') as ReceivableFilter));
 } catch (error) {
  if (error instanceof RuleError) return reply({ error: error.message }, error.status);
  logger.error('billing.receivables.erro', { error });
  return reply({ error: 'Não foi possível consultar as cobranças.' }, 500);
 }
}
