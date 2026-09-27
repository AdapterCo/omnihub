import { isSameOrigin } from '@/app/auth';
import { database } from '@/db/database';
import { RuleError, requireActive } from '@/lib/domain';
import { resolveWorkspaceSession } from '@/lib/http/workspaceSession';
import { sendContractForSignature, newSigningLink, cancelSignature, refreshContractSignature } from '@/lib/signature/service';
import { signatureDepsFromEnv } from '@/lib/signature/worker';
import { recordAudit } from '@/lib/audit/service';
import { logger } from '@/lib/log';

export const dynamic = 'force-dynamic';
const reply = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'private, no-store' } });

// Ações de assinatura do contrato. Ficam fora de /api/workspace de propósito: a resposta do envio
// e do link novo traz o signingUrl do cliente, que é credencial temporária e NÃO pode ser gravado
// (a idempotência de /api/workspace guarda o resultado de cada comando). A idempotência do envio
// é a do próprio Adapter Sign, pelo externalRef do contrato.
export async function POST(request: Request, { params }: { params: Promise<{ id: string; action: string }> }) {
 try {
  if (!isSameOrigin(request)) return reply({ error: 'Origem da solicitação inválida.' }, 403);
  const { id, action } = await params;
  if (!/^[A-Za-z0-9-]{1,80}$/.test(id)) return reply({ error: 'Contrato inválido.' }, 400);
  const session = await resolveWorkspaceSession();
  if (!session) return reply({ error: 'Sessão encerrada. Entre novamente.', signIn: true }, 401);
  const db = database();
  const { tenantId, actor } = session;
  const audit = (description: string, after?: unknown) => recordAudit(db, { tenantId, userId: actor.userId, operator: actor.displayName, action: `signature.${action}`, description, entity: 'contract', entityId: id, after });
  if (action === 'refresh') {
   const status = await refreshContractSignature(db, tenantId, id, actor, signatureDepsFromEnv());
   return reply({ status });
  }
  requireActive(session.plan, Date.now());
  if (action === 'send') {
   const result = await sendContractForSignature(db, tenantId, id, actor, signatureDepsFromEnv());
   await audit(result.replayed ? 'Contrato reenviado ao Adapter Sign (mesmo envelope, link novo)' : 'Contrato enviado ao Adapter Sign (assinado pela loja em nome do vendedor)', { replayed: result.replayed });
   return reply(result);
  }
  if (action === 'link') {
   const link = await newSigningLink(db, tenantId, id, actor, signatureDepsFromEnv());
   await audit('Link novo de assinatura gerado para o cliente');
   return reply(link);
  }
  if (action === 'cancel') {
   const body = (await request.json().catch(() => ({}))) as { reason?: string };
   await cancelSignature(db, tenantId, id, String(body.reason ?? ''), actor, signatureDepsFromEnv());
   await audit(`Assinatura cancelada no Adapter Sign: ${String(body.reason ?? '').trim()}`);
   return reply({ ok: true });
  }
  return reply({ error: 'Ação inválida.' }, 404);
 } catch (error) {
  if (error instanceof RuleError) return reply({ error: error.message }, error.status);
  const requestId = crypto.randomUUID();
  logger.error('signature.acao.erro', { requestId, error });
  return reply({ error: 'Não foi possível concluir a operação de assinatura. Tente novamente.', requestId }, 500);
 }
}
