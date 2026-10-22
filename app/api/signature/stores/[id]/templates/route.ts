import { database } from '@/db/database';
import { RuleError } from '@/lib/domain';
import { resolveWorkspaceSession } from '@/lib/http/workspaceSession';
import { listSignatureTemplates } from '@/lib/signature/service';
import { signatureDepsFromEnv } from '@/lib/signature/worker';
import { logger } from '@/lib/log';

export const dynamic = 'force-dynamic';
const reply = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'private, no-store' } });

/** Modelos de assinatura do Adapter Sign da loja (busca ao vivo com a API key salva da loja). */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
 try {
  const { id } = await params;
  if (!/^[A-Za-z0-9-]{1,80}$/.test(id)) return reply({ error: 'Loja inválida.' }, 400);
  const session = await resolveWorkspaceSession();
  if (!session) return reply({ error: 'Sessão encerrada. Entre novamente.', signIn: true }, 401);
  const templates = await listSignatureTemplates(database(), session.tenantId, id, session.actor, signatureDepsFromEnv());
  return reply({ templates });
 } catch (error) {
  if (error instanceof RuleError) return reply({ error: error.message }, error.status);
  const requestId = crypto.randomUUID();
  logger.error('signature.modelos.erro', { requestId, error });
  return reply({ error: 'Não foi possível buscar os modelos do Adapter Sign.', requestId }, 500);
 }
}
