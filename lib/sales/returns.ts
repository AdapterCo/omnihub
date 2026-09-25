import { RuleError } from '../errors.ts';
import { requirePermission, requireStoreAccess } from '../authz/service.ts';
import type { Actor } from '../domain.ts';
import { findOpenSessionForUser } from '../cash/service.ts';
import { buildSaleStockStatements } from '../inventory/service.ts';

// Devoluções e estornos (instrucoes.md §54): "Não simplesmente excluir venda. Registrar
// histórico e movimentações compensatórias. Diferenciar: cancelamento; devolução; estorno
// financeiro; cancelamento fiscal; retorno ao estoque." Aqui:
//  - cancelamento = venda inteira, antes de qualquer devolução (lib/sales/service.ts);
//  - devolução    = itens/quantidades específicos de uma venda (parcial ou total), sale_returns;
//  - estorno financeiro = a forma de devolver o dinheiro (refund_method); em dinheiro sai do
//    caixa como movimento REFUND, em Pix/cartão fica registrado para conciliação manual;
//  - retorno ao estoque = por item (restock): true gera movimentação compensatória RETURN,
//    false (avaria/defeito) não mexe no saldo;
//  - cancelamento fiscal = fluxo próprio (lib/fiscal): uma venda com documento fiscal ativo
//    NÃO pode ser devolvida aqui — a nota de devolução ainda não existe no sistema.
// A venda nunca é apagada nem alterada além de returned_total/status (REFUNDED quando tudo voltou).

const REFUND_METHODS = ['Dinheiro', 'Pix', 'Cartão'] as const;
// Documento fiscal que ainda vale (ou pode vir a valer): bloqueia a devolução comercial.
const INACTIVE_FISCAL_STATUSES = ['REJECTED', 'CANCELLED'];

export type ReturnItemInput = { productId: string; qty: number; restock: boolean };

type SaleRow = { id: string; store_id: string; status: string; returned_total: number };
type ItemRow = { id: string; product_id: string; name: string; sku: string; qty: number; price: number; discount: number; returnedQty: number; refundedAmount: number };

const shortMoney = (cents: number) => `R$ ${(cents / 100).toFixed(2).replace('.', ',')}`;

export async function returnSale(
    db: D1Database,
    tenantId: string,
    params: { saleId: string; items: ReturnItemInput[]; reason: string; refundMethod: string },
    actor: Actor,
    now = Date.now(),
): Promise<string> {
    requirePermission(actor.permissions, 'SALE_RETURN');
    if (!(REFUND_METHODS as readonly string[]).includes(params.refundMethod)) throw new RuleError('Forma de estorno inválida.', 400);
    if (!params.reason || params.reason.trim().length < 3) throw new RuleError('Informe o motivo da devolução (mín. 3 caracteres).', 400);
    if (params.items.length === 0) throw new RuleError('Selecione ao menos um item para devolver.', 400);
    if (new Set(params.items.map((i) => i.productId)).size !== params.items.length) throw new RuleError('Produto repetido na devolução.', 400);

    const sale = await db
        .prepare('SELECT id, store_id, status, returned_total FROM sales WHERE id = ? AND tenant_id = ?')
        .bind(params.saleId, tenantId)
        .first<SaleRow>();
    if (!sale) throw new RuleError('Venda não encontrada.', 404);
    requireStoreAccess(actor, sale.store_id);
    if (sale.status === 'CANCELLED') throw new RuleError('Venda cancelada não pode receber devolução.', 409);
    if (sale.status === 'REFUNDED') throw new RuleError('Todos os itens desta venda já foram devolvidos.', 409);
    if (sale.status === 'PENDING_PAYMENT') throw new RuleError('Venda aguardando pagamento não pode receber devolução.', 409);
    // Pagamento integrado (Mercado Pago presencial) só aceita estorno TOTAL no provedor: devolução
    // parcial registraria um estorno que o provedor não faz. Use o cancelamento da venda.
    const integrated = await db.prepare('SELECT status FROM payment_charges WHERE sale_id = ? AND tenant_id = ?').bind(params.saleId, tenantId).first<{ status: string }>();
    if (integrated) {
        throw new RuleError('Venda paga por pagamento integrado: o provedor só faz estorno total. Use "Cancelar venda" (o estorno no provedor é feito automaticamente); devolução parcial ainda não é suportada nesse caso.', 409);
    }

    // §54 x §29: enquanto houver documento fiscal ativo, a devolução comercial deixaria a
    // nota emitida sem lastro. Nota de devolução (finNFe=4) ainda não está implementada.
    const fiscalDocs = await db.prepare('SELECT status FROM fiscal_documents WHERE sale_id = ? AND tenant_id = ?').bind(params.saleId, tenantId).all<{ status: string }>();
    const activeDoc = (fiscalDocs.results ?? []).find((d) => !INACTIVE_FISCAL_STATUSES.includes(d.status));
    if (activeDoc) {
        throw new RuleError(
            activeDoc.status === 'AUTHORIZED'
                ? 'Esta venda possui NF-e/NFC-e autorizada. A devolução exige nota fiscal de devolução (ainda não implementada) ou o cancelamento do documento fiscal dentro do prazo — cancele o documento antes.'
                : `Esta venda possui documento fiscal em andamento (${activeDoc.status}). Cancele ou conclua o documento fiscal antes de registrar a devolução.`,
            409,
        );
    }

    const saleItems = await db
        .prepare(
            `SELECT si.id AS id, si.product_id AS product_id, si.name AS name, si.sku AS sku, si.qty AS qty, si.price AS price, si.discount AS discount,
                    COALESCE((SELECT SUM(ri.qty) FROM sale_return_items ri WHERE ri.sale_item_id = si.id), 0) AS returnedQty,
                    COALESCE((SELECT SUM(ri.amount) FROM sale_return_items ri WHERE ri.sale_item_id = si.id), 0) AS refundedAmount
             FROM sale_items si WHERE si.sale_id = ?`,
        )
        .bind(params.saleId)
        .all<ItemRow>();
    const byProduct = new Map((saleItems.results ?? []).map((i) => [i.product_id, i]));

    // Valor estornado por item: proporcional ao líquido pago (preço x qtd - desconto rateado).
    // A última fração devolvida leva o resto exato, para o total estornado nunca passar do pago.
    const lines: { item: ItemRow; qty: number; amount: number; restock: boolean }[] = [];
    for (const requested of params.items) {
        if (!Number.isInteger(requested.qty) || requested.qty < 1) throw new RuleError('Quantidade de devolução inválida.', 400);
        const item = byProduct.get(requested.productId);
        if (!item) throw new RuleError('Produto não pertence a esta venda.', 404);
        const remaining = Number(item.qty) - Number(item.returnedQty);
        if (requested.qty > remaining) throw new RuleError(`"${item.name}": só ${remaining} unidade(s) ainda podem ser devolvidas.`, 409);
        const net = Number(item.price) * Number(item.qty) - Number(item.discount);
        const amount = requested.qty === remaining ? net - Number(item.refundedAmount) : Math.floor((net * requested.qty) / Number(item.qty));
        lines.push({ item, qty: requested.qty, amount, restock: requested.restock });
    }
    const total = lines.reduce((a, l) => a + l.amount, 0);
    if (total < 1) throw new RuleError('Não há valor a estornar nos itens selecionados.', 400);

    // O estorno numa forma de pagamento não pode passar do que foi pago nela (menos o já estornado).
    const paid = await db.prepare('SELECT COALESCE(SUM(amount), 0) AS total FROM sale_payments WHERE sale_id = ? AND method = ?').bind(params.saleId, params.refundMethod).first<{ total: number }>();
    const refunded = await db.prepare('SELECT COALESCE(SUM(total), 0) AS total FROM sale_returns WHERE sale_id = ? AND refund_method = ?').bind(params.saleId, params.refundMethod).first<{ total: number }>();
    const available = Number(paid?.total ?? 0) - Number(refunded?.total ?? 0);
    if (total > available) {
        throw new RuleError(`O estorno de ${shortMoney(total)} passa do que foi pago em ${params.refundMethod} nesta venda (${shortMoney(Math.max(available, 0))} disponível). Escolha outra forma de estorno.`, 409);
    }

    // Estorno em dinheiro sai do caixa: exige o caixa aberto do próprio usuário nesta loja.
    let cashSessionId: string | null = null;
    if (params.refundMethod === 'Dinheiro') {
        const session = await findOpenSessionForUser(db, tenantId, sale.store_id, actor.userId);
        if (!session) throw new RuleError('Abra seu caixa nesta loja para estornar em dinheiro.', 409);
        cashSessionId = session.id;
    }

    const fullyReturned = (saleItems.results ?? []).every((i) => {
        const line = lines.find((l) => l.item.id === i.id);
        return Number(i.returnedQty) + (line?.qty ?? 0) === Number(i.qty);
    });
    const newStatus = fullyReturned ? 'REFUNDED' : 'COMPLETED';

    // Reserva a venda antes de gravar: só uma devolução por vez passa (compara returned_total
    // lido acima). Duas devoluções simultâneas do mesmo item não conseguem estornar em dobro.
    const claim = await db
        .prepare("UPDATE sales SET returned_total = returned_total + ?, status = ? WHERE id = ? AND tenant_id = ? AND status = 'COMPLETED' AND returned_total = ?")
        .bind(total, newStatus, params.saleId, tenantId, Number(sale.returned_total))
        .run();
    if (claim.meta.changes !== 1) throw new RuleError('A venda foi alterada por outra operação. Recarregue e tente novamente.', 409);

    const returnId = crypto.randomUUID();
    try {
        const restockItems = lines.filter((l) => l.restock).map((l) => ({ storeId: sale.store_id, productId: l.item.product_id, qty: l.qty }));
        const stockStatements = await buildSaleStockStatements(db, tenantId, restockItems, actor.userId, returnId, { reverse: true, movementType: 'RETURN', referenceType: 'sale_return' }, now);
        await db.batch([
            ...stockStatements,
            db
                .prepare('INSERT INTO sale_returns (id, tenant_id, sale_id, store_id, user_id, operator, reason, refund_method, total, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
                .bind(returnId, tenantId, params.saleId, sale.store_id, actor.userId, actor.displayName, params.reason.trim(), params.refundMethod, total, now),
            ...lines.map((l) =>
                db
                    .prepare('INSERT INTO sale_return_items (id, return_id, sale_item_id, product_id, name, sku, qty, amount, restock) VALUES (?,?,?,?,?,?,?,?,?)')
                    .bind(crypto.randomUUID(), returnId, l.item.id, l.item.product_id, l.item.name, l.item.sku, l.qty, l.amount, l.restock ? 1 : 0),
            ),
            ...(cashSessionId
                ? [
                      db
                          .prepare('INSERT INTO cash_movements (id, tenant_id, cash_session_id, type, amount, reason, user_id, created_at) VALUES (?,?,?,?,?,?,?,?)')
                          .bind(crypto.randomUUID(), tenantId, cashSessionId, 'REFUND', total, `Devolução da venda ${params.saleId.slice(0, 8)}`, actor.userId, now),
                  ]
                : []),
        ]);
    } catch (error) {
        // Desfaz a reserva para a venda não ficar marcada como devolvida sem registro.
        await db.prepare("UPDATE sales SET returned_total = returned_total - ?, status = 'COMPLETED' WHERE id = ? AND tenant_id = ?").bind(total, params.saleId, tenantId).run();
        throw error;
    }
    return returnId;
}
