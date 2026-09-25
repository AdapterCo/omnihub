import { database } from '@/db/database';
import { handleMercadoPagoWebhook } from '@/lib/payments/service';
import { logger } from '@/lib/log';

export const dynamic = 'force-dynamic';

// Webhook do Mercado Pago (tópico "Order"), configurado pelo lojista no painel da aplicação
// dele com a URL exibida em "Pagamentos integrados". Público por natureza: a autenticidade vem
// da assinatura x-signature (HMAC com o segredo da loja). O corpo não decide nada — a cobrança
// é atualizada por consulta autenticada ao Mercado Pago (lib/payments/service.ts).
export async function POST(request: Request, { params }: { params: Promise<{ key: string }> }) {
    const { key } = await params;
    const url = new URL(request.url);
    let bodyDataId: string | null = null;
    try {
        const body = (await request.json()) as { data?: { id?: unknown } };
        bodyDataId = typeof body?.data?.id === 'string' ? body.data.id : null;
    } catch {
        bodyDataId = null;
    }
    // O manifest da assinatura usa o data.id da URL; o do corpo só serve de reserva para achar o
    // pedido quando a URL não o traz (a assinatura continua obrigatória).
    const dataId = url.searchParams.get('data.id');
    try {
        const status = await handleMercadoPagoWebhook(database(), key, {
            xSignature: request.headers.get('x-signature'),
            xRequestId: request.headers.get('x-request-id'),
            dataId,
            lookupId: dataId ?? bodyDataId,
        });
        return Response.json({ ok: status === 200 }, { status, headers: { 'Cache-Control': 'no-store' } });
    } catch (error) {
        logger.error('payment.webhook.erro', { error });
        return Response.json({ ok: false }, { status: 500 });
    }
}
