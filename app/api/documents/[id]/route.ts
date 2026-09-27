import { database } from '@/db/database';
import { RuleError } from '@/lib/domain';
import { resolveWorkspaceSession } from '@/lib/http/workspaceSession';
import { readDocument } from '@/lib/documents/service';
import { storageFromEnv } from '@/lib/storage';
import { logger } from '@/lib/log';

export const dynamic = 'force-dynamic';

/** Visualização/download autorizado de um documento (nunca por URL pública permanente). */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
 try {
  const { id } = await params;
  if (!/^[A-Za-z0-9-]{1,80}$/.test(id)) return Response.json({ error: 'Documento inválido.' }, { status: 400 });
  const session = await resolveWorkspaceSession();
  if (!session) return Response.json({ error: 'Sessão encerrada. Entre novamente.' }, { status: 401 });
  const doc = await readDocument(database(), storageFromEnv(), session.tenantId, id, session.actor);
  const download = new URL(request.url).searchParams.get('download') === '1';
  const name = encodeURIComponent(doc.filename);
  return new Response(Buffer.from(doc.bytes), {
   status: 200,
   headers: {
    'Content-Type': doc.mimeType,
    'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${name}`,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
   },
  });
 } catch (error) {
  if (error instanceof RuleError) return Response.json({ error: error.message }, { status: error.status });
  const requestId = crypto.randomUUID();
  logger.error('documents.download.erro', { requestId, error });
  return Response.json({ error: 'Não foi possível abrir o documento.', requestId }, { status: 500 });
 }
}
