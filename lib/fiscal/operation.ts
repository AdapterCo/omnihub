import { RuleError } from '../errors.ts';

// Como a venda aconteceu, para o documento fiscal (indPres) e o destino da operação (idDest).
// Nada é presumido: venda do PDV é presencial por definição (o cliente está no caixa da loja);
// venda de pedido usa a forma informada pelo vendedor no pedido.
export const SALE_CHANNELS = ['PRESENCIAL', 'INTERNET', 'ENTREGA'] as const;
export type SaleChannel = typeof SALE_CHANNELS[number];
// Tabela oficial de indPres: 1 = presencial; 2 = não presencial, internet; 4 = entrega em domicílio.
const PRESENCE_CODE: Record<SaleChannel, '1' | '2' | '4'> = { PRESENCIAL: '1', INTERNET: '2', ENTREGA: '4' };
export const SALE_CHANNEL_LABEL: Record<SaleChannel, string> = { PRESENCIAL: 'Na loja (presencial)', INTERNET: 'Pela internet / WhatsApp', ENTREGA: 'Entrega em domicílio' };

export async function resolveSaleOperation(db: D1Database, tenantId: string, saleId: string, storeUf: string, model: '55' | '65'): Promise<{ presence: '1' | '2' | '4' }> {
 const order = await db
  .prepare('SELECT o.number AS number, o.sale_channel AS channel, c.state AS customerUf FROM orders o LEFT JOIN customers c ON c.id = o.customer_id WHERE o.sale_id = ? AND o.tenant_id = ?')
  .bind(saleId, tenantId)
  .first<{ number: number; channel: string | null; customerUf: string | null }>();
 if (!order) return { presence: '1' }; // venda do PDV: presencial, operação interna.
 const channel = String(order.channel ?? '') as SaleChannel;
 if (!(SALE_CHANNELS as readonly string[]).includes(channel)) {
  throw new RuleError(`O pedido #${order.number} não informa como o cliente comprou (na loja, pela internet ou entrega). Sem isso não é possível emitir o documento fiscal.`, 409);
 }
 if (model === '65' && channel === 'INTERNET') {
  throw new RuleError('Venda pela internet não pode sair em NFC-e (a NFC-e é para venda presencial ou entrega em domicílio). Emita NF-e.', 409);
 }
 if (channel !== 'PRESENCIAL') {
  // Venda não presencial: o destino depende da UF do cliente. Operação interestadual ainda não é
  // suportada (exige o grupo de partilha do ICMS) — bloqueia em vez de sair como operação interna.
  const uf = String(order.customerUf ?? '').trim().toUpperCase();
  if (uf.length !== 2) throw new RuleError(`Informe a UF do endereço do cliente do pedido #${order.number}: é ela que define se a venda é dentro do estado.`, 409);
  if (uf !== storeUf.toUpperCase()) throw new RuleError(`Cliente de outro estado (${uf}): venda interestadual ainda não é suportada na emissão fiscal do OmniHub.`, 409);
 }
 return { presence: PRESENCE_CODE[channel] };
}

/** Unidade comercial do produto (uCom): obrigatória no cadastro — nunca presumir "UN". */
export function requireUnit(unit: string | null | undefined, productName: string): string {
 const u = String(unit ?? '').trim();
 if (!u) throw new RuleError(`Produto "${productName}" sem unidade (ex.: UN, KG) no cadastro.`, 400);
 return u;
}
