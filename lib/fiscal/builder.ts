import { RuleError } from '../errors.ts';
import { generateAccessKey } from './keys.ts';
import { isoWithOffset } from '../time.ts';
import type { FiscalEnvironment, CRT } from './types.ts';

export type NFeIssuer = {
    cnpj: string;
    legalName: string;
    tradeName?: string;
    ie: string;
    crt: CRT;
    uf: string;
    city: string;
    municipalityCode: string;
    address: string;
    number: string;
    district: string;
    zip: string;
};

export type NFeRecipient = {
    document: string; // CPF (11) ou CNPJ (14)
    name: string;
    uf?: string;
    city?: string;
    municipalityCode?: string;
    address?: string;
    number?: string;
    district?: string;
    zip?: string;
};

export type NFeItem = {
    code: string;
    barcode?: string;
    description: string;
    ncm: string;
    cest?: string;
    cfop: string;
    unit: string;
    qty: number;
    unitPrice: number; // em centavos
    totalPrice: number; // em centavos
    origin?: string; // 0 a 8
    taxCode?: string; // CSOSN (ex: 102) ou CST (ex: 00)
};

export type NFePayment = {
    method: string; // 'Dinheiro', 'Pix', 'Cartão'
    amount: number; // em centavos
};

export type BuildNFeInput = {
    environment: FiscalEnvironment;
    model?: '55' | '65';
    series: number;
    number: number;
    emissionDate: Date;
    natureOfOperation?: string;
    issuer: NFeIssuer;
    recipient?: NFeRecipient;
    items: NFeItem[];
    payments: NFePayment[];
    includeReformaTributaria2026?: boolean;
    // NFC-e (§20): grupo suplementar com o QR Code, calculado fora deste builder
    // (lib/fiscal/qrcode.ts) porque depende do CSC configurado pela loja. O QR Code
    // precisa da chave de acesso ANTES da montagem do XML, então quem chama este builder
    // para NFC-e deve gerar a chave primeiro (lib/fiscal/keys.ts) e repassar o mesmo
    // `numericCode` aqui para que a chave recalculada internamente seja idêntica.
    qrCode?: { url: string; consultaUrl?: string };
    numericCode?: string;
};

const PAYMENT_METHOD_MAP: Record<string, string> = {
    Dinheiro: '01',
    Pix: '17',
    Cartão: '03', // Cartão de crédito padrão
};

function formatMoney(cents: number): string {
    return (cents / 100).toFixed(2);
}

function formatQty(q: number): string {
    return q.toFixed(4);
}

function formatUnit(cents: number): string {
    return (cents / 100).toFixed(4);
}

export function escapeXml(str: string): string {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

/**
 * Constrói o XML da NF-e (Modelo 55) em estrita conformidade com o Layout 4.00 (MOC 7.00).
 * Campos ausentes obrigatórios disparam RuleError imediatamente (sem inventar dados).
 */
export function buildNFeXml(input: BuildNFeInput): { xml: string; accessKey: string; numericCode: string } {
    const { issuer, items, payments, environment, series, number, emissionDate } = input;
    const model = input.model ?? '55';

    if (!items.length) {
        throw new RuleError(`A ${model === '65' ? 'NFC-e' : 'NF-e'} deve conter ao menos um item de produto.`, 400);
    }
    if (!payments.length) {
        throw new RuleError(`A ${model === '65' ? 'NFC-e' : 'NF-e'} deve conter ao menos uma linha de pagamento.`, 400);
    }

    const tpAmb = environment === 'producao' ? '1' : '2';

    // Gera a chave de acesso oficial de 44 dígitos
    const { accessKey, numericCode } = generateAccessKey({
        uf: issuer.uf,
        emissionDate,
        cnpj: issuer.cnpj,
        model,
        series,
        number,
        emissionType: '1',
        numericCode: input.numericCode,
    });

    const cUF = accessKey.slice(0, 2);
    const cDV = accessKey.slice(-1);
    const crtCode = issuer.crt === '3_REGIME_NORMAL' ? '3' : issuer.crt === '2_SIMPLES_EXCESSO' ? '2' : '1';

    // dhEmi: hora LOCAL (America/Sao_Paulo) com o offset calculado. Trocar só o "Z" do UTC por
    // "-03:00" gravaria a emissão 3 horas no futuro e a SEFAZ rejeitaria a nota.
    const dhEmi = isoWithOffset(emissionDate.getTime());
    const natOp = escapeXml(input.natureOfOperation || 'VENDA DE MERCADORIA');

    let xml = `<?xml version="1.0" encoding="UTF-8"?>`;
    xml += `<NFe xmlns="http://www.portalfiscal.inf.br/nfe">`;
    xml += `<infNFe Id="NFe${accessKey}" versao="4.00">`;

    // 1. Grupo ide
    xml += `<ide>`;
    xml += `<cUF>${cUF}</cUF>`;
    xml += `<cNF>${numericCode}</cNF>`;
    xml += `<natOp>${natOp}</natOp>`;
    xml += `<mod>${model}</mod>`;
    xml += `<serie>${series}</serie>`;
    xml += `<nNF>${number}</nNF>`;
    xml += `<dhEmi>${dhEmi}</dhEmi>`;
    xml += `<tpNF>1</tpNF>`; // 1 = Saída
    // idDest (destino da operação) não se aplica à NFC-e (modelo 65): consumo é sempre
    // interno ao próprio estabelecimento e o grupo não existe no schema deste modelo.
    if (model === '55') {
        xml += `<idDest>1</idDest>`; // 1 = Operação interna
    }
    xml += `<cMunFG>${issuer.municipalityCode.replace(/\D/g, '')}</cMunFG>`;
    xml += `<tpImp>${model === '65' ? '4' : '1'}</tpImp>`; // 1 = Retrato (NF-e) · 4 = DANFE NFC-e
    xml += `<tpEmis>1</tpEmis>`; // 1 = Normal
    xml += `<cDV>${cDV}</cDV>`;
    xml += `<tpAmb>${tpAmb}</tpAmb>`;
    xml += `<finNFe>1</finNFe>`; // 1 = Normal
    xml += `<indFinal>1</indFinal>`; // 1 = Consumidor final
    xml += `<indPres>1</indPres>`; // 1 = Operação presencial
    xml += `<procEmi>0</procEmi>`; // 0 = Emissão de NF-e com aplicativo do contribuinte
    xml += `<verProc>OmniHub 1.0</verProc>`;
    xml += `</ide>`;

    // 2. Grupo emit
    const cleanIssuerCnpj = issuer.cnpj.replace(/\D/g, '');
    const cleanIssuerCep = issuer.zip.replace(/\D/g, '');
    xml += `<emit>`;
    xml += `<CNPJ>${cleanIssuerCnpj}</CNPJ>`;
    xml += `<xNome>${escapeXml(issuer.legalName)}</xNome>`;
    if (issuer.tradeName) {
        xml += `<xFant>${escapeXml(issuer.tradeName)}</xFant>`;
    }
    xml += `<enderEmit>`;
    xml += `<xLgr>${escapeXml(issuer.address)}</xLgr>`;
    xml += `<nro>${escapeXml(issuer.number || 'SN')}</nro>`;
    xml += `<xBairro>${escapeXml(issuer.district)}</xBairro>`;
    xml += `<cMun>${issuer.municipalityCode.replace(/\D/g, '')}</cMun>`;
    xml += `<xMun>${escapeXml(issuer.city)}</xMun>`;
    xml += `<UF>${issuer.uf.toUpperCase()}</UF>`;
    xml += `<CEP>${cleanIssuerCep}</CEP>`;
    xml += `<cPais>1058</cPais>`;
    xml += `<xPais>Brasil</xPais>`;
    xml += `</enderEmit>`;
    xml += `<IE>${issuer.ie.replace(/\D/g, '')}</IE>`;
    xml += `<CRT>${crtCode}</CRT>`;
    xml += `</emit>`;

    // 3. Grupo dest (se informado)
    if (input.recipient && input.recipient.document) {
        const cleanDoc = input.recipient.document.replace(/\D/g, '');
        const isCpf = cleanDoc.length === 11;
        // Em homologação, o nome do destinatário deve ser a literal exigida se for teste
        const destName = environment === 'homologacao'
            ? 'NF-E EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL'
            : escapeXml(input.recipient.name || 'CONSUMIDOR FINAL');

        xml += `<dest>`;
        xml += isCpf ? `<CPF>${cleanDoc}</CPF>` : `<CNPJ>${cleanDoc}</CNPJ>`;
        xml += `<xNome>${destName}</xNome>`;
        xml += `<indIEDest>9</indIEDest>`; // 9 = Não Contribuinte
        xml += `</dest>`;
    }

    // 4. Grupo det (Itens)
    let totalProductsCents = 0;
    items.forEach((item, index) => {
        const nItem = index + 1;
        totalProductsCents += item.totalPrice;

        const cleanNcm = item.ncm.replace(/\D/g, '');
        if (cleanNcm.length !== 8) {
            throw new RuleError(`Item '${item.description}' possui NCM inválido ('${item.ncm}'). NCM deve ter 8 dígitos.`, 400);
        }

        const cleanCfop = item.cfop.replace(/\D/g, '');
        if (cleanCfop.length !== 4) {
            throw new RuleError(`Item '${item.description}' possui CFOP inválido ('${item.cfop}'). CFOP deve ter 4 dígitos.`, 400);
        }

        const origin = (item.origin || '').trim();
        if (!/^[0-8]$/.test(origin)) {
            throw new RuleError(`Item '${item.description}' não possui origem da mercadoria (0 a 8) configurada. Cadastre a origem do produto antes de emitir — não presumida.`, 400);
        }
        const ean = item.barcode && /^\d{8,14}$/.test(item.barcode) ? item.barcode : 'SEM GTIN';

        xml += `<det nItem="${nItem}">`;
        xml += `<prod>`;
        xml += `<cProd>${escapeXml(item.code)}</cProd>`;
        xml += `<cEAN>${ean}</cEAN>`;
        xml += `<xProd>${escapeXml(item.description)}</xProd>`;
        xml += `<NCM>${cleanNcm}</NCM>`;
        if (item.cest && /^\d{7}$/.test(item.cest.replace(/\D/g, ''))) {
            xml += `<CEST>${item.cest.replace(/\D/g, '')}</CEST>`;
        }
        xml += `<CFOP>${cleanCfop}</CFOP>`;
        xml += `<uCom>${escapeXml(item.unit)}</uCom>`;
        xml += `<qCom>${formatQty(item.qty)}</qCom>`;
        xml += `<vUnCom>${formatUnit(item.unitPrice)}</vUnCom>`;
        xml += `<vProd>${formatMoney(item.totalPrice)}</vProd>`;
        xml += `<cEANTrib>${ean}</cEANTrib>`;
        xml += `<uTrib>${escapeXml(item.unit)}</uTrib>`;
        xml += `<qTrib>${formatQty(item.qty)}</qTrib>`;
        xml += `<vUnTrib>${formatUnit(item.unitPrice)}</vUnTrib>`;
        xml += `<indTot>1</indTot>`;
        xml += `</prod>`;

        // Grupo imposto. §36: código de tributação nunca é presumido — o produto precisa
        // ter CST/CSOSN cadastrado explicitamente, e só os grupos declarativos (sem valor
        // de imposto calculado) estão implementados. Qualquer outro código bloqueia a
        // emissão em vez de gerar um XML com classificação ou cálculo inventado.
        const taxCode = (item.taxCode || '').trim();
        if (!taxCode) {
            throw new RuleError(`Item '${item.description}' não possui código de tributação do ICMS (CST/CSOSN) configurado. Cadastre o CST/CSOSN do produto antes de emitir.`, 400);
        }
        xml += `<imposto>`;
        xml += `<ICMS>`;
        if (crtCode === '1') {
            if (taxCode !== '102') {
                throw new RuleError(`Item '${item.description}': CSOSN '${taxCode}' ainda não é suportado por este emissor (somente CSOSN 102 — tributação pelo Simples Nacional sem permissão de crédito — está implementado, sem cálculo de valores). Confirme a classificação correta antes de emitir.`, 400);
            }
            xml += `<ICMSSN102>`;
            xml += `<orig>${origin}</orig>`;
            xml += `<CSOSN>102</CSOSN>`;
            xml += `</ICMSSN102>`;
        } else {
            if (taxCode !== '41') {
                throw new RuleError(`Item '${item.description}': CST '${taxCode}' ainda não é suportado por este emissor (somente CST 41 — não tributada, sem cálculo de valores — está implementado). Confirme a classificação correta antes de emitir.`, 400);
            }
            xml += `<ICMS40>`;
            xml += `<orig>${origin}</orig>`;
            xml += `<CST>41</CST>`;
            xml += `</ICMS40>`;
        }
        xml += `</ICMS>`;

        // PIS: Operação sem incidência da contribuição (CST 07)
        xml += `<PIS><PISNT><CST>07</CST></PISNT></PIS>`;
        // COFINS: Operação sem incidência da contribuição (CST 07)
        xml += `<COFINS><COFINSNT><CST>07</CST></COFINSNT></COFINS>`;

        // Grupo preparatório da Reforma Tributária 2026 (IBS / CBS)
        if (input.includeReformaTributaria2026) {
            xml += `<IBS><CST>01</CST><vBC>0.00</vBC><pIBS>0.00</pIBS><vIBS>0.00</vIBS></IBS>`;
            xml += `<CBS><CST>01</CST><vBC>0.00</vBC><pCBS>0.00</pCBS><vCBS>0.00</vCBS></CBS>`;
        }

        xml += `</imposto>`;
        xml += `</det>`;
    });

    // 5. Grupo total
    xml += `<total>`;
    xml += `<ICMSTot>`;
    xml += `<vBC>0.00</vBC>`;
    xml += `<vICMS>0.00</vICMS>`;
    xml += `<vICMSDeson>0.00</vICMSDeson>`;
    xml += `<vFCPUFDest>0.00</vFCPUFDest>`;
    xml += `<vICMSUFDest>0.00</vICMSUFDest>`;
    xml += `<vICMSUFRemet>0.00</vICMSUFRemet>`;
    xml += `<vFCP>0.00</vFCP>`;
    xml += `<vBCST>0.00</vBCST>`;
    xml += `<vST>0.00</vST>`;
    xml += `<vFCPST>0.00</vFCPST>`;
    xml += `<vFCPSTRet>0.00</vFCPSTRet>`;
    xml += `<vProd>${formatMoney(totalProductsCents)}</vProd>`;
    xml += `<vFrete>0.00</vFrete>`;
    xml += `<vSeg>0.00</vSeg>`;
    xml += `<vDesc>0.00</vDesc>`;
    xml += `<vII>0.00</vII>`;
    xml += `<vIPI>0.00</vIPI>`;
    xml += `<vIPIDevol>0.00</vIPIDevol>`;
    xml += `<vPIS>0.00</vPIS>`;
    xml += `<vCOFINS>0.00</vCOFINS>`;
    xml += `<vOutro>0.00</vOutro>`;
    xml += `<vNF>${formatMoney(totalProductsCents)}</vNF>`;
    xml += `</ICMSTot>`;
    xml += `</total>`;

    // 6. Grupo transp (9 = Sem Ocorrência de Transporte)
    xml += `<transp><modFrete>9</modFrete></transp>`;

    // 7. Grupo pag
    xml += `<pag>`;
    payments.forEach((p) => {
        const tPag = PAYMENT_METHOD_MAP[p.method] || '99';
        xml += `<detPag>`;
        xml += `<tPag>${tPag}</tPag>`;
        xml += `<vPag>${formatMoney(p.amount)}</vPag>`;
        xml += `</detPag>`;
    });
    xml += `</pag>`;

    xml += `</infNFe>`;

    // Grupo suplementar do QR Code (§20), exclusivo de NFC-e — fica fora de <infNFe>
    // (não é coberto pela assinatura digital, conforme NT 2015.002).
    if (model === '65') {
        if (!input.qrCode) {
            throw new RuleError('NFC-e requer QR Code calculado (CSC) antes da montagem do XML final.', 400);
        }
        xml += `<infNFeSupl>`;
        xml += `<qrCode><![CDATA[${input.qrCode.url}]]></qrCode>`;
        if (input.qrCode.consultaUrl) {
            xml += `<urlChave>${escapeXml(input.qrCode.consultaUrl)}</urlChave>`;
        }
        xml += `</infNFeSupl>`;
    }

    xml += `</NFe>`;

    return { xml, accessKey, numericCode };
}
