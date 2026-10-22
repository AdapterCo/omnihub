import { isSameOrigin } from '@/app/auth';
import { RuleError, requireActive } from '@/lib/domain';
import { resolveWorkspaceSession } from '@/lib/http/workspaceSession';
import { requirePermission } from '@/lib/authz/service';
import { MAX_UPLOAD_BYTES } from '@/lib/documents/service';
import { extractContractText } from '@/lib/contracts/extract';
import { logger } from '@/lib/log';

export const dynamic = 'force-dynamic';
const reply = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'private, no-store' } });

/**
 * Importa o contrato que a loja já usa (PDF com texto) e devolve a sugestão de modelo para o
 * editor. O PDF NÃO é guardado: pode conter dados de um cliente real (contrato de exemplo).
 */
export async function POST(request: Request) {
 try {
  if (!isSameOrigin(request)) return reply({ error: 'Origem da solicitação inválida.' }, 403);
  const session = await resolveWorkspaceSession();
  if (!session) return reply({ error: 'Sessão encerrada. Entre novamente.', signIn: true }, 401);
  requireActive(session.plan, Date.now());
  requirePermission(session.actor.permissions, 'SIGNATURE_CONFIG');
  const lengthHeader = request.headers.get('content-length');
  if (!lengthHeader) return reply({ error: 'Tamanho do envio não informado.' }, 411);
  if (!Number.isFinite(Number(lengthHeader)) || Number(lengthHeader) > MAX_UPLOAD_BYTES + 64 * 1024) return reply({ error: 'Arquivo maior que 10 MB.' }, 413);
  const form = await request.formData();
  const file = form.get('file');
  if (!(file instanceof File)) return reply({ error: 'Selecione o PDF do contrato.' }, 400);
  if (file.size > MAX_UPLOAD_BYTES) return reply({ error: 'Arquivo maior que 10 MB.' }, 413);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!(bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46)) return reply({ error: 'Envie um arquivo PDF.' }, 400);
  const result = await extractContractText(bytes);
  return reply({ ...result, sourceFilename: file.name.slice(0, 200) });
 } catch (error) {
  if (error instanceof RuleError) return reply({ error: error.message }, error.status);
  const requestId = crypto.randomUUID();
  logger.error('contract-models.importar.erro', { requestId, error });
  return reply({ error: 'Não foi possível ler o PDF. Tente novamente.', requestId }, 500);
 }
}
