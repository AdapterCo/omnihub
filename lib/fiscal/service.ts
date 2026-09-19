import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { RuleError } from '../errors.ts';
import { localParts } from '../time.ts';
import { requirePermission } from '../authz/service.ts';
import type { Actor } from '../domain.ts';
import {
    encryptPayload,
    decryptPayload,
    validateA1Certificate,
    saveFiscalCertificate,
    loadFiscalCertificate,
    type EncryptedPayload,
} from './certificate.ts';
import { resolveSefazEndpoint } from './endpoints.ts';
import { SefazDirectGateway, type FiscalGateway } from './gateway.ts';
import { buildNFeXml, type NFeItem, type NFePayment } from './builder.ts';
import { validateNFeXmlSchema } from './validator.ts';
import { signNFeXml, signEventXml, signInutilizacaoXml } from './signer.ts';
import { getNextFiscalNumber } from './sequence.ts';
import { buildCancellationEventXml } from './events.ts';
import { buildInutilizacaoXml } from './inutilizacao.ts';
import type {
    CRT,
    FiscalConfiguration,
    FiscalCertificateRecord,
    FiscalDocumentSummary,
    FiscalInutilizationSummary,
} from './types.ts';
export type { FiscalDocumentSummary, FiscalInutilizationSummary };

export type CertificateStatus = 'NOT_CONFIGURED' | 'VALID' | 'EXPIRING' | 'EXPIRED' | 'INVALID';

export type CertificateSummary = {
    id: string;
    subjectCnpj: string;
    validFrom: number;
    validTo: number;
    fingerprint: string;
    status: CertificateStatus;
};

export type FiscalStoreConfig = {
    storeId: string;
    environment: 'homologacao';
    model: '55';
    series: number;
    crt: CRT;
    certificate?: CertificateSummary | null;
    status: 'NOT_CONFIGURED' | 'CONFIGURED' | 'CERTIFICATE_VALID' | 'CONNECTIVITY_VALIDATED';
};

export const fiscalConfigInputSchema = z.object({
    series: z.number().int().min(1, 'Série deve ser maior ou igual a 1.').max(999, 'Série máxima é 999.').default(1),
    crt: z.enum(['1_SIMPLES_NACIONAL', '2_SIMPLES_EXCESSO', '3_REGIME_NORMAL']),
}).strict();

export type FiscalConfigInput = z.infer<typeof fiscalConfigInputSchema>;

export type ConnectivityTestResult = {
    environment: 'homologacao';
    uf: string;
    authorizer: string;
    service: 'NFeStatusServico4';
    cStat: string;
    xMotivo: string;
    dhRecbto: string;
    tMed: string;
    durationMs: number;
    status: 'OPERATIONAL' | 'OFFLINE' | 'REJECTED';
};

function calculateCertStatus(validTo: number, validFrom: number, now = Date.now()): CertificateStatus {
    if (now < validFrom || now > validTo) return 'EXPIRED';
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    if (validTo - now < thirtyDaysMs) return 'EXPIRING';
    return 'VALID';
}

export async function getFiscalStoreConfig(
    db: D1Database,
    tenantId: string,
    storeId: string,
    actor: Actor,
    now = Date.now(),
): Promise<FiscalStoreConfig> {
    requirePermission(actor.permissions, 'FISCAL_VIEW');

    const configRow = await db
        .prepare(
            `SELECT id, tenant_id AS tenantId, store_id AS storeId, environment, model, series, crt,
                    certificate_id AS certificateId, created_at AS createdAt, updated_at AS updatedAt
             FROM fiscal_configurations
             WHERE tenant_id = ? AND store_id = ? AND model = '55'`,
        )
        .bind(tenantId, storeId)
        .first<FiscalConfiguration>();

    let certificate: CertificateSummary | null = null;
    const certId = configRow?.certificateId;

    if (certId) {
        const certRow = await db
            .prepare(
                `SELECT id, subject_cnpj AS subjectCnpj, valid_from AS validFrom, valid_to AS validTo, fingerprint
                 FROM fiscal_certificates
                 WHERE id = ? AND tenant_id = ?`,
            )
            .bind(certId, tenantId)
            .first<{ id: string; subjectCnpj: string; validFrom: number; validTo: number; fingerprint: string }>();

        if (certRow) {
            certificate = {
                id: certRow.id,
                subjectCnpj: certRow.subjectCnpj,
                validFrom: certRow.validFrom,
                validTo: certRow.validTo,
                fingerprint: certRow.fingerprint,
                status: calculateCertStatus(certRow.validTo, certRow.validFrom, now),
            };
        }
    }

    let status: FiscalStoreConfig['status'] = 'NOT_CONFIGURED';
    if (configRow) {
        if (!certificate || certificate.status === 'EXPIRED' || certificate.status === 'INVALID') {
            status = 'CONFIGURED';
        } else {
            status = 'CERTIFICATE_VALID';
        }
    }

    return {
        storeId,
        environment: 'homologacao',
        model: '55',
        series: configRow?.series ?? 1,
        crt: configRow?.crt ?? '1_SIMPLES_NACIONAL',
        certificate,
        status,
    };
}

export async function saveFiscalStoreConfig(
    db: D1Database,
    tenantId: string,
    storeId: string,
    rawInput: unknown,
    actor: Actor,
    now = Date.now(),
): Promise<void> {
    requirePermission(actor.permissions, 'FISCAL_CONFIG');
    const input = fiscalConfigInputSchema.parse(rawInput);

    // Valida existência da loja no tenant
    const store = await db
        .prepare(`SELECT id FROM stores WHERE id = ? AND tenant_id = ?`)
        .bind(storeId, tenantId)
        .first<{ id: string }>();

    if (!store) {
        throw new RuleError('Loja não encontrada.', 404);
    }

    const existing = await db
        .prepare(`SELECT id FROM fiscal_configurations WHERE tenant_id = ? AND store_id = ? AND model = '55'`)
        .bind(tenantId, storeId)
        .first<{ id: string }>();

    if (existing) {
        await db
            .prepare(
                `UPDATE fiscal_configurations SET
                 series = ?, crt = ?, updated_at = ?
                 WHERE id = ? AND tenant_id = ?`,
            )
            .bind(input.series, input.crt, now, existing.id, tenantId)
            .run();
    } else {
        const id = randomUUID();
        await db
            .prepare(
                `INSERT INTO fiscal_configurations (
                     id, tenant_id, store_id, environment, model, series, crt, created_at, updated_at
                 ) VALUES (?, ?, ?, 'homologacao', '55', ?, ?, ?, ?)`,
            )
            .bind(id, tenantId, storeId, input.series, input.crt, now, now)
            .run();
    }
}

export async function uploadCertificate(
    db: D1Database,
    tenantId: string,
    storeId: string,
    pfxBuffer: Buffer,
    passphrase: string,
    actor: Actor,
    now = Date.now(),
): Promise<CertificateSummary> {
    requirePermission(actor.permissions, 'FISCAL_CONFIG');

    // Valida existência da loja
    const store = await db
        .prepare(`SELECT id, cnpj FROM stores WHERE id = ? AND tenant_id = ?`)
        .bind(storeId, tenantId)
        .first<{ id: string; cnpj: string }>();

    if (!store) {
        throw new RuleError('Loja não encontrada.', 404);
    }

    const saved = await saveFiscalCertificate(db, tenantId, { storeId, pfxBuffer, passphrase }, now);

    // Vincula na fiscal_configurations da loja (cria se ainda não existir)
    const existingConfig = await db
        .prepare(`SELECT id FROM fiscal_configurations WHERE tenant_id = ? AND store_id = ? AND model = '55'`)
        .bind(tenantId, storeId)
        .first<{ id: string }>();

    if (existingConfig) {
        await db
            .prepare(`UPDATE fiscal_configurations SET certificate_id = ?, updated_at = ? WHERE id = ?`)
            .bind(saved.id, now, existingConfig.id)
            .run();
    } else {
        const configId = randomUUID();
        await db
            .prepare(
                `INSERT INTO fiscal_configurations (
                     id, tenant_id, store_id, environment, model, series, crt, certificate_id, created_at, updated_at
                 ) VALUES (?, ?, ?, 'homologacao', '55', 1, '1_SIMPLES_NACIONAL', ?, ?, ?)`,
            )
            .bind(configId, tenantId, storeId, saved.id, now, now)
            .run();
    }

    return {
        id: saved.id,
        subjectCnpj: saved.subjectCnpj,
        validFrom: saved.validFrom,
        validTo: saved.validTo,
        fingerprint: saved.fingerprint,
        status: calculateCertStatus(saved.validTo, saved.validFrom, now),
    };
}

export async function testSefazConnectivity(
    db: D1Database,
    tenantId: string,
    storeId: string,
    actor: Actor,
    gateway: FiscalGateway = new SefazDirectGateway(),
    now = Date.now(),
): Promise<ConnectivityTestResult> {
    requirePermission(actor.permissions, 'FISCAL_CONFIG');

    const store = await db
        .prepare(`SELECT id, name, uf FROM stores WHERE id = ? AND tenant_id = ?`)
        .bind(storeId, tenantId)
        .first<{ id: string; name: string; uf: string | null }>();

    if (!store) {
        throw new RuleError('Loja não encontrada.', 404);
    }
    if (!store.uf || store.uf.trim().length !== 2) {
        throw new RuleError('Loja não possui UF válida cadastrada (necessário para resolver os Web Services da SEFAZ).', 400);
    }

    const config = await db
        .prepare(`SELECT certificate_id AS certificateId FROM fiscal_configurations WHERE tenant_id = ? AND store_id = ? AND model = '55'`)
        .bind(tenantId, storeId)
        .first<{ certificateId: string | null }>();

    if (!config || !config.certificateId) {
        throw new RuleError('Certificado Digital A1 não configurado para esta loja.', 400);
    }

    const { pfx, passphrase, parsed } = await loadFiscalCertificate(db, tenantId, config.certificateId);

    if (now > parsed.validTo) {
        throw new RuleError('Certificado digital A1 está expirado.', 400);
    }

    const uf = store.uf.trim().toUpperCase();
    const endpointInfo = resolveSefazEndpoint({
        uf,
        environment: 'homologacao',
        service: 'NFeStatusServico4',
    });

    const startTime = Date.now();
    let serviceResult;
    try {
        serviceResult = await gateway.checkServiceStatus({
            uf,
            environment: 'homologacao',
            pfx,
            passphrase,
        });
    } catch (err) {
        const duration = Date.now() - startTime;
        // Grava auditoria da tentativa com falha
        await db
            .prepare(
                `INSERT INTO fiscal_audit_logs (
                     id, tenant_id, store_id, operation, request_payload, response_payload, status_code, created_at
                 ) VALUES (?, ?, ?, 'NFeStatusServico4', ?, ?, ?, ?)`,
            )
            .bind(
                randomUUID(),
                tenantId,
                storeId,
                JSON.stringify({ uf, environment: 'homologacao', service: 'NFeStatusServico4' }),
                err instanceof Error ? err.message : String(err),
                502,
                now,
            )
            .run();
        throw err;
    }

    const durationMs = Date.now() - startTime;

    // Registra auditoria da consulta com sucesso
    await db
        .prepare(
            `INSERT INTO fiscal_audit_logs (
                 id, tenant_id, store_id, operation, request_payload, response_payload, status_code, created_at
             ) VALUES (?, ?, ?, 'NFeStatusServico4', ?, ?, ?, ?)`,
        )
        .bind(
            randomUUID(),
            tenantId,
            storeId,
            JSON.stringify({ uf, environment: 'homologacao', service: 'NFeStatusServico4' }),
            serviceResult.rawXml,
            200,
            now,
        )
        .run();

    const isOperational = serviceResult.cStat === '107';

    return {
        environment: 'homologacao',
        uf,
        authorizer: endpointInfo.authorizer,
        service: 'NFeStatusServico4',
        cStat: serviceResult.cStat,
        xMotivo: serviceResult.xMotivo,
        dhRecbto: serviceResult.dhRecbto,
        tMed: serviceResult.tMed,
        durationMs,
        status: isOperational ? 'OPERATIONAL' : 'REJECTED',
    };
}

export async function generateNFeForSale(
    db: D1Database,
    tenantId: string,
    saleId: string,
    actor: Actor,
    now = Date.now(),
): Promise<FiscalDocumentSummary> {
    requirePermission(actor.permissions, 'FISCAL_ISSUE');

    // 1. Carrega a venda
    const sale = await db
        .prepare(
            `SELECT id, store_id AS storeId, user_id AS userId, total, customer, document, status, created_at AS createdAt
             FROM sales
             WHERE id = ? AND tenant_id = ?`,
        )
        .bind(saleId, tenantId)
        .first<{
            id: string;
            storeId: string;
            userId: string;
            total: number;
            customer: string | null;
            document: string | null;
            status: string;
            createdAt: number;
        }>();

    if (!sale) {
        throw new RuleError('Venda não encontrada.', 404);
    }
    if (sale.status === 'CANCELLED') {
        throw new RuleError('Não é possível emitir NF-e para uma venda cancelada.', 400);
    }

    // 2. Impede duplicidade de emissão para a mesma venda
    const existingDoc = await db
        .prepare(
            `SELECT id, series, number, access_key AS accessKey, status
             FROM fiscal_documents
             WHERE sale_id = ? AND tenant_id = ? AND status != 'REJECTED'`,
        )
        .bind(saleId, tenantId)
        .first<{ id: string; series: number; number: number; accessKey: string; status: string }>();

    if (existingDoc) {
        throw new RuleError(
            `Esta venda já possui documento fiscal emitido ou gerado (Série ${existingDoc.series}, Nº ${existingDoc.number}).`,
            409,
        );
    }

    // 3. Carrega os dados cadastrais da loja
    const store = await db
        .prepare(
            `SELECT id, name, legal_name AS legalName, cnpj, ie, uf, city, municipality_code AS municipalityCode,
                    address, number, district, zip
             FROM stores
             WHERE id = ? AND tenant_id = ?`,
        )
        .bind(sale.storeId, tenantId)
        .first<{
            id: string;
            name: string;
            legalName: string | null;
            cnpj: string | null;
            ie: string | null;
            uf: string | null;
            city: string | null;
            municipalityCode: string | null;
            address: string | null;
            number: string | null;
            district: string | null;
            zip: string | null;
        }>();

    if (!store) {
        throw new RuleError('Loja emissora não encontrada.', 404);
    }

    // Validações cadastrais obrigatórias (§79: bloquear sem suposições)
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
        throw new RuleError('Endereço completo da loja (logradouro, bairro, CEP) é obrigatório para NF-e.', 400);
    }

    // 4. Carrega configuração fiscal da loja (série e CRT)
    const fiscalConfig = await db
        .prepare(
            `SELECT series, crt
             FROM fiscal_configurations
             WHERE tenant_id = ? AND store_id = ? AND model = '55'`,
        )
        .bind(tenantId, sale.storeId)
        .first<{ series: number; crt: CRT }>();

    // Nunca presumir o regime tributário (§37: "não assumir que todas as empresas sejam
    // Simples Nacional"). Sem configuração fiscal salva (fiscal.config.save) para a loja,
    // bloqueia — não gera NF-e com um CRT adivinhado.
    if (!fiscalConfig) {
        throw new RuleError('Configure o regime tributário (CRT) e a série da loja em Configuração fiscal antes de emitir NF-e.', 400);
    }
    const series = fiscalConfig.series;
    const crt = fiscalConfig.crt;

    // 5. Carrega itens da venda e respectivos perfis fiscais
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
            productId: string;
            qty: number;
            priceCents: number;
            name: string;
            sku: string;
            barcode: string | null;
            unit: string | null;
            ncm: string | null;
            cest: string | null;
            cfop: string | null;
            origin: string | null;
            taxCode: string | null;
        }>();

    if (!itemsRows.results.length) {
        throw new RuleError('A venda não contém itens registrados.', 400);
    }

    const nfeItems: NFeItem[] = itemsRows.results.map((item) => {
        const cleanNcm = (item.ncm || '').replace(/\D/g, '');
        if (cleanNcm.length !== 8) {
            throw new RuleError(`Produto "${item.name}" não possui NCM válido de 8 dígitos cadastrado.`, 400);
        }
        // Nunca presumir (§34/§35/§36): CFOP depende da operação e do cadastro do produto,
        // nunca de um valor genérico "padrão de venda" — sem CFOP cadastrado, bloqueia.
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
            // Nunca presumir (§36): repassa exatamente o que está cadastrado no produto;
            // buildNFeXml bloqueia a emissão se estiver vazio ou não suportado.
            origin: item.origin || '',
            taxCode: item.taxCode || '',
        };
    });

    // 6. Carrega os pagamentos da venda
    const paymentRows = await db
        .prepare(`SELECT method, amount AS amountCents FROM sale_payments WHERE sale_id = ?`)
        .bind(saleId)
        .all<{ method: string; amountCents: number }>();

    const nfePayments: NFePayment[] = paymentRows.results.length
        ? paymentRows.results.map((p) => ({ method: p.method, amount: p.amountCents }))
        : [{ method: 'Dinheiro', amount: sale.total }];

    // 7. Destinatário (em homologação, se não informado na venda, preenche consumidor homologação)
    const recipient = sale.document
        ? {
              document: sale.document.replace(/\D/g, ''),
              name: sale.customer || 'CONSUMIDOR FINAL',
          }
        : {
              document: '00000000000',
              name: 'NF-E EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL',
          };

    // 8. Obtenção atômica do próximo número sequencial da série
    const number = await getNextFiscalNumber(db, tenantId, sale.storeId, '55', series);

    // 9. Construção do XML 4.00 e chave de acesso oficial
    const { xml, accessKey } = buildNFeXml({
        environment: 'homologacao',
        series,
        number,
        emissionDate: new Date(now),
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
        recipient,
        items: nfeItems,
        payments: nfePayments,
    });

    // 10. Validação Sintática formal contra os schemas XSD oficiais do pacote PL_009k
    const validation = validateNFeXmlSchema(xml);
    if (!validation.valid) {
        throw new RuleError(
            `Falha na validação de schema XSD (PL_009k): ${validation.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`,
            400,
        );
    }

    // 11. Persistência em fiscal_documents com status 'GENERATED'
    const docId = randomUUID();
    await db
        .prepare(
            `INSERT INTO fiscal_documents (
                 id, tenant_id, store_id, sale_id, model, series, number, access_key,
                 status, raw_xml, issued_at
             ) VALUES (?, ?, ?, ?, '55', ?, ?, ?, 'GENERATED', ?, ?)`,
        )
        .bind(docId, tenantId, sale.storeId, saleId, series, number, accessKey, xml, now)
        .run();

    // 12. Auditoria
    await db
        .prepare(
            `INSERT INTO fiscal_audit_logs (
                 id, tenant_id, store_id, operation, request_payload, response_payload, status_code, created_at
             ) VALUES (?, ?, ?, 'nfe.generate', ?, ?, 200, ?)`,
        )
        .bind(
            randomUUID(),
            tenantId,
            sale.storeId,
            JSON.stringify({ saleId, accessKey, series, number }),
            'NF-e gerada e validada contra schema XSD PL_009k com sucesso.',
            now,
        )
        .run();

    return {
        id: docId,
        saleId,
        model: '55',
        series,
        number,
        accessKey,
        status: 'GENERATED',
        rawXml: xml,
        issuedAt: now,
    };
}

/**
 * Marco 3 (Fase 5): assina digitalmente o XML já gerado/validado (Marco 2) e transmite
 * para o autorizador oficial da SEFAZ em Homologação via `FiscalGateway.authorizeNFe`.
 * Interpreta a resposta (cStat/xMotivo/nProt) e move o documento para AUTHORIZED ou
 * REJECTED — nunca inventa autorização (§27: rejeição nunca vira autorização automática).
 *
 * Estrutura exata do envelope SOAP (`enviNFe`/`nfeAutorizacao4`) e o mapeamento de cStat
 * não foram reverificados contra uma fonte oficial ao vivo nesta sessão (o Portal Nacional
 * da NF-e devolveu um loop de redirecionamento e o endpoint real da SEFAZ exige uma cadeia
 * de certificação ICP-Brasil que este ambiente não possui) — confirmar contra o MOC 7.00
 * Anexo II antes do primeiro envio real.
 */
export async function transmitNFe(
    db: D1Database,
    tenantId: string,
    saleId: string,
    actor: Actor,
    gateway: FiscalGateway = new SefazDirectGateway(),
    now = Date.now(),
): Promise<FiscalDocumentSummary> {
    requirePermission(actor.permissions, 'FISCAL_ISSUE');

    const doc = await db
        .prepare(
            `SELECT id, store_id AS storeId, sale_id AS saleId, series, number, access_key AS accessKey,
                    status, raw_xml AS rawXml
             FROM fiscal_documents
             WHERE sale_id = ? AND tenant_id = ?`,
        )
        .bind(saleId, tenantId)
        .first<{ id: string; storeId: string; saleId: string; series: number; number: number; accessKey: string; status: string; rawXml: string | null }>();

    if (!doc) {
        throw new RuleError('Nenhuma NF-e gerada para esta venda. Gere a NF-e (Marco 2) antes de transmitir.', 404);
    }
    if (doc.status === 'AUTHORIZED') {
        throw new RuleError(`Esta NF-e já está autorizada (Nº ${doc.number}).`, 409);
    }
    if (doc.status === 'CANCELLED') {
        throw new RuleError('Esta NF-e está cancelada e não pode ser transmitida.', 409);
    }
    if (!doc.rawXml) {
        throw new RuleError('Documento fiscal sem XML gerado.', 400);
    }

    const store = await db
        .prepare(`SELECT id, uf, cnpj FROM stores WHERE id = ? AND tenant_id = ?`)
        .bind(doc.storeId, tenantId)
        .first<{ id: string; uf: string | null; cnpj: string | null }>();
    if (!store || !store.uf || store.uf.trim().length !== 2) {
        throw new RuleError('Loja emissora sem UF válida cadastrada.', 400);
    }

    const config = await db
        .prepare(`SELECT certificate_id AS certificateId FROM fiscal_configurations WHERE tenant_id = ? AND store_id = ? AND model = '55'`)
        .bind(tenantId, doc.storeId)
        .first<{ certificateId: string | null }>();
    if (!config || !config.certificateId) {
        throw new RuleError('Certificado Digital A1 não configurado para esta loja.', 400);
    }

    const { pfx, passphrase, parsed } = await loadFiscalCertificate(db, tenantId, config.certificateId);
    if (now > parsed.validTo) {
        throw new RuleError('Certificado digital A1 está expirado.', 400);
    }

    // 1. Assina digitalmente (XMLDSIG)
    const { signedXml } = signNFeXml({
        xml: doc.rawXml,
        accessKey: doc.accessKey,
        privateKeyPem: parsed.privateKeyPem,
        certBase64: parsed.certBase64,
    });
    await db.prepare(`UPDATE fiscal_documents SET status = 'SIGNED', signed_xml = ? WHERE id = ?`).bind(signedXml, doc.id).run();

    const uf = store.uf!.trim().toUpperCase();
    await db.prepare(`UPDATE fiscal_documents SET status = 'TRANSMITTING' WHERE id = ?`).bind(doc.id).run();

    // 2. Transmite para o autorizador oficial (síncrono, enviNFe indSinc="1")
    let result;
    try {
        result = await gateway.authorizeNFe({ uf, environment: 'homologacao', signedXml, pfx, passphrase });
    } catch (err) {
        // Falha de comunicação: volta para SIGNED (retomável), nunca autoriza sozinho.
        await db.prepare(`UPDATE fiscal_documents SET status = 'SIGNED' WHERE id = ?`).bind(doc.id).run();
        await db
            .prepare(
                `INSERT INTO fiscal_events (id, tenant_id, fiscal_document_id, type, sequence_number, xmotivo, created_at)
                 VALUES (?, ?, ?, 'TRANSMISSION_ERROR', 1, ?, ?)`,
            )
            .bind(randomUUID(), tenantId, doc.id, err instanceof Error ? err.message : String(err), now)
            .run();
        throw err;
    }

    const authorized = result.cStat === '100';
    const nextStatus = authorized ? 'AUTHORIZED' : 'REJECTED';

    await db
        .prepare(
            `UPDATE fiscal_documents SET status = ?, cstat = ?, xmotivo = ?, protocol_number = ?, authorized_xml = ?, authorized_at = ?
             WHERE id = ?`,
        )
        .bind(nextStatus, result.cStat, result.xMotivo, result.nProt ?? null, authorized ? signedXml : null, authorized ? now : null, doc.id)
        .run();

    await db
        .prepare(
            `INSERT INTO fiscal_events (id, tenant_id, fiscal_document_id, type, sequence_number, cstat, xmotivo, protocol_number, signed_xml, created_at)
             VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
        )
        .bind(randomUUID(), tenantId, doc.id, authorized ? 'AUTHORIZATION' : 'REJECTION', result.cStat, result.xMotivo, result.nProt ?? null, signedXml, now)
        .run();

    await db
        .prepare(
            `INSERT INTO fiscal_audit_logs (id, tenant_id, store_id, fiscal_document_id, operation, request_payload, response_payload, status_code, created_at)
             VALUES (?, ?, ?, ?, 'nfe.transmit', ?, ?, ?, ?)`,
        )
        .bind(randomUUID(), tenantId, doc.storeId, doc.id, JSON.stringify({ saleId, accessKey: doc.accessKey }), result.rawXml, authorized ? 200 : 422, now)
        .run();

    return {
        id: doc.id,
        saleId: doc.saleId,
        model: '55',
        series: doc.series,
        number: doc.number,
        accessKey: doc.accessKey,
        status: nextStatus,
        signedXml,
        protocolNumber: result.nProt ?? null,
        issuedAt: now,
        authorizedAt: authorized ? now : null,
    };
}

/**
 * Cancelamento fiscal (§29): "Não executar DELETE. Registrar
 * FiscalDocument → FiscalEvent(CANCELLATION)". Só cancela um documento AUTHORIZED
 * (não há o que cancelar num rascunho/rejeitado — esses nunca chegaram a valer perante o
 * Fisco). Constrói e assina o evento `110111` e transmite via `FiscalGateway.cancelNFe`;
 * nunca marca CANCELLED sem confirmação da SEFAZ (mesmo princípio do §27 aplicado à
 * autorização: resposta negativa nunca vira sucesso automático).
 *
 * Igual ao Marco 3 (transmitNFe): a estrutura exata do envelope SOAP de
 * `NFeRecepcaoEvento4` e o cStat de sucesso (135, valor padrão amplamente documentado
 * para "Evento registrado e vinculado a NF-e") não foram reverificados contra uma fonte
 * oficial ao vivo nesta sessão — mesma limitação de rede/certificado ICP-Brasil já
 * registrada em docs/analise-inicial.md e falta.md.
 *
 * Esta função cuida apenas do lado FISCAL (documento/evento). Reversão de estoque/caixa/
 * venda (quando aplicável) é responsabilidade de `cancelSale` em lib/sales/service.ts, que
 * agora exige que a NF-e não esteja mais AUTHORIZED antes de permitir o cancelamento
 * comercial — assim a ordem "cancelar NF-e primeiro, depois a venda" fica garantida.
 */
export async function cancelNFeDocument(
    db: D1Database,
    tenantId: string,
    saleId: string,
    justification: string,
    actor: Actor,
    gateway: FiscalGateway = new SefazDirectGateway(),
    now = Date.now(),
): Promise<FiscalDocumentSummary> {
    requirePermission(actor.permissions, 'FISCAL_CANCEL');

    const doc = await db
        .prepare(
            `SELECT id, store_id AS storeId, sale_id AS saleId, series, number, access_key AS accessKey,
                    status, protocol_number AS protocolNumber, issued_at AS issuedAt
             FROM fiscal_documents
             WHERE sale_id = ? AND tenant_id = ?`,
        )
        .bind(saleId, tenantId)
        .first<{ id: string; storeId: string; saleId: string; series: number; number: number; accessKey: string; status: string; protocolNumber: string | null; issuedAt: number }>();

    if (!doc) {
        throw new RuleError('Nenhuma NF-e gerada para esta venda.', 404);
    }
    if (doc.status === 'CANCELLED') {
        throw new RuleError(`Esta NF-e já está cancelada (Nº ${doc.number}).`, 409);
    }
    if (doc.status !== 'AUTHORIZED' || !doc.protocolNumber) {
        throw new RuleError(`Só é possível cancelar uma NF-e autorizada. Status atual: ${doc.status}.`, 409);
    }

    const store = await db
        .prepare(`SELECT id, uf, cnpj FROM stores WHERE id = ? AND tenant_id = ?`)
        .bind(doc.storeId, tenantId)
        .first<{ id: string; uf: string | null; cnpj: string | null }>();
    if (!store || !store.uf || store.uf.trim().length !== 2) {
        throw new RuleError('Loja emissora sem UF válida cadastrada.', 400);
    }
    const cleanCnpj = (store.cnpj || '').replace(/\D/g, '');
    if (cleanCnpj.length !== 14) {
        throw new RuleError('A loja não possui CNPJ válido cadastrado para o evento de cancelamento.', 400);
    }

    const config = await db
        .prepare(`SELECT certificate_id AS certificateId FROM fiscal_configurations WHERE tenant_id = ? AND store_id = ? AND model = '55'`)
        .bind(tenantId, doc.storeId)
        .first<{ certificateId: string | null }>();
    if (!config || !config.certificateId) {
        throw new RuleError('Certificado Digital A1 não configurado para esta loja.', 400);
    }
    const { pfx, passphrase, parsed } = await loadFiscalCertificate(db, tenantId, config.certificateId);
    if (now > parsed.validTo) {
        throw new RuleError('Certificado digital A1 está expirado.', 400);
    }

    // Sequência do evento: quantas tentativas de cancelamento já foram registradas para
    // este documento (retentativa após erro de transmissão usa nSeqEvento seguinte).
    const priorAttempts = await db
        .prepare(`SELECT COUNT(*) AS total FROM fiscal_events WHERE fiscal_document_id = ? AND type IN ('CANCELLATION', 'CANCELLATION_REJECTED', 'CANCELLATION_ERROR')`)
        .bind(doc.id)
        .first<{ total: number }>();
    const sequenceNumber = (priorAttempts?.total ?? 0) + 1;

    const uf = store.uf.trim().toUpperCase();
    const { xml: eventXml, eventId } = buildCancellationEventXml({
        environment: 'homologacao',
        cOrgao: doc.accessKey.slice(0, 2),
        cnpj: cleanCnpj,
        accessKey: doc.accessKey,
        protocolNumber: doc.protocolNumber,
        justification,
        sequenceNumber,
    });

    const { signedXml: signedEventXml } = signEventXml({
        xml: eventXml,
        eventId,
        privateKeyPem: parsed.privateKeyPem,
        certBase64: parsed.certBase64,
    });

    let result;
    try {
        result = await gateway.cancelNFe({ uf, environment: 'homologacao', signedEventXml, pfx, passphrase });
    } catch (err) {
        await db
            .prepare(
                `INSERT INTO fiscal_events (id, tenant_id, fiscal_document_id, type, sequence_number, xmotivo, created_at)
                 VALUES (?, ?, ?, 'CANCELLATION_ERROR', ?, ?, ?)`,
            )
            .bind(randomUUID(), tenantId, doc.id, sequenceNumber, err instanceof Error ? err.message : String(err), now)
            .run();
        throw err;
    }

    const cancelled = result.cStat === '135';

    if (!cancelled) {
        await db
            .prepare(
                `INSERT INTO fiscal_events (id, tenant_id, fiscal_document_id, type, sequence_number, cstat, xmotivo, signed_xml, created_at)
                 VALUES (?, ?, ?, 'CANCELLATION_REJECTED', ?, ?, ?, ?, ?)`,
            )
            .bind(randomUUID(), tenantId, doc.id, sequenceNumber, result.cStat, result.xMotivo, signedEventXml, now)
            .run();
        await db
            .prepare(
                `INSERT INTO fiscal_audit_logs (id, tenant_id, store_id, fiscal_document_id, operation, request_payload, response_payload, status_code, created_at)
                 VALUES (?, ?, ?, ?, 'nfe.cancel', ?, ?, 422, ?)`,
            )
            .bind(randomUUID(), tenantId, doc.storeId, doc.id, JSON.stringify({ saleId, accessKey: doc.accessKey }), result.rawXml, now)
            .run();
        throw new RuleError(`SEFAZ não confirmou o cancelamento: ${result.xMotivo} (cStat ${result.cStat}).`, 422);
    }

    await db
        .prepare(`UPDATE fiscal_documents SET status = 'CANCELLED', cancelled_at = ? WHERE id = ?`)
        .bind(now, doc.id)
        .run();

    await db
        .prepare(
            `INSERT INTO fiscal_events (id, tenant_id, fiscal_document_id, type, sequence_number, cstat, xmotivo, protocol_number, signed_xml, created_at)
             VALUES (?, ?, ?, 'CANCELLATION', ?, ?, ?, ?, ?, ?)`,
        )
        .bind(randomUUID(), tenantId, doc.id, sequenceNumber, result.cStat, result.xMotivo, result.nProt ?? null, signedEventXml, now)
        .run();

    await db
        .prepare(
            `INSERT INTO fiscal_audit_logs (id, tenant_id, store_id, fiscal_document_id, operation, request_payload, response_payload, status_code, created_at)
             VALUES (?, ?, ?, ?, 'nfe.cancel', ?, ?, 200, ?)`,
        )
        .bind(randomUUID(), tenantId, doc.storeId, doc.id, JSON.stringify({ saleId, accessKey: doc.accessKey }), result.rawXml, now)
        .run();

    return {
        id: doc.id,
        saleId: doc.saleId,
        model: '55',
        series: doc.series,
        number: doc.number,
        accessKey: doc.accessKey,
        status: 'CANCELLED',
        protocolNumber: doc.protocolNumber,
        issuedAt: doc.issuedAt,
    };
}

/**
 * Inutilização de Numeração (§25: "Considerar tratamento de inutilização quando
 * aplicável"). Diferente de `cancelNFeDocument` (§29, que cancela uma NF-e já
 * AUTHORIZED), esta função formaliza perante a SEFAZ que uma FAIXA de números de uma
 * série NUNCA foi utilizada — não há `fiscal_documents` correspondente. Bloqueia
 * explicitamente se algum número da faixa já foi usado em `fiscal_documents` (nunca
 * inutiliza número que na verdade foi emitido).
 *
 * Reaproveita a permissão `FISCAL_CANCEL` (não há um código dedicado de inutilização no
 * catálogo de permissões atual — mesma gravidade/irreversibilidade perante o Fisco que o
 * cancelamento, restrita a OWNER/ADMIN). Se o usuário preferir uma permissão própria
 * (ex.: `FISCAL_INUTILIZE`), avaliar antes de expor isso na UI.
 *
 * Mesma ressalva do Marco 3/§29: a estrutura exata do envelope SOAP `NFeInutilizacao4`
 * e o cStat de sucesso (102, "Inutilização de número homologada" — valor padrão
 * amplamente documentado) não foram reverificados contra uma fonte oficial ao vivo nesta
 * sessão — mesma limitação de rede/certificado ICP-Brasil já registrada em
 * docs/analise-inicial.md e falta.md.
 */
export async function inutilizeFiscalNumbering(
    db: D1Database,
    tenantId: string,
    storeId: string,
    series: number,
    numberStart: number,
    numberEnd: number,
    justification: string,
    actor: Actor,
    gateway: FiscalGateway = new SefazDirectGateway(),
    now = Date.now(),
): Promise<FiscalInutilizationSummary> {
    requirePermission(actor.permissions, 'FISCAL_CANCEL');

    const store = await db
        .prepare(`SELECT id, uf, cnpj FROM stores WHERE id = ? AND tenant_id = ?`)
        .bind(storeId, tenantId)
        .first<{ id: string; uf: string | null; cnpj: string | null }>();
    if (!store) {
        throw new RuleError('Loja não encontrada.', 404);
    }
    if (!store.uf || store.uf.trim().length !== 2) {
        throw new RuleError('Loja emissora sem UF válida cadastrada.', 400);
    }
    const cleanCnpj = (store.cnpj || '').replace(/\D/g, '');
    if (cleanCnpj.length !== 14) {
        throw new RuleError('A loja não possui CNPJ válido cadastrado para a inutilização de numeração.', 400);
    }

    const config = await db
        .prepare(`SELECT certificate_id AS certificateId FROM fiscal_configurations WHERE tenant_id = ? AND store_id = ? AND model = '55'`)
        .bind(tenantId, storeId)
        .first<{ certificateId: string | null }>();
    if (!config || !config.certificateId) {
        throw new RuleError('Certificado Digital A1 não configurado para esta loja.', 400);
    }
    const { pfx, passphrase, parsed } = await loadFiscalCertificate(db, tenantId, config.certificateId);
    if (now > parsed.validTo) {
        throw new RuleError('Certificado digital A1 está expirado.', 400);
    }

    // Nunca inutilizar um número que na verdade já foi emitido (§25 combinado com §36:
    // não presumir, verificar o que já existe antes de agir).
    const usedNumbers = await db
        .prepare(
            `SELECT number FROM fiscal_documents
             WHERE tenant_id = ? AND store_id = ? AND model = '55' AND series = ? AND number >= ? AND number <= ?
             LIMIT 1`,
        )
        .bind(tenantId, storeId, series, numberStart, numberEnd)
        .first<{ number: number }>();
    if (usedNumbers) {
        throw new RuleError(`Não é possível inutilizar: o número ${usedNumbers.number} da série ${series} já foi utilizado em um documento fiscal.`, 409);
    }

    // Nunca inutilizar de novo uma faixa que já foi confirmada como inutilizada.
    const overlapping = await db
        .prepare(
            `SELECT id, number_start AS numberStart, number_end AS numberEnd FROM fiscal_inutilizations
             WHERE tenant_id = ? AND store_id = ? AND model = '55' AND series = ? AND status = 'CONFIRMED'
                   AND number_start <= ? AND number_end >= ?`,
        )
        .bind(tenantId, storeId, series, numberEnd, numberStart)
        .first<{ id: string; numberStart: number; numberEnd: number }>();
    if (overlapping) {
        throw new RuleError(`A faixa ${overlapping.numberStart}-${overlapping.numberEnd} da série ${series} já está inutilizada.`, 409);
    }

    const uf = store.uf.trim().toUpperCase();
    const year = localParts(now).year;

    const { xml, infInutId } = buildInutilizacaoXml({
        environment: 'homologacao',
        uf,
        cnpj: cleanCnpj,
        model: '55',
        series,
        numberStart,
        numberEnd,
        year,
        justification,
    });

    const { signedXml: signedInutilizacaoXml } = signInutilizacaoXml({
        xml,
        infInutId,
        privateKeyPem: parsed.privateKeyPem,
        certBase64: parsed.certBase64,
    });

    const id = randomUUID();
    await db
        .prepare(
            `INSERT INTO fiscal_inutilizations (
                 id, tenant_id, store_id, environment, model, series, year, number_start, number_end,
                 justification, status, signed_xml, created_at
             ) VALUES (?, ?, ?, 'homologacao', '55', ?, ?, ?, ?, ?, 'PENDING', ?, ?)`,
        )
        .bind(id, tenantId, storeId, series, year, numberStart, numberEnd, justification, signedInutilizacaoXml, now)
        .run();

    let result;
    try {
        result = await gateway.inutilizeNumbering({ uf, environment: 'homologacao', signedInutilizacaoXml, pfx, passphrase });
    } catch (err) {
        await db
            .prepare(`UPDATE fiscal_inutilizations SET status = 'ERROR', xmotivo = ? WHERE id = ?`)
            .bind(err instanceof Error ? err.message : String(err), id)
            .run();
        throw err;
    }

    const confirmed = result.cStat === '102';

    await db
        .prepare(
            `UPDATE fiscal_inutilizations SET status = ?, cstat = ?, xmotivo = ?, protocol_number = ?, raw_xml = ?, confirmed_at = ?
             WHERE id = ?`,
        )
        .bind(confirmed ? 'CONFIRMED' : 'REJECTED', result.cStat, result.xMotivo, result.nProt ?? null, result.rawXml, confirmed ? now : null, id)
        .run();

    await db
        .prepare(
            `INSERT INTO fiscal_audit_logs (id, tenant_id, store_id, operation, request_payload, response_payload, status_code, created_at)
             VALUES (?, ?, ?, 'nfe.inutilizar', ?, ?, ?, ?)`,
        )
        .bind(randomUUID(), tenantId, storeId, JSON.stringify({ storeId, series, numberStart, numberEnd }), result.rawXml, confirmed ? 200 : 422, now)
        .run();

    if (!confirmed) {
        throw new RuleError(`SEFAZ não confirmou a inutilização: ${result.xMotivo} (cStat ${result.cStat}).`, 422);
    }

    return {
        id,
        storeId,
        model: '55',
        series,
        year,
        numberStart,
        numberEnd,
        status: 'CONFIRMED',
        protocolNumber: result.nProt ?? null,
        createdAt: now,
        confirmedAt: now,
    };
}

/**
 * Lista as inutilizações de numeração (§25) já registradas para as lojas do tenant,
 * para exibição no painel de Configuração fiscal (histórico, nunca escondido).
 */
export async function listFiscalInutilizationsForSnapshot(
    db: D1Database,
    tenantId: string,
    actor: Actor,
): Promise<Record<string, FiscalInutilizationSummary[]>> {
    requirePermission(actor.permissions, 'FISCAL_VIEW');

    const rows = await db
        .prepare(
            `SELECT id, store_id AS storeId, model, series, year, number_start AS numberStart, number_end AS numberEnd,
                    status, protocol_number AS protocolNumber, created_at AS createdAt, confirmed_at AS confirmedAt
             FROM fiscal_inutilizations
             WHERE tenant_id = ?
             ORDER BY created_at DESC`,
        )
        .bind(tenantId)
        .all<{
            id: string;
            storeId: string;
            model: '55';
            series: number;
            year: number;
            numberStart: number;
            numberEnd: number;
            status: FiscalInutilizationSummary['status'];
            protocolNumber: string | null;
            createdAt: number;
            confirmedAt: number | null;
        }>();

    const map: Record<string, FiscalInutilizationSummary[]> = {};
    for (const r of rows.results) {
        (map[r.storeId] ??= []).push({
            id: r.id,
            storeId: r.storeId,
            model: '55',
            series: r.series,
            year: r.year,
            numberStart: r.numberStart,
            numberEnd: r.numberEnd,
            status: r.status,
            protocolNumber: r.protocolNumber,
            createdAt: r.createdAt,
            confirmedAt: r.confirmedAt,
        });
    }
    return map;
}

/**
 * Monta os dados do DANFE (§22) a partir de um documento fiscal já autorizado. Nunca
 * gera representação para documento não autorizado (§22: "somente a partir dos dados
 * fiscais válidos/autorizados"; §12: nunca confundir com comprovante não fiscal).
 */
export async function getDanfeData(db: D1Database, tenantId: string, saleId: string, actor: Actor): Promise<import('./danfe.ts').DanfeData> {
    requirePermission(actor.permissions, 'FISCAL_VIEW');

    const doc = await db
        .prepare(
            `SELECT id, store_id AS storeId, series, number, access_key AS accessKey, protocol_number AS protocolNumber,
                    authorized_at AS authorizedAt, status
             FROM fiscal_documents WHERE sale_id = ? AND tenant_id = ?`,
        )
        .bind(saleId, tenantId)
        .first<{ id: string; storeId: string; series: number; number: number; accessKey: string; protocolNumber: string | null; authorizedAt: number | null; status: string }>();

    if (!doc) throw new RuleError('Nenhuma NF-e gerada para esta venda.', 404);
    if (doc.status !== 'AUTHORIZED' || !doc.protocolNumber || !doc.authorizedAt) {
        throw new RuleError(`DANFE só pode ser exibido para NF-e autorizada. Status atual: ${doc.status}.`, 409);
    }

    const store = await db
        .prepare(`SELECT name, legal_name AS legalName, cnpj, ie, uf, city, address, number, district, zip FROM stores WHERE id = ? AND tenant_id = ?`)
        .bind(doc.storeId, tenantId)
        .first<{ name: string; legalName: string | null; cnpj: string; ie: string; uf: string; city: string; address: string; number: string; district: string; zip: string }>();
    if (!store) throw new RuleError('Loja emissora não encontrada.', 404);

    const sale = await db
        .prepare(`SELECT customer, document FROM sales WHERE id = ? AND tenant_id = ?`)
        .bind(saleId, tenantId)
        .first<{ customer: string | null; document: string | null }>();

    const itemsRows = await db
        .prepare(
            `SELECT si.qty AS qty, si.price AS unitPrice, si.name AS description, si.sku AS code,
                    pfp.ncm, pfp.legacy_cfop AS cfop, p.unit
             FROM sale_items si
             JOIN products p ON p.id = si.product_id
             LEFT JOIN product_fiscal_profiles pfp ON pfp.product_id = p.id
             WHERE si.sale_id = ?`,
        )
        .bind(saleId)
        .all<{ qty: number; unitPrice: number; description: string; code: string; ncm: string | null; cfop: string | null; unit: string | null }>();

    const paymentRows = await db.prepare(`SELECT method, amount FROM sale_payments WHERE sale_id = ?`).bind(saleId).all<{ method: string; amount: number }>();

    const items = itemsRows.results.map((i) => ({ code: i.code, description: i.description, ncm: i.ncm ?? '', cfop: i.cfop ?? '', unit: i.unit ?? '', qty: i.qty, unitPrice: i.unitPrice, totalPrice: i.qty * i.unitPrice }));
    const total = items.reduce((a, i) => a + i.totalPrice, 0);

    return {
        accessKey: doc.accessKey,
        series: doc.series,
        number: doc.number,
        protocolNumber: doc.protocolNumber,
        authorizedAt: doc.authorizedAt,
        environment: 'homologacao',
        issuer: { legalName: store.legalName || store.name, tradeName: store.name, cnpj: store.cnpj, ie: store.ie, address: store.address, number: store.number, district: store.district, city: store.city, uf: store.uf, zip: store.zip },
        recipient: { name: sale?.customer || 'CONSUMIDOR FINAL', document: sale?.document || '' },
        items,
        payments: paymentRows.results.map((p) => ({ method: p.method, amount: p.amount })),
        total,
    };
}

export async function getNFeDocumentBySaleId(
    db: D1Database,
    tenantId: string,
    saleId: string,
    actor: Actor,
): Promise<FiscalDocumentSummary | null> {
    requirePermission(actor.permissions, 'FISCAL_VIEW');

    const row = await db
        .prepare(
            `SELECT id, sale_id AS saleId, model, series, number, access_key AS accessKey,
                    status, raw_xml AS rawXml, signed_xml AS signedXml, protocol_number AS protocolNumber,
                    issued_at AS issuedAt, authorized_at AS authorizedAt
             FROM fiscal_documents
             WHERE sale_id = ? AND tenant_id = ?`,
        )
        .bind(saleId, tenantId)
        .first<{
            id: string;
            saleId: string | null;
            model: '55';
            series: number;
            number: number;
            accessKey: string;
            status: FiscalDocumentSummary['status'];
            rawXml?: string | null;
            signedXml?: string | null;
            protocolNumber?: string | null;
            issuedAt: number;
            authorizedAt?: number | null;
        }>();

    if (!row) return null;

    return {
        id: row.id,
        saleId: row.saleId,
        model: '55',
        series: row.series,
        number: row.number,
        accessKey: row.accessKey,
        status: row.status,
        rawXml: row.rawXml || undefined,
        signedXml: row.signedXml || undefined,
        protocolNumber: row.protocolNumber,
        issuedAt: row.issuedAt,
        authorizedAt: row.authorizedAt,
    };
}

export async function listFiscalDocumentsForSnapshot(
    db: D1Database,
    tenantId: string,
    actor: Actor,
): Promise<Record<string, FiscalDocumentSummary>> {
    requirePermission(actor.permissions, 'FISCAL_VIEW');

    const rows = await db
        .prepare(
            `SELECT id, sale_id AS saleId, model, series, number, access_key AS accessKey,
                    status, raw_xml AS rawXml, signed_xml AS signedXml,
                    protocol_number AS protocolNumber, issued_at AS issuedAt,
                    authorized_at AS authorizedAt
             FROM fiscal_documents
             WHERE tenant_id = ? AND sale_id IS NOT NULL`,
        )
        .bind(tenantId)
        .all<{
            id: string;
            saleId: string;
            model: '55';
            series: number;
            number: number;
            accessKey: string;
            status: FiscalDocumentSummary['status'];
            rawXml?: string | null;
            signedXml?: string | null;
            protocolNumber?: string | null;
            issuedAt: number;
            authorizedAt?: number | null;
        }>();

    const map: Record<string, FiscalDocumentSummary> = {};
    for (const r of rows.results) {
        map[r.saleId] = {
            id: r.id,
            saleId: r.saleId,
            model: '55',
            series: r.series,
            number: r.number,
            accessKey: r.accessKey,
            status: r.status,
            rawXml: r.rawXml || undefined,
            signedXml: r.signedXml || undefined,
            protocolNumber: r.protocolNumber,
            issuedAt: r.issuedAt,
            authorizedAt: r.authorizedAt,
        };
    }
    return map;
}
