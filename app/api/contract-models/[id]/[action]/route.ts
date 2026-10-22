import { isSameOrigin } from '@/app/auth';
import { database } from '@/db/database';
import { RuleError, requireActive } from '@/lib/domain';
import { resolveWorkspaceSession } from '@/lib/http/workspaceSession';
import { storageFromEnv } from '@/lib/storage';
import { recordAudit } from '@/lib/audit/service';
import { logger } from '@/lib/log';
import { previewContractModel, setContractModelLogo } from '@/lib/contracts/models';

export const dynamic = 'force-dynamic';
const reply = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'private, no-store' } });
const ID = /^[A-Za-z0-9-]{1,80}$/;
const MAX_LOGO_REQUEST = 1024 * 1024 + 64 * 1024;

function failure(error: unknown, event: string) {
 if (error instanceof RuleError) return reply({ error: error.message }, error.status);
 const requestId = crypto.randomUUID();
 logger.error(event, { requestId, error });
 return reply({ error: 'Não foi possível concluir. Tente novamente.', requestId }, 500);
}

/** Pré-visualização do modelo em PDF, com dados de exemplo fictícios. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string; action: string }> }) {
 try {
  const { id, action } = await params;
  if (!ID.test(id) || action !== 'preview') return reply({ error: 'Rota inválida.' }, 404);
  const session = await resolveWorkspaceSession();
  if (!session) return reply({ error: 'Sessão encerrada. Entre novamente.', signIn: true }, 401);
  const pdf = await previewContractModel(database(), storageFromEnv(), session.tenantId, id, session.actor);
  return new Response(Buffer.from(pdf), { headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="pre-visualizacao-modelo.pdf"', 'Cache-Control': 'private, no-store' } });
 } catch (error) {
  return failure(error, 'contract-models.preview.erro');
 }
}

/** Logo do cabeçalho (multipart "file", PNG/JPG até 1 MB). */
export async function POST(request: Request, { params }: { params: Promise<{ id: string; action: string }> }) {
 try {
  if (!isSameOrigin(request)) return reply({ error: 'Origem da solicitação inválida.' }, 403);
  const { id, action } = await params;
  if (!ID.test(id) || action !== 'logo') return reply({ error: 'Rota inválida.' }, 404);
  const session = await resolveWorkspaceSession();
  if (!session) return reply({ error: 'Sessão encerrada. Entre novamente.', signIn: true }, 401);
  requireActive(session.plan, Date.now());
  const length = Number(request.headers.get('content-length') ?? NaN);
  if (!Number.isFinite(length)) return reply({ error: 'Tamanho do envio não informado.' }, 411);
  if (length > MAX_LOGO_REQUEST) return reply({ error: 'Logo maior que 1 MB. Reduza a imagem.' }, 413);
  const form = await request.formData();
  const file = form.get('file');
  if (!(file instanceof File) || !file.size) return reply({ error: 'Selecione a imagem do logo.' }, 400);
  const db = database();
  await setContractModelLogo(db, storageFromEnv(), session.tenantId, id, new Uint8Array(await file.arrayBuffer()), session.actor);
  await recordAudit(db, { tenantId: session.tenantId, userId: session.actor.userId, operator: session.actor.displayName, action: 'contract_model.logo', description: 'Logo do modelo de contrato enviado', entity: 'contract_model', entityId: id });
  return reply({ ok: true });
 } catch (error) {
  return failure(error, 'contract-models.logo.erro');
 }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string; action: string }> }) {
 try {
  if (!isSameOrigin(request)) return reply({ error: 'Origem da solicitação inválida.' }, 403);
  const { id, action } = await params;
  if (!ID.test(id) || action !== 'logo') return reply({ error: 'Rota inválida.' }, 404);
  const session = await resolveWorkspaceSession();
  if (!session) return reply({ error: 'Sessão encerrada. Entre novamente.', signIn: true }, 401);
  requireActive(session.plan, Date.now());
  await setContractModelLogo(database(), storageFromEnv(), session.tenantId, id, new Uint8Array(), session.actor);
  return reply({ ok: true });
 } catch (error) {
  return failure(error, 'contract-models.logo.erro');
 }
}
