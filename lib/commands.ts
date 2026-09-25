import { z } from 'zod';
import { short, cents, qty, identifier, storeFields, productFields } from './domain.ts';

// Catálogo único dos comandos aceitos por /api/workspace. Todos os comandos são
// executados relacionalmente (lib/catalog, lib/inventory, lib/cash, lib/sales) — não há
// mais um `execute()` sobre um blob JSON (ver lib/relationalCommands.ts).
export const storeCommandSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('store.create'), data: storeFields }), z.object({ type: z.literal('store.update'), id: identifier, data: storeFields }),
]);
export const productCommandSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('product.create'), data: productFields }), z.object({ type: z.literal('product.update'), id: identifier, data: productFields }),
]);
export const stockCommandSchema = z.object({ type: z.literal('stock.receive'), storeId: identifier, productId: identifier, qty, reason: short.min(3) });
export const transferCommandSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('transfer.create'), from: identifier, to: identifier, productId: identifier, qty }),
    z.object({ type: z.literal('transfer.receive'), id: identifier }),
    z.object({ type: z.literal('transfer.cancel'), id: identifier }),
]);
export const relationalCommandSchema = z.union([storeCommandSchema, productCommandSchema, stockCommandSchema, transferCommandSchema]);
export type RelationalCommand = z.infer<typeof relationalCommandSchema>;

export const cashCommandSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('cash.open'), storeId: identifier, opening: cents }),
    z.object({ type: z.literal('cash.close'), id: identifier, counted: cents }),
    z.object({ type: z.literal('cash.supply'), id: identifier, amount: cents, reason: short.min(3) }),
    z.object({ type: z.literal('cash.withdrawal'), id: identifier, amount: cents, reason: short.min(3) }),
]);
export type CashCommand = z.infer<typeof cashCommandSchema>;

const paymentMethod = z.enum(['Dinheiro', 'Pix', 'Cartão']);
const paymentLine = z.object({ method: paymentMethod, amount: cents.min(1) });
// Aceita o formato antigo (`payment` único) OU o novo (`payments` — pagamento misto, §13).
// Nunca os dois ao mesmo tempo; o servidor soma `payments` e confere contra o total.
export const saleCreateSchema = z.object({
    type: z.literal('sale.create'), storeId: identifier, items: z.array(z.object({ productId: identifier, qty })).min(1).max(100),
    customer: short, document: z.string().regex(/^(\d{11}|\d{14})?$/),
    payment: paymentMethod.optional(), payments: z.array(paymentLine).min(1).max(5).optional(),
    // §53: desconto em percentual (até 2 casas) OU em valor (centavos), sempre com motivo.
    discount: z.object({ percent: z.number().gt(0).lt(100).optional(), amount: z.number().int().min(1).max(100000000).optional(), reason: short.min(3) }).strict().optional(),
    // Senha de supervisor quando o desconto passa do limite do operador. Nunca é gravada:
    // a auditoria/log mascaram `password` e o fingerprint de idempotência é um hash.
    authorization: z.object({ email: z.string().trim().max(160), password: z.string().min(1).max(128) }).strict().optional(),
}).strict().refine(v => Number(!!v.payment) + Number(!!v.payments) === 1, { message: 'Informe payment ou payments (nunca os dois).' });
export const salePrintSchema = z.object({ type: z.literal('sale.print'), id: identifier });
export const saleCancelSchema = z.object({ type: z.literal('sale.cancel'), id: identifier, reason: short.min(3) });
// §54: devolução parcial/total por item, com forma de estorno e retorno (ou não) ao estoque.
export const saleReturnSchema = z.object({
    type: z.literal('sale.return'),
    saleId: identifier,
    items: z.array(z.object({ productId: identifier, qty, restock: z.boolean() })).min(1).max(100),
    reason: short.min(3),
    refundMethod: paymentMethod,
}).strict();
// §53: limites de desconto por papel (percentual com até 2 casas). Sem valor padrão.
export const discountLimitsSchema = z.object({
    type: z.literal('discount.limits.save'),
    limits: z.array(z.object({ role: z.string().min(1).max(40), percent: z.number().min(0).max(100) }).strict()).min(1).max(10),
}).strict();
export const saleCommandSchema = z.union([saleCreateSchema, salePrintSchema, saleCancelSchema, saleReturnSchema, discountLimitsSchema]);
export type SaleCommand = z.infer<typeof saleCommandSchema>;

export const userCommandSchema = z.discriminatedUnion('type', [
    z.object({
        type: z.literal('user.assign'),
        userId: identifier,
        displayName: short.min(2),
        role: z.enum(['ADMIN', 'GERENTE', 'OPERADOR_CAIXA', 'ESTOQUISTA', 'CONSULTA']),
        storeId: identifier.nullable().optional(),
    }),
    z.object({
        type: z.literal('user.remove'),
        userId: identifier,
    }),
]);
export type UserCommand = z.infer<typeof userCommandSchema>;

export const customerCommandSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('customer.create'), data: z.record(z.unknown()) }),
    z.object({ type: z.literal('customer.update'), id: identifier, data: z.record(z.unknown()) }),
]);
export type CustomerCommand = z.infer<typeof customerCommandSchema>;

export const supplierCommandSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('supplier.create'), data: z.record(z.unknown()) }),
    z.object({ type: z.literal('supplier.update'), id: identifier, data: z.record(z.unknown()) }),
]);
export type SupplierCommand = z.infer<typeof supplierCommandSchema>;

export const fiscalCommandSchema = z.discriminatedUnion('type', [
    z.object({
        type: z.literal('fiscal.config.save'),
        storeId: identifier,
        series: z.number().int().min(1).default(1),
        crt: z.enum(['1_SIMPLES_NACIONAL', '2_SIMPLES_EXCESSO', '3_REGIME_NORMAL']),
    }),
    z.object({
        type: z.literal('fiscal.certificate.upload'),
        storeId: identifier,
        pfxBase64: z.string().min(1, 'Arquivo do certificado obrigatório.'),
        passphrase: z.string().min(1, 'Senha do certificado obrigatória.'),
    }),
    z.object({
        type: z.literal('fiscal.connectivity.test'),
        storeId: identifier,
    }),
    z.object({
        type: z.literal('fiscal.nfe.generate'),
        saleId: identifier,
    }),
    z.object({
        type: z.literal('fiscal.nfe.transmit'),
        saleId: identifier,
    }),
    z.object({
        type: z.literal('fiscal.nfe.cancel'),
        saleId: identifier,
        justification: z.string().min(15, 'Justificativa do cancelamento deve ter ao menos 15 caracteres.'),
    }),
    z.object({
        type: z.literal('fiscal.nfe.inutilizar'),
        storeId: identifier,
        series: z.number().int().min(1).max(999),
        numberStart: z.number().int().min(1),
        numberEnd: z.number().int().min(1),
        justification: z.string().min(15, 'Justificativa da inutilização deve ter ao menos 15 caracteres.'),
    }),
    z.object({
        type: z.literal('nfce.config.save'),
        storeId: identifier,
        series: z.number().int().min(1).default(1),
        crt: z.enum(['1_SIMPLES_NACIONAL', '2_SIMPLES_EXCESSO', '3_REGIME_NORMAL']),
        cscId: z.string().min(1).max(20),
        csc: z.string().min(1).max(200),
        qrCodeBaseUrl: z.string().url(),
    }),
    z.object({
        type: z.literal('nfce.generate'),
        saleId: identifier,
    }),
    z.object({
        type: z.literal('fiscal.nfe.retry'),
        saleId: identifier,
        jobType: z.enum(['TRANSMIT_NFE', 'CANCEL_NFE']),
        justification: z.string().min(15).optional(),
    }),
    z.object({
        type: z.literal('fiscal.jobs.process'),
    }),
]);
export type FiscalCommand = z.infer<typeof fiscalCommandSchema>;

// Pagamentos integrados (Mercado Pago presencial). Segredos só entram em payment.config.save;
// campos vazios mantêm o valor já salvo. A cobrança recebe o carrinho (não um valor): o total é
// calculado no servidor pelas mesmas regras da venda.
export const paymentCommandSchema = z.discriminatedUnion('type', [
    z.object({
        type: z.literal('payment.config.save'),
        storeId: identifier,
        accessToken: z.string().trim().max(300).optional(),
        webhookSecret: z.string().trim().max(300).optional(),
        qrExternalPosId: z.string().trim().max(64),
        defaultTerminalId: z.string().trim().max(120),
    }).strict(),
    z.object({
        type: z.literal('payment.charge.start'),
        storeId: identifier,
        items: z.array(z.object({ productId: identifier, qty })).min(1).max(100),
        customer: short,
        document: z.string().regex(/^(\d{11}|\d{14})?$/),
        discount: z.object({ percent: z.number().gt(0).lt(100).optional(), amount: z.number().int().min(1).max(100000000).optional(), reason: short.min(3) }).strict().optional(),
        authorization: z.object({ email: z.string().trim().max(160), password: z.string().min(1).max(128) }).strict().optional(),
        method: z.enum(['PIX_QR', 'CARD_TERMINAL']),
        terminalId: z.string().trim().max(120).optional(),
    }).strict(),
    z.object({ type: z.literal('payment.charge.cancel'), chargeId: identifier }).strict(),
    z.object({ type: z.literal('payment.charge.resolve'), chargeId: identifier, outcome: z.enum(['PAID', 'NOT_PAID']), note: short.min(10) }).strict(),
]);
export type PaymentCommand = z.infer<typeof paymentCommandSchema>;

export const commandSchema = z.union([relationalCommandSchema, cashCommandSchema, saleCommandSchema, userCommandSchema, customerCommandSchema, supplierCommandSchema, fiscalCommandSchema, paymentCommandSchema]);
export type Command = z.infer<typeof commandSchema>;

