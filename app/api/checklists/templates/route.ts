import { isSameOrigin } from '@/app/auth';
import { database } from '@/db/database';
import { RuleError, requireActive } from '@/lib/domain';
import { resolveWorkspaceSession } from '@/lib/http/workspaceSession';
import { readJsonLimited, BodyTooLargeError } from '@/lib/http/body';
import { recordAudit } from '@/lib/audit/service';
import { logger } from '@/lib/log';
import { CONTRACT_FIELDS } from '@/lib/contracts/fields';
import { listChecklistTemplates, saveChecklistTemplate, type ChecklistTemplateInput } from '@/lib/checklists/service';

export const dynamic = 'force-dynamic';
const reply = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'private, no-store' } });

/** Checklist de entrega da loja (Minhas lojas > Checklist de entrega). */
export async function GET(request: Request) {
 try {
  const session = await resolveWorkspaceSession();
  if (!session) return reply({ error: 'Sessão encerrada. Entre novamente.', signIn: true }, 401);
  const storeId = new URL(request.url).searchParams.get('storeId') ?? '';
  if (!/^[A-Za-z0-9-]{1,80}$/.test(storeId)) return reply({ error: 'Loja inválida.' }, 400);
  const templates = await listChecklistTemplates(database(), session.tenantId, storeId, session.actor);
  return reply({ templates, fields: CONTRACT_FIELDS });
 } catch (error) {
  if (error instanceof RuleError) return reply({ error: error.message }, error.status);
  const requestId = crypto.randomUUID();
  logger.error('checklists.modelos.erro', { requestId, error });
  return reply({ error: 'Não foi possível carregar o checklist da loja.', requestId }, 500);
 }
}

export async function POST(request: Request) {
 try {
  if (!isSameOrigin(request)) return reply({ error: 'Origem da solicitação inválida.' }, 403);
  const session = await resolveWorkspaceSession();
  if (!session) return reply({ error: 'Sessão encerrada. Entre novamente.', signIn: true }, 401);
  requireActive(session.plan, Date.now());
  const body = (await readJsonLimited<ChecklistTemplateInput>(request, 64 * 1024)) ?? {};
  const db = database();
  await saveChecklistTemplate(db, session.tenantId, body, session.actor);
  await recordAudit(db, { tenantId: session.tenantId, userId: session.actor.userId, operator: session.actor.displayName, action: 'checklist_template.save', description: `Checklist de entrega da loja salvo (${body.orderType === 'VENDA' ? 'venda' : 'locação'})`, entity: 'store', entityId: String(body.storeId ?? '') });
  return reply({ ok: true });
 } catch (error) {
  if (error instanceof BodyTooLargeError) return reply({ error: error.message }, 413);
  if (error instanceof RuleError) return reply({ error: error.message }, error.status);
  const requestId = crypto.randomUUID();
  logger.error('checklists.salvar.erro', { requestId, error });
  return reply({ error: 'Não foi possível salvar. Tente novamente.', requestId }, 500);
 }
}
