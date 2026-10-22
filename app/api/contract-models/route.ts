import { isSameOrigin } from '@/app/auth';
import { database } from '@/db/database';
import { RuleError, requireActive } from '@/lib/domain';
import { resolveWorkspaceSession } from '@/lib/http/workspaceSession';
import { readJsonLimited, BodyTooLargeError } from '@/lib/http/body';
import { storageFromEnv } from '@/lib/storage';
import { recordAudit } from '@/lib/audit/service';
import { logger } from '@/lib/log';
import { CONTRACT_FIELDS } from '@/lib/contracts/fields';
import { archiveContractModel, listContractModels, newContractModelVersion, publishContractModel, saveContractModel, type ContractModelInput } from '@/lib/contracts/models';

export const dynamic = 'force-dynamic';
const reply = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'private, no-store' } });
const ID = /^[A-Za-z0-9-]{1,80}$/;

/** Modelos de contrato da loja (Minhas lojas > Modelos de contrato). */
export async function GET(request: Request) {
 try {
  const session = await resolveWorkspaceSession();
  if (!session) return reply({ error: 'Sessão encerrada. Entre novamente.', signIn: true }, 401);
  const storeId = new URL(request.url).searchParams.get('storeId') ?? '';
  if (!ID.test(storeId)) return reply({ error: 'Loja inválida.' }, 400);
  const models = await listContractModels(database(), session.tenantId, storeId, session.actor);
  return reply({ models, fields: CONTRACT_FIELDS });
 } catch (error) {
  if (error instanceof RuleError) return reply({ error: error.message }, error.status);
  const requestId = crypto.randomUUID();
  logger.error('contract-models.consulta.erro', { requestId, error });
  return reply({ error: 'Não foi possível carregar os modelos de contrato.', requestId }, 500);
 }
}

export async function POST(request: Request) {
 try {
  if (!isSameOrigin(request)) return reply({ error: 'Origem da solicitação inválida.' }, 403);
  const session = await resolveWorkspaceSession();
  if (!session) return reply({ error: 'Sessão encerrada. Entre novamente.', signIn: true }, 401);
  requireActive(session.plan, Date.now());
  const body = (await readJsonLimited<Record<string, unknown>>(request, 300 * 1024)) ?? {};
  const db = database();
  const { tenantId, actor } = session;
  const id = String(body.id ?? '');
  const audit = (action: string, description: string, entityId: string, after?: unknown) => recordAudit(db, { tenantId, userId: actor.userId, operator: actor.displayName, action, description, entity: 'contract_model', entityId, after });
  if (body.action === 'save') {
   const saved = await saveContractModel(db, tenantId, body as ContractModelInput, actor);
   await audit('contract_model.save', `Modelo de contrato salvo (rascunho): ${String(body.name ?? '').trim()}`, saved);
   return reply({ id: saved });
  }
  if (!ID.test(id)) return reply({ error: 'Modelo inválido.' }, 400);
  if (body.action === 'publish') {
   await publishContractModel(db, storageFromEnv(), tenantId, id, { confirmFixedData: body.confirmFixedData === true }, actor);
   await audit('contract_model.publish', 'Modelo de contrato publicado (passa a ser usado nos novos contratos)', id, { confirmFixedData: body.confirmFixedData === true });
   return reply({ ok: true });
  }
  if (body.action === 'newVersion') {
   const newId = await newContractModelVersion(db, tenantId, id, actor);
   await audit('contract_model.version', 'Nova versão (rascunho) do modelo de contrato', newId, { from: id });
   return reply({ id: newId });
  }
  if (body.action === 'archive') {
   await archiveContractModel(db, tenantId, id, actor);
   await audit('contract_model.archive', 'Modelo de contrato arquivado', id);
   return reply({ ok: true });
  }
  return reply({ error: 'Ação inválida.' }, 400);
 } catch (error) {
  if (error instanceof BodyTooLargeError) return reply({ error: error.message }, 413);
  if (error instanceof RuleError) return reply({ error: error.message }, error.status);
  const requestId = crypto.randomUUID();
  logger.error('contract-models.acao.erro', { requestId, error });
  return reply({ error: 'Não foi possível concluir. Tente novamente.', requestId }, 500);
 }
}
