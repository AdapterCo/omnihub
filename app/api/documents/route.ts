import { isSameOrigin } from '@/app/auth';
import { database } from '@/db/database';
import { RuleError, requireActive } from '@/lib/domain';
import { resolveWorkspaceSession } from '@/lib/http/workspaceSession';
import { MAX_UPLOAD_BYTES, uploadOrderDocument } from '@/lib/documents/service';
import { storageFromEnv } from '@/lib/storage';
import { recordAudit } from '@/lib/audit/service';
import { logger } from '@/lib/log';

export const dynamic = 'force-dynamic';
const reply = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'private, no-store' } });

/** Upload manual na aba Documentos do pedido (multipart: orderId, description, file). */
export async function POST(request: Request) {
 try {
  if (!isSameOrigin(request)) return reply({ error: 'Origem da solicitação inválida.' }, 403);
  const session = await resolveWorkspaceSession();
  if (!session) return reply({ error: 'Sessão encerrada. Entre novamente.', signIn: true }, 401);
  requireActive(session.plan, Date.now());
  // formData() lê tudo para a memória: sem tamanho declarado (envio em partes) não dá para
  // conferir antes. O navegador sempre declara o tamanho no envio de formulário.
  const lengthHeader = request.headers.get('content-length');
  if (!lengthHeader) return reply({ error: 'Tamanho do envio não informado.' }, 411);
  const length = Number(lengthHeader);
  if (!Number.isFinite(length) || length > MAX_UPLOAD_BYTES + 64 * 1024) return reply({ error: 'Arquivo maior que 10 MB.' }, 413);
  const form = await request.formData();
  const file = form.get('file');
  const orderId = String(form.get('orderId') ?? '');
  const description = String(form.get('description') ?? '');
  if (!(file instanceof File)) return reply({ error: 'Selecione um arquivo.' }, 400);
  if (!/^[A-Za-z0-9-]{1,80}$/.test(orderId)) return reply({ error: 'Pedido inválido.' }, 400);
  if (file.size > MAX_UPLOAD_BYTES) return reply({ error: 'Arquivo maior que 10 MB.' }, 413);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const db = database();
  const id = await uploadOrderDocument(db, storageFromEnv(), session.tenantId, orderId, { description, filename: file.name, bytes }, session.actor);
  await recordAudit(db, { tenantId: session.tenantId, userId: session.actor.userId, operator: session.actor.displayName, action: 'document.upload', description: `Documento anexado ao pedido: ${description.trim()}`, entity: 'order', entityId: orderId, after: { documentId: id, filename: file.name, size: bytes.length } });
  return reply({ id });
 } catch (error) {
  if (error instanceof RuleError) return reply({ error: error.message }, error.status);
  const requestId = crypto.randomUUID();
  logger.error('documents.upload.erro', { requestId, error });
  return reply({ error: 'Não foi possível enviar o arquivo. Tente novamente.', requestId }, 500);
 }
}
