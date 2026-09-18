import { RuleError } from './errors.ts';
import { requireActive, type Actor, type Entitlement } from './domain.ts';
import type { Command } from './commands.ts';
import { createStore, updateStore, createProduct, updateProduct, countStores, getStore, getProductForSale } from './catalog/service.ts';
import { receiveStock, createTransfer, approveTransfer, dispatchTransfer, receiveTransfer, cancelTransfer } from './inventory/service.ts';
import { openSession, closeSession, recordMovement } from './cash/service.ts';
import { createSale, printSale, cancelSale } from './sales/service.ts';
import { recordAudit } from './audit/service.ts';
import { assignTenantUser, removeTenantUser } from './users/service.ts';
import { createCustomer, updateCustomer, createSupplier, updateSupplier } from './customers/service.ts';
import { saveFiscalStoreConfig, uploadCertificate, testSefazConnectivity, generateNFeForSale, transmitNFe, cancelNFeDocument, inutilizeFiscalNumbering } from './fiscal/service.ts';
import { saveNFCeStoreConfig, generateNFCeForSale } from './fiscal/nfce.ts';
import { enqueueFiscalJob, runFiscalJobWorker } from './fiscal/queue.ts';
import { requirePermission } from './authz/service.ts';

// Dispatcher único de todos os comandos de /api/workspace (Fase 1–3 cortadas): não há mais
// um `execute()` sobre um JSON por conta — cada comando é uma escrita relacional própria,
// idempotente via lib/idempotency e auditada via lib/audit.
//
// Comandos isentos de `requireActive` (podem rodar mesmo com acesso vencido, §45): quem
// já estava em andamento pode ser concluído — fechar caixa, reimprimir, confirmar
// recebimento de transferência.
const ACTIVE_EXEMPT = new Set(['transfer.receive', 'cash.close', 'sale.print']);

export type DispatchContext = { ip?: string | null; correlationId?: string | null };

export async function dispatchCommand(db: D1Database, tenantId: string, actor: Actor, plan: Entitlement, command: Command, now = Date.now(), context: DispatchContext = {}): Promise<string | undefined> {
    if (!ACTIVE_EXEMPT.has(command.type)) requireActive(plan, now);

    // §42: toda linha de auditoria desta requisição carrega o mesmo IP e correlation ID
    // (o correlation ID é a própria chave de idempotência da requisição, já gerada em
    // app/api/workspace/route.ts — não é preciso inventar outro identificador).
    const audit = (params: { storeId?: string; description: string; entity?: string; entityId?: string; before?: unknown; after?: unknown }) =>
        recordAudit(
            db,
            {
                tenantId,
                userId: actor.userId,
                operator: actor.displayName,
                action: command.type,
                ip: context.ip ?? null,
                correlationId: context.correlationId ?? null,
                ...params,
            },
            now,
        );

    if (command.type === 'store.create') {
        const count = await countStores(db, tenantId);
        if (count >= plan.maxStores) throw new RuleError('Limite de lojas do plano atingido.', 403);
        const id = await createStore(db, tenantId, command.data, actor, now);
        await audit({ storeId: id, description: `Loja: ${command.data.name}`, entity: 'store', entityId: id, after: command.data });
        return id;
    }
    if (command.type === 'store.update') {
        await updateStore(db, tenantId, command.id, command.data, actor);
        await audit({ storeId: command.id, description: `Loja: ${command.data.name}`, entity: 'store', entityId: command.id, after: command.data });
        return command.id;
    }
    if (command.type === 'product.create') {
        const id = await createProduct(db, tenantId, command.data, actor, now);
        await audit({ description: `Produto: ${command.data.name}`, entity: 'product', entityId: id, after: command.data });
        return id;
    }
    if (command.type === 'product.update') {
        const before = await getProductForSale(db, tenantId, command.id);
        await updateProduct(db, tenantId, command.id, command.data, actor);
        await audit({ description: `Produto: ${command.data.name}`, entity: 'product', entityId: command.id, before, after: command.data });
        return command.id;
    }
    if (command.type === 'stock.receive') {
        const [store, product] = await Promise.all([getStore(db, tenantId, command.storeId), getProductForSale(db, tenantId, command.productId)]);
        if (!store) throw new RuleError('Loja não encontrada.', 404);
        if (!product) throw new RuleError('Produto não encontrado.', 404);
        await receiveStock(db, { tenantId, storeId: command.storeId, productId: command.productId, quantity: command.qty, userId: actor.userId, reason: command.reason }, actor, now);
        await audit({ storeId: store.id, description: `Entrada de ${command.qty} × ${product.name} em ${store.name}: ${command.reason}`, entity: 'stock', entityId: command.productId, after: { qty: command.qty, reason: command.reason } });
        return undefined;
    }
    if (command.type === 'transfer.create') {
        if (command.from === command.to) throw new RuleError('Escolha lojas diferentes.');
        const [from, to, product] = await Promise.all([getStore(db, tenantId, command.from), getStore(db, tenantId, command.to), getProductForSale(db, tenantId, command.productId)]);
        if (!from || !to) throw new RuleError('Loja não encontrada.', 404);
        if (!product) throw new RuleError('Produto não encontrado.', 404);
        const id = await createTransfer(db, { tenantId, fromStoreId: command.from, toStoreId: command.to, items: [{ productId: command.productId, quantity: command.qty }] }, actor, now);
        try {
            await approveTransfer(db, tenantId, id, actor, now);
            await dispatchTransfer(db, tenantId, id, actor, now);
        } catch (error) {
            try {
                await cancelTransfer(db, tenantId, id, actor, now);
            } catch {
                // melhor esforço; ver nota em versões anteriores deste dispatcher.
            }
            throw error;
        }
        await audit({ storeId: from.id, description: `${command.qty} × ${product.name}: ${from.name} → ${to.name}`, entity: 'transfer', entityId: id, after: { from: from.id, to: to.id, productId: command.productId, qty: command.qty } });
        return id;
    }
    if (command.type === 'transfer.receive') {
        await receiveTransfer(db, tenantId, command.id, actor, now);
        await audit({ description: `Recebimento de transferência ${command.id.slice(0, 8)}`, entity: 'transfer', entityId: command.id });
        return command.id;
    }
    if (command.type === 'cash.open') {
        const id = await openSession(db, tenantId, command.storeId, command.opening, actor, now);
        await audit({ storeId: command.storeId, description: `Abertura de caixa`, entity: 'cash_session', entityId: id, after: { opening: command.opening } });
        return id;
    }
    if (command.type === 'cash.close') {
        await closeSession(db, tenantId, command.id, command.counted, actor, now);
        await audit({ description: `Fechamento de caixa`, entity: 'cash_session', entityId: command.id, after: { counted: command.counted } });
        return command.id;
    }
    if (command.type === 'cash.supply' || command.type === 'cash.withdrawal') {
        const type = command.type === 'cash.supply' ? 'SUPPLY' : 'WITHDRAWAL';
        await recordMovement(db, tenantId, command.id, type, command.amount, command.reason, actor, now);
        await audit({ description: `${type === 'SUPPLY' ? 'Suprimento' : 'Sangria'}: ${command.reason}`, entity: 'cash_session', entityId: command.id, after: { amount: command.amount, reason: command.reason } });
        return command.id;
    }
    if (command.type === 'sale.create') {
        const id = await createSale(db, tenantId, command, actor, now);
        await audit({ description: `Venda ${id.slice(0, 8)}`, entity: 'sale', entityId: id, after: { items: command.items, payments: command.payments } });
        return id;
    }
    if (command.type === 'sale.print') {
        await printSale(db, tenantId, command.id, actor);
        return command.id;
    }
    if (command.type === 'sale.cancel') {
        await cancelSale(db, tenantId, command.id, actor, now);
        await audit({ description: `Cancelamento de venda ${command.id.slice(0, 8)}: ${command.reason}`, entity: 'sale', entityId: command.id, after: { reason: command.reason } });
        return command.id;
    }
    if (command.type === 'transfer.cancel') {
        await cancelTransfer(db, tenantId, command.id, actor, now);
        await audit({ description: `Cancelamento de transferência ${command.id.slice(0, 8)}`, entity: 'transfer', entityId: command.id });
        return command.id;
    }
    if (command.type === 'user.assign') {
        await assignTenantUser(db, tenantId, command, actor, now);
        await audit({ description: `Atribuição de papel ${command.role} para ${command.displayName}`, entity: 'user', entityId: command.userId, after: { role: command.role, storeId: command.storeId } });
        return command.userId;
    }
    if (command.type === 'user.remove') {
        await removeTenantUser(db, tenantId, command.userId, actor);
        await audit({ description: `Remoção de usuário ${command.userId}`, entity: 'user', entityId: command.userId });
        return command.userId;
    }
    if (command.type === 'customer.create') {
        const id = await createCustomer(db, tenantId, command.data, actor, now);
        await audit({ description: `Cliente: ${command.data.name}`, entity: 'customer', entityId: id, after: command.data });
        return id;
    }
    if (command.type === 'customer.update') {
        const id = await updateCustomer(db, tenantId, command.id, command.data, actor, now);
        await audit({ description: `Atualização de cliente: ${command.data.name ?? id.slice(0, 8)}`, entity: 'customer', entityId: id, after: command.data });
        return id;
    }
    if (command.type === 'supplier.create') {
        const id = await createSupplier(db, tenantId, command.data, actor, now);
        await audit({ description: `Fornecedor: ${command.data.name}`, entity: 'supplier', entityId: id, after: command.data });
        return id;
    }
    if (command.type === 'supplier.update') {
        const id = await updateSupplier(db, tenantId, command.id, command.data, actor, now);
        await audit({ description: `Atualização de fornecedor: ${command.data.name ?? id.slice(0, 8)}`, entity: 'supplier', entityId: id, after: command.data });
        return id;
    }
    if (command.type === 'fiscal.config.save') {
        await saveFiscalStoreConfig(db, tenantId, command.storeId, { series: command.series, crt: command.crt }, actor, now);
        await audit({ storeId: command.storeId, description: `Configuração fiscal atualizada (série ${command.series})`, entity: 'fiscal_configuration', entityId: command.storeId, after: { series: command.series, crt: command.crt } });
        return command.storeId;
    }
    if (command.type === 'fiscal.certificate.upload') {
        const pfxBuffer = Buffer.from(command.pfxBase64, 'base64');
        const summary = await uploadCertificate(db, tenantId, command.storeId, pfxBuffer, command.passphrase, actor, now);
        await audit({ storeId: command.storeId, description: `Certificado digital A1 cadastrado: CNPJ ${summary.subjectCnpj}`, entity: 'fiscal_certificate', entityId: summary.id, after: { subjectCnpj: summary.subjectCnpj, fingerprint: summary.fingerprint, validTo: summary.validTo } });
        return summary.id;
    }
    if (command.type === 'fiscal.connectivity.test') {
        const testResult = await testSefazConnectivity(db, tenantId, command.storeId, actor);
        await audit({ storeId: command.storeId, description: `Teste de conectividade SEFAZ: cStat ${testResult.cStat}`, entity: 'fiscal_configuration', entityId: command.storeId, after: { cStat: testResult.cStat, status: testResult.status } });
        return JSON.stringify(testResult);
    }
    if (command.type === 'fiscal.nfe.generate') {
        const doc = await generateNFeForSale(db, tenantId, command.saleId, actor, now);
        await audit({ description: `NF-e gerada e validada: Chave ${doc.accessKey.slice(0, 8)}... Série ${doc.series} Nº ${doc.number}`, entity: 'fiscal_document', entityId: doc.id, after: { accessKey: doc.accessKey, series: doc.series, number: doc.number, status: doc.status } });
        return JSON.stringify(doc);
    }
    if (command.type === 'fiscal.nfe.transmit') {
        let doc;
        try {
            doc = await transmitNFe(db, tenantId, command.saleId, actor);
        } catch (err) {
            // Falha de comunicação deixa o documento em SIGNED (retomável): enfileira o
            // retry automático (§41) e devolve o erro ao usuário normalmente.
            const current = await db.prepare('SELECT status FROM fiscal_documents WHERE sale_id = ? AND tenant_id = ?').bind(command.saleId, tenantId).first<{ status: string }>();
            if (current?.status === 'SIGNED') {
                await enqueueFiscalJob(db, tenantId, { jobType: 'TRANSMIT_NFE', saleId: command.saleId, userId: actor.userId, correlationId: context.correlationId ?? null }, now);
            }
            throw err;
        }
        await audit({ description: `NF-e ${doc.status === 'AUTHORIZED' ? 'autorizada' : 'rejeitada'}: Chave ${doc.accessKey.slice(0, 8)}... ${doc.protocolNumber ? `Protocolo ${doc.protocolNumber}` : ''}`, entity: 'fiscal_document', entityId: doc.id, after: { status: doc.status, protocolNumber: doc.protocolNumber } });
        return JSON.stringify(doc);
    }
    if (command.type === 'fiscal.nfe.cancel') {
        const doc = await cancelNFeDocument(db, tenantId, command.saleId, command.justification, actor);
        await audit({ description: `NF-e cancelada: Chave ${doc.accessKey.slice(0, 8)}... Protocolo ${doc.protocolNumber ?? ''}`, entity: 'fiscal_document', entityId: doc.id, before: { status: 'AUTHORIZED' }, after: { status: doc.status, justification: command.justification } });
        return JSON.stringify(doc);
    }
    if (command.type === 'fiscal.nfe.inutilizar') {
        const result = await inutilizeFiscalNumbering(db, tenantId, command.storeId, command.series, command.numberStart, command.numberEnd, command.justification, actor);
        await audit({ storeId: command.storeId, description: `Numeração inutilizada: Série ${result.series} Nº ${result.numberStart}-${result.numberEnd} Protocolo ${result.protocolNumber ?? ''}`, entity: 'fiscal_inutilization', entityId: result.id, after: { series: result.series, numberStart: result.numberStart, numberEnd: result.numberEnd, justification: command.justification } });
        return JSON.stringify(result);
    }
    if (command.type === 'nfce.config.save') {
        await saveNFCeStoreConfig(db, tenantId, command.storeId, { series: command.series, crt: command.crt, cscId: command.cscId, csc: command.csc, qrCodeBaseUrl: command.qrCodeBaseUrl }, actor, now);
        await audit({ storeId: command.storeId, description: `Configuração de NFC-e salva para a loja ${command.storeId}`, entity: 'nfce_configuration', entityId: command.storeId, after: { series: command.series, crt: command.crt, cscId: command.cscId, qrCodeBaseUrl: command.qrCodeBaseUrl } });
        return;
    }
    if (command.type === 'nfce.generate') {
        const doc = await generateNFCeForSale(db, tenantId, command.saleId, actor, now);
        await audit({ description: `NFC-e gerada e validada: Chave ${doc.accessKey.slice(0, 8)}... Série ${doc.series} Nº ${doc.number}`, entity: 'fiscal_document', entityId: doc.id, after: { accessKey: doc.accessKey, series: doc.series, number: doc.number, status: doc.status } });
        return JSON.stringify(doc);
    }
    if (command.type === 'fiscal.nfe.retry') {
        // §41: enfileira em vez de chamar a SEFAZ na hora — permissão é checada aqui
        // (mesma exigida pela operação síncrona equivalente) porque o worker roda depois,
        // fora do ciclo desta requisição, e reconstrói o ator a partir do userId salvo.
        requirePermission(actor.permissions, command.jobType === 'CANCEL_NFE' ? 'FISCAL_CANCEL' : 'FISCAL_ISSUE');
        if (command.jobType === 'CANCEL_NFE' && !command.justification) {
            throw new RuleError('Justificativa é obrigatória para reenfileirar um cancelamento.', 400);
        }
        const jobId = await enqueueFiscalJob(db, tenantId, { jobType: command.jobType, saleId: command.saleId, payload: command.justification ? { justification: command.justification } : {}, userId: actor.userId, correlationId: null }, now);
        await audit({ description: `Job de ${command.jobType === 'CANCEL_NFE' ? 'cancelamento' : 'transmissão'} enfileirado para a venda ${command.saleId.slice(0, 8)}`, entity: 'fiscal_job', entityId: jobId, after: { jobType: command.jobType, saleId: command.saleId } });
        return jobId;
    }
    if (command.type === 'fiscal.jobs.process') {
        requirePermission(actor.permissions, 'FISCAL_ISSUE');
        const result = await runFiscalJobWorker(db, undefined, {}, now);
        await audit({ description: `Fila fiscal processada: ${result.processed} job(s), ${result.succeeded} sucesso, ${result.failed} falha, ${result.deadLettered} em dead-letter`, entity: 'fiscal_job', after: result });
        return JSON.stringify(result);
    }
}
