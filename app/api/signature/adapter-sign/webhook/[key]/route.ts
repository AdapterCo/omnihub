import { database } from '@/db/database';
import { readTextLimited, readJsonLimited, BodyTooLargeError } from '@/lib/http/body';
import { receiveAdapterSignWebhook, processAdapterSignEvent } from '@/lib/signature/service';
import { signatureDepsFromEnv } from '@/lib/signature/worker';
import { logger } from '@/lib/log';

export const dynamic = 'force-dynamic';

// Webhook do Adapter Sign (URL exibida em Minhas lojas > Assinatura eletrônica). Público por
// natureza: a autenticidade vem do HMAC (X-Adapter-Signature) sobre o corpo BRUTO com o segredo
// da loja. Evento repetido é descartado; a resposta sai rápido e o processamento (consulta ao
// Adapter Sign + download do contrato assinado) roda fora dela — o worker retoma se falhar.
export async function POST(request: Request, { params }: { params: Promise<{ key: string }> }) {
 const { key } = await params;
 try {
  let rawBody: string;
  try { rawBody = await readTextLimited(request, 256 * 1024); } catch (e) { if (e instanceof BodyTooLargeError) return Response.json({ ok: false }, { status: 413 }); throw e; }
  const db = database();
  const result = await receiveAdapterSignWebhook(db, key, {
   signature: request.headers.get('x-adapter-signature') ?? '',
   timestamp: request.headers.get('x-adapter-timestamp') ?? '',
   eventId: request.headers.get('x-adapter-event-id') ?? '',
   rawBody,
  });
  if (result.eventRowId) {
   const eventRowId = result.eventRowId;
   void (async () => {
    try {
     await processAdapterSignEvent(db, eventRowId, signatureDepsFromEnv());
    } catch (error) {
     logger.error('signature.webhook.processamento_falhou', { error });
    }
   })();
  }
  return Response.json({ ok: result.status === 200 }, { status: result.status, headers: { 'Cache-Control': 'no-store' } });
 } catch (error) {
  logger.error('signature.webhook.erro', { error });
  return Response.json({ ok: false }, { status: 500 });
 }
}
