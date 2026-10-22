import { isSameOrigin } from '@/app/auth';
import { database } from '@/db/database';
import { RuleError, requireActive } from '@/lib/domain';
import { resolveWorkspaceSession } from '@/lib/http/workspaceSession';
import { readJsonLimited, BodyTooLargeError } from '@/lib/http/body';
import { storageFromEnv } from '@/lib/storage';
import { recordAudit } from '@/lib/audit/service';
import { logger } from '@/lib/log';
import { checklistTemplateForOrder, generateChecklist, type ChecklistInput } from '@/lib/checklists/service';

export const dynamic = 'force-dynamic';
const reply = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'private, no-store' } });
const ID = /^[A-Za-z0-9-]{1,80}$/;

function failure(error: unknown, event: string, message: string) {
 if (error instanceof BodyTooLargeError) return reply({ error: error.message }, 413);
 if (error instanceof RuleError) return reply({ error: error.message }, error.status);
 const requestId = crypto.randomUUID();
 logger.error(event, { requestId, error });
 return reply({ error: message, requestId }, 500);
}

/** Checklist de entrega que vale para o pedido (itens para marcar). */
export async function GET(_request: Request, { params }: { params: Promise<{ orderId: string }> }) {
 try {
  const { orderId } = await params;
  if (!ID.test(orderId)) return reply({ error: 'Pedido inválido.' }, 400);
  const session = await resolveWorkspaceSession();
  if (!session) return reply({ error: 'Sessão encerrada. Entre novamente.', signIn: true }, 401);
  return reply({ template: await checklistTemplateForOrder(database(), session.tenantId, orderId, session.actor) });
 } catch (error) {
  return failure(error, 'checklists.pedido.erro', 'Não foi possível carregar o checklist.');
 }
}

/** Gera o checklist da entrega com os itens marcados ({ checked: ["0:1", ...], observations, templateUpdatedAt }). */
export async function POST(request: Request, { params }: { params: Promise<{ orderId: string }> }) {
 try {
  if (!isSameOrigin(request)) return reply({ error: 'Origem da solicitação inválida.' }, 403);
  const { orderId } = await params;
  if (!ID.test(orderId)) return reply({ error: 'Pedido inválido.' }, 400);
  const session = await resolveWorkspaceSession();
  if (!session) return reply({ error: 'Sessão encerrada. Entre novamente.', signIn: true }, 401);
  requireActive(session.plan, Date.now());
  const body = (await readJsonLimited<ChecklistInput>(request, 64 * 1024)) ?? {};
  const db = database();
  const result = await generateChecklist(db, storageFromEnv(), session.tenantId, orderId, body, session.actor);
  await recordAudit(db, { tenantId: session.tenantId, userId: session.actor.userId, operator: session.actor.displayName, action: 'checklist.generate', description: `Checklist de entrega gerado (${result.externalRef})`, entity: 'order', entityId: orderId, after: result });
  return reply(result);
 } catch (error) {
  return failure(error, 'checklists.gerar.erro', 'Não foi possível gerar o checklist. Tente novamente.');
 }
}
