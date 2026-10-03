import { database } from '@/db/database';
import { getSignupOptions } from '@/lib/subscriptions/service';
import { logger } from '@/lib/log';

export const dynamic = 'force-dynamic';

// Público: planos disponíveis para a página de cadastro (nome, preço, limite, descrição e recursos).
// Não expõe configuração nem dados de contas.
export async function GET() {
 try {
  return Response.json(await getSignupOptions(database()), { headers: { 'Cache-Control': 'no-store' } });
 } catch (error) {
  logger.error('planos.publico.erro', { error });
  return Response.json({ plans: [], billingReady: false, registrationEnabled: false }, { status: 500 });
 }
}
