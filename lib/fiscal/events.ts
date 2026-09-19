import { RuleError } from '../errors.ts';
import type { FiscalEnvironment } from './types.ts';
import { escapeXml } from './builder.ts';
import { isoWithOffset } from '../time.ts';

// Evento fiscal de Cancelamento (§29 de instrucoes.md: "Não executar DELETE. Registrar
// FiscalDocument → FiscalEvent(CANCELLATION)"). Tipo de evento e estrutura seguem o
// padrão geral de eventos da NF-e (MOC 7.00 Anexo V / NT 2011.002).
//
// RESSALVA (mesma dos Marcos 3/DANFE): esta estrutura não foi reverificada contra uma
// fonte oficial ao vivo nesta sessão — mesma limitação de rede/certificado ICP-Brasil já
// registrada em docs/analise-inicial.md e falta.md. O comprimento mínimo de `xJust`
// (15 caracteres) e o código de tipo de evento (110111) são valores estáveis e amplamente
// documentados há muitos anos, mas devem ser confirmados contra o MOC 7.00 Anexo V antes
// de qualquer cancelamento real.
export const CANCELLATION_EVENT_TYPE = '110111';
export const CANCELLATION_EVENT_VERSION = '1.00';
export const CANCELLATION_JUSTIFICATION_MIN_LENGTH = 15;

export type BuildCancellationEventInput = {
    environment: FiscalEnvironment;
    cOrgao: string; // código do UF (cUF), 2 dígitos — mesmo valor já usado na chave de acesso
    cnpj: string;
    accessKey: string;
    protocolNumber: string;
    justification: string;
    sequenceNumber?: number; // nSeqEvento — 1 para a primeira tentativa de cancelamento desta chave
};

export function buildCancellationEventXml(input: BuildCancellationEventInput): { xml: string; eventId: string } {
    const cleanCnpj = input.cnpj.replace(/\D/g, '');
    if (cleanCnpj.length !== 14) {
        throw new RuleError('CNPJ do emitente deve conter 14 dígitos para o evento de cancelamento.', 400);
    }
    if (!/^\d{44}$/.test(input.accessKey)) {
        throw new RuleError('Chave de acesso inválida para o evento de cancelamento.', 400);
    }
    const justification = input.justification.trim();
    if (justification.length < CANCELLATION_JUSTIFICATION_MIN_LENGTH) {
        throw new RuleError(`Justificativa do cancelamento deve ter ao menos ${CANCELLATION_JUSTIFICATION_MIN_LENGTH} caracteres.`, 400);
    }
    if (!input.protocolNumber) {
        throw new RuleError('Protocolo de autorização da NF-e é obrigatório para registrar o cancelamento.', 400);
    }

    const seq = input.sequenceNumber ?? 1;
    const eventId = `ID${CANCELLATION_EVENT_TYPE}${input.accessKey}${String(seq).padStart(2, '0')}`;
    const tpAmb = input.environment === 'producao' ? '1' : '2';
    // Hora local com offset calculado (mesma correção do dhEmi em builder.ts).
    const dhEvento = isoWithOffset(Date.now());

    const infEvento =
        `<infEvento Id="${eventId}">` +
        `<cOrgao>${escapeXml(input.cOrgao)}</cOrgao>` +
        `<tpAmb>${tpAmb}</tpAmb>` +
        `<CNPJ>${cleanCnpj}</CNPJ>` +
        `<chNFe>${input.accessKey}</chNFe>` +
        `<dhEvento>${dhEvento}</dhEvento>` +
        `<tpEvento>${CANCELLATION_EVENT_TYPE}</tpEvento>` +
        `<nSeqEvento>${seq}</nSeqEvento>` +
        `<verEvento>${CANCELLATION_EVENT_VERSION}</verEvento>` +
        `<detEvento versao="${CANCELLATION_EVENT_VERSION}">` +
        `<descEvento>Cancelamento</descEvento>` +
        `<nProt>${escapeXml(input.protocolNumber)}</nProt>` +
        `<xJust>${escapeXml(justification)}</xJust>` +
        `</detEvento>` +
        `</infEvento>`;

    const xml = `<?xml version="1.0" encoding="UTF-8"?>` + `<evento xmlns="http://www.portalfiscal.inf.br/nfe" versao="${CANCELLATION_EVENT_VERSION}">` + infEvento + `</evento>`;

    return { xml, eventId };
}
