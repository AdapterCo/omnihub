import { RuleError } from '../errors.ts';
import type { FiscalEnvironment } from './types.ts';
import { escapeXml } from './builder.ts';
import { UF_IBGE_CODES } from './keys.ts';

// Inutilização de Numeração (§25: "Considerar tratamento de inutilização quando
// aplicável"). Diferente do cancelamento (§29, evento 110111 sobre uma NF-e já
// autorizada), a inutilização formaliza perante a SEFAZ que uma FAIXA de números de uma
// série NUNCA foi utilizada (ex.: números pulados por falha antes da emissão, reinício de
// sequência) — não há `fiscal_documents` correspondente. Estrutura conforme MOC 7.00
// Anexo I (`<inutNFe>`/`<infInut>`).
//
// RESSALVA (mesma dos Marcos 3/§29): esta estrutura não foi reverificada contra uma fonte
// oficial ao vivo nesta sessão — mesma limitação de rede/certificado ICP-Brasil já
// registrada em docs/analise-inicial.md e falta.md.
export const INUTILIZACAO_JUSTIFICATION_MIN_LENGTH = 15;
export const INUTILIZACAO_XML_VERSION = '4.00';

export type BuildInutilizacaoXmlInput = {
    environment: FiscalEnvironment;
    uf: string;
    cnpj: string;
    model: '55';
    series: number;
    numberStart: number;
    numberEnd: number;
    year: number; // ano de referência (4 dígitos; reduzido a 2 dígitos na chave conforme MOC)
    justification: string;
};

export function buildInutilizacaoXml(input: BuildInutilizacaoXmlInput): { xml: string; infInutId: string } {
    const ufCode = UF_IBGE_CODES[input.uf.toUpperCase()];
    if (!ufCode) {
        throw new RuleError(`UF '${input.uf}' inválida ou não reconhecida para inutilização de numeração.`, 400);
    }

    const cleanCnpj = input.cnpj.replace(/\D/g, '');
    if (cleanCnpj.length !== 14) {
        throw new RuleError('CNPJ do emitente deve conter 14 dígitos para a inutilização de numeração.', 400);
    }

    if (!Number.isInteger(input.series) || input.series < 1 || input.series > 999) {
        throw new RuleError('Série inválida para inutilização de numeração.', 400);
    }
    if (!Number.isInteger(input.numberStart) || !Number.isInteger(input.numberEnd) || input.numberStart < 1 || input.numberEnd < input.numberStart) {
        throw new RuleError('Faixa de numeração inválida: número final deve ser maior ou igual ao número inicial.', 400);
    }

    const justification = input.justification.trim();
    if (justification.length < INUTILIZACAO_JUSTIFICATION_MIN_LENGTH) {
        throw new RuleError(`Justificativa da inutilização deve ter ao menos ${INUTILIZACAO_JUSTIFICATION_MIN_LENGTH} caracteres.`, 400);
    }

    const ano2 = String(input.year).slice(-2).padStart(2, '0');
    const serie3 = String(input.series).padStart(3, '0');
    const nNFIni9 = String(input.numberStart).padStart(9, '0');
    const nNFFin9 = String(input.numberEnd).padStart(9, '0');
    const infInutId = `ID${ufCode}${ano2}${cleanCnpj}${input.model}${serie3}${nNFIni9}${nNFFin9}`;
    const tpAmb = input.environment === 'producao' ? '1' : '2';

    const infInut =
        `<infInut Id="${infInutId}">` +
        `<tpAmb>${tpAmb}</tpAmb>` +
        `<xServ>INUTILIZAR</xServ>` +
        `<cUF>${ufCode}</cUF>` +
        `<ano>${ano2}</ano>` +
        `<CNPJ>${cleanCnpj}</CNPJ>` +
        `<mod>${input.model}</mod>` +
        `<serie>${input.series}</serie>` +
        `<nNFIni>${input.numberStart}</nNFIni>` +
        `<nNFFin>${input.numberEnd}</nNFFin>` +
        `<xJust>${escapeXml(justification)}</xJust>` +
        `</infInut>`;

    const xml = `<?xml version="1.0" encoding="UTF-8"?>` + `<inutNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="${INUTILIZACAO_XML_VERSION}">` + infInut + `</inutNFe>`;

    return { xml, infInutId };
}
