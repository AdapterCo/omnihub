import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { RuleError } from '../errors.ts';
import { requirePermission } from '../authz/service.ts';
import type { Actor } from '../domain.ts';
import { encryptPayload, decryptPayload, type EncryptedPayload } from './certificate.ts';
import { buildNFeXml, type NFeItem, type NFePayment } from './builder.ts';
import { validateNFeXmlSchema } from './validator.ts';
import { generateAccessKey } from './keys.ts';
import { buildNFCeQrCode } from './qrcode.ts';
import { getNextFiscalNumber } from './sequence.ts';
import type { CRT, NFCeStoreConfig, FiscalDocumentSummary } from './types.ts';
export type { NFCeStoreConfig };

// Fase 7 (§20): NFC-e Modelo 65. Compartilha componentes com a NF-e (builder, assinatura
// via lib/fiscal/signer.ts, transmissão via lib/fiscal/gateway.ts, cancelamento via
// lib/fiscal/service.ts's cancelNFeDocument — todos genéricos o bastante para operar sobre
// um `fiscal_documents` com model='65' sem alteração), mas não é tratada como o mesmo
// documento (§20: "NF-e e NFC-e deverão compartilhar componentes comuns sem serem
// tratadas como exatamente o mesmo documento") — por isso a configuração (CSC, QR Code) e
// a geração têm suas próprias funções aqui, em vez de reaproveitar generateNFeForSale.
//
// PENDÊNCIA EXPLÍCITA, NÃO ESCONDIDA: contingência (emissão offline com reenvio posterior,
// §20) NÃO está implementada nesta entrega — exigiria fila de reenvio e armazenamento
// local que ainda não existem no projeto. Inutilização de numeração (§25) para NFC-e
// também não foi generalizada nesta entrega (lib/fiscal/service.ts's
// `inutilizeFiscalNumbering` continua exclusiva ao modelo 55).

export const nfceConfigInputSchema = z.object({
    series: z.number().int().min(1, 'Série deve ser maior ou igual a 1.').max(999, 'Série máxima é 999.').default(1),
    crt: z.enum(['1_SIMPLES_NACIONAL', '2_SIMPLES_EXCESSO', '3_REGIME_NORMAL']),
    cscId: z.string().trim().min(1, 'Informe o identificador do CSC (idToken).').max(20),
    csc: z.string().trim().min(1, 'Informe o CSC (Código de Segurança do Contribuinte).').max(200),
    qrCodeBaseUrl: z.string().trim().url('URL do QR Code inválida.'),
}).strict();

export type NFCeConfigInput = z.infer<typeof nfceConfigInputSchema>;

export async function getNFCeStoreConfig(
    db: D1Database,
    tenantId: string,
    storeId: string,
    actor: Actor,
    now = Date.now(),
): Promise<NFCeStoreConfig> {
    requirePermission(actor.permissions, 'FISCAL_VIEW');

    const configRow = await db
        .prepare(
            `SELECT series, crt, csc_id AS cscId, csc_encrypted AS cscEncrypted, qrcode_base_url AS qrCodeBaseUrl, certificate_id AS certificateId
             FROM fiscal_configurations
             WHERE tenant_id = ? AND store_id = ? AND model = '65'`,
        )
        .bind(tenantId, storeId)
        .first<{ series: number; crt: CRT; cscId: string | null; cscEncrypted: string | null; qrCodeBaseUrl: string | null; certificateId: string | null }>();

    let certificate: { fingerprint: string; validTo: number } | null = null;
    // Reaproveita o certificado A1 da loja (o mesmo usado para NF-e) — a assinatura da
    // NFC-e usa o mesmo par de chaves/certificado do CNPJ emissor.
    const certificateId = configRow?.certificateId;
    if (certificateId) {
        const certRow = await db
            .prepare(`SELECT fingerprint, valid_to AS validTo FROM fiscal_certificates WHERE id = ? AND tenant_id = ?`)
            .bind(certificateId, tenantId)
            .first<{ fingerprint: string; validTo: number }>();
        if (certRow) certificate = certRow;
    } else {
        // Se a NFC-e ainda não tem config própria, verifica se a loja já tem certificado
        // vinculado à configuração de NF-e (mesmo CNPJ, mesmo certificado A1).
        const nfeCert = await db
            .prepare(`SELECT certificate_id AS certificateId FROM fiscal_configurations WHERE tenant_id = ? AND store_id = ? AND model = '55'`)
            .bind(tenantId, storeId)
            .first<{ certificateId: string | null }>();
        if (nfeCert?.certificateId) {
            const certRow = await db
                .prepare(`SELECT fingerprint, valid_to AS validTo FROM fiscal_certificates WHERE id = ? AND tenant_id = ?`)
                .bind(nfeCert.certificateId, tenantId)
                .first<{ fingerprint: string; validTo: number }>();
            if (certRow) certificate = certRow;
        }
    }

    const cscConfigured = !!(configRow?.cscId && configRow?.cscEncrypted);
    let status: NFCeStoreConfig['status'] = 'NOT_CONFIGURED';
    if (configRow) {
        status = cscConfigured && certificate && certificate.validTo > now ? 'READY' : 'CONFIGURED';
    }

    return {
        storeId,
        environment: 'homologacao',
        model: '65',
        series: configRow?.series ?? 1,
        crt: configRow?.crt ?? '1_SIMPLES_NACIONAL',
        cscId: configRow?.cscId ?? null,
        cscConfigured,
        qrCodeBaseUrl: configRow?.qrCodeBaseUrl ?? null,
        certificate,
        status,
    };
}

export async function saveNFCeStoreConfig(
    db: D1Database,
    tenantId: string,
    storeId: string,
    rawInput: unknown,
    actor: Actor,
    now = Date.now(),
): Promise<void> {
    requirePermission(actor.permissions, 'FISCAL_CONFIG');
    const input = nfceConfigInputSchema.parse(rawInput);

    const store = await db.prepare(`SELECT id FROM stores WHERE id = ? AND tenant_id = ?`).bind(storeId, tenantId).first<{ id: string }>();
    if (!store) {
        throw new RuleError('Loja não encontrada.', 404);
    }

    const cscPayload: EncryptedPayload = encryptPayload(input.csc);

    const existing = await db
        .prepare(`SELECT id FROM fiscal_configurations WHERE tenant_id = ? AND store_id = ? AND model = '65'`)
        .bind(tenantId, storeId)
        .first<{ id: string }>();

    if (existing) {
        await db
            .prepare(
                `UPDATE fiscal_configurations SET
                 series = ?, crt = ?, csc_id = ?, csc_encrypted = ?, qrcode_base_url = ?, updated_at = ?
                 WHERE id = ? AND tenant_id = ?`,
            )
            .bind(input.series, input.crt, input.cscId, JSON.stringify(cscPayload), input.qrCodeBaseUrl, now, existing.id, tenantId)
            .run();
    } else {
        const id = randomUUID();
        await db
            .prepare(
                `INSERT INTO fiscal_configurations (
                     id, tenant_id, store_id, environment, model, series, crt, csc_id, csc_encrypted, qrcode_base_url, created_at, updated_at
                 ) VALUES (?, ?, ?, 'homologacao', '65', ?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(id, tenantId, storeId, input.series, input.crt, input.cscId, JSON.stringify(cscPayload), input.qrCodeBaseUrl, now, now)
            .run();
    }
}

/**
 * Geração de NFC-e (Modelo 65) a partir de uma venda. Espelha `generateNFeForSale` (mesmas
 * regras de "nunca presumir" §36/§37 para NCM/CFOP/origem/CST-CSOSN/CRT/dados cadastrais da
 * loja), mas com as particularidades de NFC-e do §20: destinatário sempre opcional (nunca
 * força o texto de homologação sobre um CPF/CNPJ real informado), numeração/série próprias
 * do modelo 65, e QR Code obrigatório (calculado a partir do CSC configurado — bloqueia se
 * ausente, nunca presume/inventa um CSC).
 */
export async function generateNFCeForSale(
    db: D1Database,
    tenantId: string,
    saleId: string,
    actor: Actor,
    now = Date.now(),
): Promise<FiscalDocumentSummary> {
    requirePermission(actor.permissions, 'FISCAL_ISSUE');

    const sale = await db
        .prepare(
            `SELECT id, store_id AS storeId, total, customer, document, status
             FROM sales WHERE id = ? AND tenant_id = ?`,
        )
        .bind(saleId, tenantId)
        .first<{ id: string; storeId: string; total: number; customer: string | null; document: string | null; status: string }>();

    if (!sale) {
        throw new RuleError('Venda não encontrada.', 404);
    }
    if (sale.status === 'CANCELLED') {
        throw new RuleError('Não é possível emitir NFC-e para uma venda cancelada.', 400);
    }

    const existingDoc = await db
        .prepare(
            `SELECT id, series, number FROM fiscal_documents
             WHERE sale_id = ? AND tenant_id = ? AND status != 'REJECTED'`,
        )
        .bind(saleId, tenantId)
        .first<{ id: string; series: number; number: number }>();
    if (existingDoc) {
        throw new RuleError(`Esta venda já possui documento fiscal emitido ou gerado (Série ${existingDoc.series}, Nº ${existingDoc.number}).`, 409);
    }

    const store = await db
        .prepare(
            `SELECT id, name, legal_name AS legalName, cnpj, ie, uf, city, municipality_code AS municipalityCode,
                    address, number, district, zip
             FROM stores WHERE id = ? AND tenant_id = ?`,
        )
        .bind(sale.storeId, tenantId)
        .first<{
            id: string; name: string; legalName: string | null; cnpj: string | null; ie: string | null;
            uf: string | null; city: string | null; municipalityCode: string | null;
            address: string | null; number: string | null; district: string | null; zip: string | null;
        }>();
    if (!store) {
        throw new RuleError('Loja emissora não encontrada.', 404);
    }

    const cleanCnpj = (store.cnpj || '').replace(/\D/g, '');
    if (cleanCnpj.length !== 14) {
        throw new RuleError('A loja não possui CNPJ válido com 14 dígitos cadastrado para emissão fiscal.', 400);
    }
    const cleanIe = (store.ie || '').replace(/\D/g, '');
    if (!cleanIe) {
        throw new RuleError('A loja não possui Inscrição Estadual (IE) cadastrada.', 400);
    }
    const cleanUf = (store.uf || '').trim().toUpperCase();
    if (cleanUf.length !== 2) {
        throw new RuleError('A loja não possui UF válida cadastrada.', 400);
    }
    const cleanMun = (store.municipalityCode || '').replace(/\D/g, '');
    if (cleanMun.length !== 7) {
        throw new RuleError('A loja não possui Código IBGE do Município (7 dígitos) cadastrado.', 400);
    }
    if (!store.address || !store.district || !store.zip) {
        throw new RuleError('Endereço completo da loja (logradouro, bairro, CEP) é obrigatório para NFC-e.', 400);
    }

    const nfceConfig = await db
        .prepare(
            `SELECT series, crt, csc_id AS cscId, csc_encrypted AS cscEncrypted, qrcode_base_url AS qrCodeBaseUrl
             FROM fiscal_configurations WHERE tenant_id = ? AND store_id = ? AND model = '65'`,
        )
        .bind(tenantId, sale.storeId)
        .first<{ series: number; crt: CRT; cscId: string | null; cscEncrypted: string | null; qrCodeBaseUrl: string | null }>();

    if (!nfceConfig) {
        throw new RuleError('Configure a NFC-e (série, CRT, CSC e URL do QR Code) para esta loja antes de emitir.', 400);
    }
    if (!nfceConfig.cscId || !nfceConfig.cscEncrypted) {
        throw new RuleError('CSC (Código de Segurança do Contribuinte) não configurado para esta loja. Configure-o antes de emitir NFC-e.', 400);
    }
    if (!nfceConfig.qrCodeBaseUrl) {
        throw new RuleError('URL de consulta do QR Code não configurada para esta loja.', 400);
    }

    const series = nfceConfig.series;
    const crt = nfceConfig.crt;
    const csc = decryptPayload(JSON.parse(nfceConfig.cscEncrypted) as EncryptedPayload).toString('utf8');

    const itemsRows = await db
        .prepare(
            `SELECT si.product_id AS productId, si.qty AS qty, si.price AS priceCents,
                    p.name, p.sku, p.barcode, p.unit,
                    pfp.ncm, pfp.cest, pfp.legacy_cfop AS cfop, pfp.origin, pfp.tax_code AS taxCode
             FROM sale_items si
             JOIN products p ON si.product_id = p.id AND p.tenant_id = ?
             LEFT JOIN product_fiscal_profiles pfp ON p.id = pfp.product_id
             WHERE si.sale_id = ?`,
        )
        .bind(tenantId, saleId)
        .all<{
            productId: string; qty: number; priceCents: number; name: string; sku: string; barcode: string | null;
            unit: string | null; ncm: string | null; cest: string | null; cfop: string | null; origin: string | null; taxCode: string | null;
        }>();

    if (!itemsRows.results.length) {
        throw new RuleError('A venda não contém itens registrados.', 400);
    }

    const nfceItems: NFeItem[] = itemsRows.results.map((item) => {
        const cleanNcm = (item.ncm || '').replace(/\D/g, '');
        if (cleanNcm.length !== 8) {
            throw new RuleError(`Produto "${item.name}" não possui NCM válido de 8 dígitos cadastrado.`, 400);
        }
        const cleanCfop = (item.cfop || '').replace(/\D/g, '');
        if (cleanCfop.length !== 4) {
            throw new RuleError(`Produto "${item.name}" não possui CFOP válido de 4 dígitos cadastrado.`, 400);
        }
        return {
            code: item.sku || item.productId.slice(0, 8),
            barcode: item.barcode || undefined,
            description: item.name,
            ncm: cleanNcm,
            cest: item.cest ? item.cest.replace(/\D/g, '') : undefined,
            cfop: cleanCfop,
            unit: item.unit || 'UN',
            qty: item.qty,
            unitPrice: item.priceCents,
            totalPrice: item.qty * item.priceCents,
            origin: item.origin || '',
            taxCode: item.taxCode || '',
        };
    });

    const paymentRows = await db.prepare(`SELECT method, amount AS amountCents FROM sale_payments WHERE sale_id = ?`).bind(saleId).all<{ method: string; amountCents: number }>();
    const nfcePayments: NFePayment[] = paymentRows.results.length
        ? paymentRows.results.map((p) => ({ method: p.method, amount: p.amountCents }))
        : [{ method: 'Dinheiro', amount: sale.total }];

    // Destinatário na NFC-e é sempre opcional (§20: "identificação do consumidor quando
    // aplicável") — nunca força um CPF/CNPJ ou literal de homologação sobre uma venda que
    // não identificou o consumidor; só preenche <dest> quando a venda já tem documento.
    const cleanRecipientDoc = sale.document ? sale.document.replace(/\D/g, '') : undefined;

    const number = await getNextFiscalNumber(db, tenantId, sale.storeId, '65', series);
    const emissionDate = new Date(now);

    // 1. Gera a chave de acesso primeiro (fora do builder) para poder calcular o QR Code
    //    antes de montar o XML final — repassa o mesmo numericCode ao builder para obter
    //    exatamente a mesma chave de acesso na montagem.
    const { accessKey, numericCode } = generateAccessKey({
        uf: cleanUf,
        emissionDate,
        cnpj: cleanCnpj,
        model: '65',
        series,
        number,
    });

    const { url: qrCodeUrl } = buildNFCeQrCode({
        environment: 'homologacao',
        qrCodeBaseUrl: nfceConfig.qrCodeBaseUrl,
        accessKey,
        cscId: nfceConfig.cscId,
        csc,
        recipientDocument: cleanRecipientDoc,
    });

    const { xml } = buildNFeXml({
        environment: 'homologacao',
        model: '65',
        series,
        number,
        numericCode,
        emissionDate,
        issuer: {
            cnpj: cleanCnpj,
            legalName: store.legalName || store.name,
            tradeName: store.name,
            ie: cleanIe,
            crt,
            uf: cleanUf,
            city: store.city || '',
            municipalityCode: cleanMun,
            address: store.address,
            number: store.number || 'SN',
            district: store.district,
            zip: store.zip,
        },
        recipient: cleanRecipientDoc ? { document: cleanRecipientDoc, name: sale.customer || 'CONSUMIDOR' } : undefined,
        items: nfceItems,
        payments: nfcePayments,
        qrCode: { url: qrCodeUrl },
    });

    const validation = validateNFeXmlSchema(xml, '65');
    if (!validation.valid) {
        throw new RuleError(`Falha na validação de schema XSD (NFC-e): ${validation.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`, 400);
    }

    const docId = randomUUID();
    await db
        .prepare(
            `INSERT INTO fiscal_documents (
                 id, tenant_id, store_id, sale_id, model, series, number, access_key,
                 status, raw_xml, issued_at
             ) VALUES (?, ?, ?, ?, '65', ?, ?, ?, 'GENERATED', ?, ?)`,
        )
        .bind(docId, tenantId, sale.storeId, saleId, series, number, accessKey, xml, now)
        .run();

    await db
        .prepare(
            `INSERT INTO fiscal_audit_logs (id, tenant_id, store_id, operation, request_payload, response_payload, status_code, created_at)
             VALUES (?, ?, ?, 'nfce.generate', ?, ?, 200, ?)`,
        )
        .bind(randomUUID(), tenantId, sale.storeId, JSON.stringify({ saleId, accessKey, series, number }), 'NFC-e gerada e validada contra schema com sucesso.', now)
        .run();

    return {
        id: docId,
        saleId,
        model: '65',
        series,
        number,
        accessKey,
        status: 'GENERATED',
        rawXml: xml,
        issuedAt: now,
    };
}

/**
 * Monta os dados do DANFE NFC-e (§20/§22) a partir de um documento modelo 65 já
 * autorizado. Mesma regra do NF-e: nunca gera representação para documento não
 * autorizado. O QR Code já foi calculado na geração (`generateNFCeForSale`) e fica
 * embutido no XML — aqui é apenas extraído do XML persistido, nunca recalculado/inventado.
 *
 * LIMITAÇÃO EXPLÍCITA: `buildDanfeNfceHtml` (lib/fiscal/danfe.ts) renderiza a URL do QR
 * Code como link/texto, não como imagem escaneável — este projeto não tem uma biblioteca
 * de geração de imagem QR disponível. Para uso real em caixa, é necessário integrar uma
 * lib de QR (ex.: renderização client-side) antes de imprimir o cupom para o consumidor.
 */
export async function getNFCeDanfeData(db: D1Database, tenantId: string, saleId: string, actor: Actor): Promise<import('./danfe.ts').DanfeNfceData> {
    requirePermission(actor.permissions, 'FISCAL_VIEW');

    const doc = await db
        .prepare(
            `SELECT id, store_id AS storeId, series, number, access_key AS accessKey, protocol_number AS protocolNumber,
                    authorized_at AS authorizedAt, status, authorized_xml AS authorizedXml, raw_xml AS rawXml
             FROM fiscal_documents WHERE sale_id = ? AND tenant_id = ? AND model = '65'`,
        )
        .bind(saleId, tenantId)
        .first<{ id: string; storeId: string; series: number; number: number; accessKey: string; protocolNumber: string | null; authorizedAt: number | null; status: string; authorizedXml: string | null; rawXml: string | null }>();

    if (!doc) throw new RuleError('Nenhuma NFC-e gerada para esta venda.', 404);
    if (doc.status !== 'AUTHORIZED' || !doc.protocolNumber || !doc.authorizedAt) {
        throw new RuleError(`DANFE NFC-e só pode ser exibido para NFC-e autorizada. Status atual: ${doc.status}.`, 409);
    }

    const xmlSource = doc.authorizedXml || doc.rawXml || '';
    const qrMatch = xmlSource.match(/<qrCode>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/qrCode>/);
    const qrCodeUrl = qrMatch?.[1] || '';
    if (!qrCodeUrl) {
        throw new RuleError('QR Code não encontrado no XML autorizado desta NFC-e.', 500);
    }

    const store = await db
        .prepare(`SELECT legal_name AS legalName, name, cnpj FROM stores WHERE id = ? AND tenant_id = ?`)
        .bind(doc.storeId, tenantId)
        .first<{ legalName: string | null; name: string; cnpj: string }>();
    if (!store) throw new RuleError('Loja emissora não encontrada.', 404);

    const sale = await db.prepare(`SELECT document FROM sales WHERE id = ? AND tenant_id = ?`).bind(saleId, tenantId).first<{ document: string | null }>();

    const itemsRows = await db
        .prepare(`SELECT si.qty AS qty, si.price AS unitPrice, si.name AS description, si.sku AS code FROM sale_items si WHERE si.sale_id = ?`)
        .bind(saleId)
        .all<{ qty: number; unitPrice: number; description: string; code: string }>();

    const paymentRows = await db.prepare(`SELECT method, amount FROM sale_payments WHERE sale_id = ?`).bind(saleId).all<{ method: string; amount: number }>();

    const items = itemsRows.results.map((i) => ({ code: i.code, description: i.description, ncm: '', cfop: '', unit: '', qty: i.qty, unitPrice: i.unitPrice, totalPrice: i.qty * i.unitPrice }));
    const total = items.reduce((a, i) => a + i.totalPrice, 0);

    return {
        accessKey: doc.accessKey,
        series: doc.series,
        number: doc.number,
        protocolNumber: doc.protocolNumber,
        authorizedAt: doc.authorizedAt,
        environment: 'homologacao',
        qrCodeUrl,
        issuer: { legalName: store.legalName || store.name, tradeName: store.name, cnpj: store.cnpj },
        consumer: sale?.document ? { document: sale.document } : null,
        items,
        payments: paymentRows.results.map((p) => ({ method: p.method, amount: p.amount })),
        total,
    };
}
