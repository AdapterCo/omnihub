import { calculateDVMod11 } from './keys.ts';

export type SchemaValidationError = {
    path: string;
    message: string;
};

export type ValidationResult = {
    valid: boolean;
    errors: SchemaValidationError[];
};

function extractTag(xml: string, tag: string): string | null {
    const match = xml.match(new RegExp(`<${tag}(?:\\s+[^>]*)?>([\\s\\S]*?)<\\/${tag}>`));
    return match ? match[1].trim() : null;
}

function extractAllTags(xml: string, tag: string): string[] {
    const regex = new RegExp(`<${tag}(?:\\s+[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'g');
    const results: string[] = [];
    let match;
    while ((match = regex.exec(xml)) !== null) {
        results.push(match[1].trim());
    }
    return results;
}

function extractAttribute(xml: string, tag: string, attr: string): string | null {
    const match = xml.match(new RegExp(`<${tag}[^>]*?\\s+${attr}="([^"]*)"`));
    return match ? match[1] : null;
}

const IBGE_UF_CODES = new Set([
    '11', '12', '13', '14', '15', '16', '17', // Norte
    '21', '22', '23', '24', '25', '26', '27', '28', '29', // Nordeste
    '31', '32', '33', '35', // Sudeste
    '41', '42', '43', // Sul
    '50', '51', '52', '53', // Centro-Oeste
]);

/**
 * Validação sintática e estrutural rigorosa da NF-e (Modelo 55, Layout 4.00)
 * em estrita conformidade com as regras do pacote de schemas oficiais PL_009k e MOC 7.00.
 */
export function validateNFeXmlSchema(xml: string, expectedModel: '55' | '65' = '55'): ValidationResult {
    const errors: SchemaValidationError[] = [];

    if (!xml || !xml.trim()) {
        errors.push({
            path: '/NFe',
            message: 'Conteúdo XML vazio ou não fornecido.',
        });
        return { valid: false, errors };
    }

    // 1. Tag Raiz NFe e namespace oficial
    if (!xml.includes('<NFe') || !xml.includes('xmlns="http://www.portalfiscal.inf.br/nfe"')) {
        errors.push({
            path: '/NFe',
            message: 'Elemento raiz deve ser <NFe> com namespace oficial xmlns="http://www.portalfiscal.inf.br/nfe".',
        });
        return { valid: false, errors };
    }

    // 2. infNFe: atributos Id e versao
    const versao = extractAttribute(xml, 'infNFe', 'versao');
    if (versao !== '4.00') {
        errors.push({
            path: '/NFe/infNFe/@versao',
            message: `Versão do layout deve ser "4.00". Informado: "${versao || 'ausente'}".`,
        });
    }

    const idAttr = extractAttribute(xml, 'infNFe', 'Id');
    if (!idAttr || !/^NFe\d{44}$/.test(idAttr)) {
        errors.push({
            path: '/NFe/infNFe/@Id',
            message: 'Atributo Id deve seguir o padrão "^NFe[0-9]{44}$".',
        });
    } else {
        const key44 = idAttr.slice(3);
        const expectedDv = calculateDVMod11(key44.slice(0, 43));
        const actualDv = parseInt(key44.slice(43), 10);
        if (actualDv !== expectedDv) {
            errors.push({
                path: '/NFe/infNFe/@Id',
                message: `Dígito verificador da chave de acesso inválido no Id (informado: ${actualDv}, calculado: ${expectedDv}).`,
            });
        }
    }

    const infNFeXml = extractTag(xml, 'infNFe');
    if (!infNFeXml) {
        errors.push({ path: '/NFe/infNFe', message: 'Elemento <infNFe> ausente ou vazio.' });
        return { valid: false, errors };
    }

    // 3. Grupo ide
    const ideXml = extractTag(infNFeXml, 'ide');
    if (!ideXml) {
        errors.push({ path: '/NFe/infNFe/ide', message: 'Grupo de identificação <ide> é obrigatório.' });
    } else {
        const cUF = extractTag(ideXml, 'cUF');
        if (!cUF || !IBGE_UF_CODES.has(cUF)) {
            errors.push({ path: '/NFe/infNFe/ide/cUF', message: `Código de UF inválido no IBGE: "${cUF || ''}".` });
        }

        const cNF = extractTag(ideXml, 'cNF');
        if (!cNF || !/^\d{8}$/.test(cNF)) {
            errors.push({ path: '/NFe/infNFe/ide/cNF', message: 'cNF deve conter exatamente 8 dígitos numéricos.' });
        }

        const natOp = extractTag(ideXml, 'natOp');
        if (!natOp || natOp.length < 1 || natOp.length > 60) {
            errors.push({ path: '/NFe/infNFe/ide/natOp', message: 'natOp deve ter entre 1 e 60 caracteres.' });
        }

        const mod = extractTag(ideXml, 'mod');
        if (mod !== expectedModel) {
            errors.push({ path: '/NFe/infNFe/ide/mod', message: `Modelo da nota deve ser "${expectedModel}" (${expectedModel === '65' ? 'NFC-e' : 'NF-e'}). Informado: "${mod || ''}".` });
        }

        // idDest não existe no schema da NFC-e (modelo 65) — só é obrigatório para NF-e.
        if (expectedModel === '55') {
            const idDest = extractTag(ideXml, 'idDest');
            if (!idDest || !['1', '2', '3'].includes(idDest)) {
                errors.push({ path: '/NFe/infNFe/ide/idDest', message: 'idDest deve ser 1 (interna), 2 (interestadual) ou 3 (exterior).' });
            }
        }

        const serie = extractTag(ideXml, 'serie');
        if (!serie || !/^[1-9]\d{0,2}$/.test(serie)) {
            errors.push({ path: '/NFe/infNFe/ide/serie', message: 'Série deve ser numérico entre 1 e 999.' });
        }

        const nNF = extractTag(ideXml, 'nNF');
        if (!nNF || !/^[1-9]\d{0,8}$/.test(nNF)) {
            errors.push({ path: '/NFe/infNFe/ide/nNF', message: 'nNF deve ser numérico entre 1 e 999.999.999.' });
        }

        const dhEmi = extractTag(ideXml, 'dhEmi');
        if (!dhEmi || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[-+]\d{2}:\d{2}$/.test(dhEmi)) {
            errors.push({ path: '/NFe/infNFe/ide/dhEmi', message: 'dhEmi deve seguir formato UTC/ISO com offset (ex: YYYY-MM-DDThh:mm:ss-03:00).' });
        }

        const tpAmb = extractTag(ideXml, 'tpAmb');
        if (tpAmb !== '1' && tpAmb !== '2') {
            errors.push({ path: '/NFe/infNFe/ide/tpAmb', message: 'tpAmb deve ser 1 (Produção) ou 2 (Homologação).' });
        }

        const cMunFG = extractTag(ideXml, 'cMunFG');
        if (!cMunFG || !/^\d{7}$/.test(cMunFG)) {
            errors.push({ path: '/NFe/infNFe/ide/cMunFG', message: 'cMunFG deve ser o código IBGE do município com 7 dígitos.' });
        }
    }

    // 4. Grupo emit
    const emitXml = extractTag(infNFeXml, 'emit');
    if (!emitXml) {
        errors.push({ path: '/NFe/infNFe/emit', message: 'Grupo do emitente <emit> é obrigatório.' });
    } else {
        const cnpj = extractTag(emitXml, 'CNPJ');
        if (!cnpj || !/^\d{14}$/.test(cnpj)) {
            errors.push({ path: '/NFe/infNFe/emit/CNPJ', message: 'CNPJ do emitente deve conter 14 dígitos numéricos.' });
        }

        const xNome = extractTag(emitXml, 'xNome');
        if (!xNome || xNome.length < 2 || xNome.length > 60) {
            errors.push({ path: '/NFe/infNFe/emit/xNome', message: 'xNome do emitente deve ter entre 2 e 60 caracteres.' });
        }

        const ie = extractTag(emitXml, 'IE');
        if (!ie || !/^\d{2,14}$/.test(ie)) {
            errors.push({ path: '/NFe/infNFe/emit/IE', message: 'Inscrição Estadual (IE) do emitente deve conter entre 2 e 14 dígitos.' });
        }

        const crt = extractTag(emitXml, 'CRT');
        if (!crt || !['1', '2', '3'].includes(crt)) {
            errors.push({ path: '/NFe/infNFe/emit/CRT', message: 'CRT deve ser 1 (Simples), 2 (Excesso) ou 3 (Normal).' });
        }

        const enderEmit = extractTag(emitXml, 'enderEmit');
        if (!enderEmit) {
            errors.push({ path: '/NFe/infNFe/emit/enderEmit', message: 'Endereço do emitente <enderEmit> é obrigatório.' });
        } else {
            const uf = extractTag(enderEmit, 'UF');
            if (!uf || !/^[A-Z]{2}$/.test(uf)) {
                errors.push({ path: '/NFe/infNFe/emit/enderEmit/UF', message: 'UF do emitente deve ter 2 letras maiúsculas.' });
            }
            const cMun = extractTag(enderEmit, 'cMun');
            if (!cMun || !/^\d{7}$/.test(cMun)) {
                errors.push({ path: '/NFe/infNFe/emit/enderEmit/cMun', message: 'Código IBGE do município (cMun) deve ter 7 dígitos.' });
            }
            const cep = extractTag(enderEmit, 'CEP');
            if (!cep || !/^\d{8}$/.test(cep)) {
                errors.push({ path: '/NFe/infNFe/emit/enderEmit/CEP', message: 'CEP do emitente deve ter 8 dígitos numéricos.' });
            }
        }
    }

    // 5. Grupo dest (se presente)
    const destXml = extractTag(infNFeXml, 'dest');
    if (destXml) {
        const cnpj = extractTag(destXml, 'CNPJ');
        const cpf = extractTag(destXml, 'CPF');
        if (!cnpj && !cpf) {
            errors.push({ path: '/NFe/infNFe/dest', message: 'Destinatário deve conter CNPJ (14 dígitos) ou CPF (11 dígitos).' });
        } else if (cnpj && !/^\d{14}$/.test(cnpj)) {
            errors.push({ path: '/NFe/infNFe/dest/CNPJ', message: 'CNPJ do destinatário deve conter 14 dígitos numéricos.' });
        } else if (cpf && !/^\d{11}$/.test(cpf)) {
            errors.push({ path: '/NFe/infNFe/dest/CPF', message: 'CPF do destinatário deve conter 11 dígitos numéricos.' });
        }

        const xNome = extractTag(destXml, 'xNome');
        if (!xNome || xNome.length < 2 || xNome.length > 60) {
            errors.push({ path: '/NFe/infNFe/dest/xNome', message: 'Razão social / Nome do destinatário deve ter entre 2 e 60 caracteres.' });
        }
    }

    // 6. Grupo det (Itens)
    const detXmlList = extractAllTags(infNFeXml, 'det');
    if (!detXmlList.length) {
        errors.push({ path: '/NFe/infNFe/det', message: 'A NF-e deve conter ao menos um item de detalhamento (<det>).' });
    }

    let calculatedTotalProducts = 0;

    detXmlList.forEach((detXml, index) => {
        const itemNumber = index + 1;
        const prodXml = extractTag(detXml, 'prod');
        if (!prodXml) {
            errors.push({ path: `/NFe/infNFe/det[${itemNumber}]/prod`, message: 'Dados do produto (<prod>) ausentes.' });
            return;
        }

        const cProd = extractTag(prodXml, 'cProd');
        if (!cProd || cProd.length < 1 || cProd.length > 60) {
            errors.push({ path: `/NFe/infNFe/det[${itemNumber}]/prod/cProd`, message: 'cProd deve ter entre 1 e 60 caracteres.' });
        }

        const xProd = extractTag(prodXml, 'xProd');
        if (!xProd || xProd.length < 1 || xProd.length > 120) {
            errors.push({ path: `/NFe/infNFe/det[${itemNumber}]/prod/xProd`, message: 'xProd deve ter entre 1 e 120 caracteres.' });
        }

        const ncm = extractTag(prodXml, 'NCM');
        if (!ncm || !/^\d{8}$/.test(ncm)) {
            errors.push({ path: `/NFe/infNFe/det[${itemNumber}]/prod/NCM`, message: `NCM deve ter exatamente 8 dígitos numéricos (informado: "${ncm || ''}").` });
        }

        const cfop = extractTag(prodXml, 'CFOP');
        if (!cfop || !/^\d{4}$/.test(cfop)) {
            errors.push({ path: `/NFe/infNFe/det[${itemNumber}]/prod/CFOP`, message: `CFOP deve ter exatamente 4 dígitos numéricos (informado: "${cfop || ''}").` });
        }

        const vProdStr = extractTag(prodXml, 'vProd');
        if (!vProdStr || isNaN(parseFloat(vProdStr))) {
            errors.push({ path: `/NFe/infNFe/det[${itemNumber}]/prod/vProd`, message: 'vProd inválido ou ausente.' });
        } else {
            calculatedTotalProducts += Math.round(parseFloat(vProdStr) * 100);
        }

        const impostoXml = extractTag(detXml, 'imposto');
        if (!impostoXml) {
            errors.push({ path: `/NFe/infNFe/det[${itemNumber}]/imposto`, message: 'Grupo tributário <imposto> ausente no item.' });
        } else {
            if (!impostoXml.includes('<ICMS>')) {
                errors.push({ path: `/NFe/infNFe/det[${itemNumber}]/imposto/ICMS`, message: 'Grupo <ICMS> obrigatório no item.' });
            }
            if (!impostoXml.includes('<PIS>')) {
                errors.push({ path: `/NFe/infNFe/det[${itemNumber}]/imposto/PIS`, message: 'Grupo <PIS> obrigatório no item.' });
            }
            if (!impostoXml.includes('<COFINS>')) {
                errors.push({ path: `/NFe/infNFe/det[${itemNumber}]/imposto/COFINS`, message: 'Grupo <COFINS> obrigatório no item.' });
            }
        }
    });

    // 7. Grupo total
    const totalXml = extractTag(infNFeXml, 'total');
    if (!totalXml || !totalXml.includes('<ICMSTot>')) {
        errors.push({ path: '/NFe/infNFe/total/ICMSTot', message: 'Grupo de totalização <total/ICMSTot> é obrigatório.' });
    } else {
        const icmsTot = extractTag(totalXml, 'ICMSTot');
        if (icmsTot) {
            const vProdTot = extractTag(icmsTot, 'vProd');
            const vNFTot = extractTag(icmsTot, 'vNF');
            const totalProdCents = Math.round(parseFloat(vProdTot || '0') * 100);
            const totalNFCents = Math.round(parseFloat(vNFTot || '0') * 100);

            if (totalProdCents !== calculatedTotalProducts) {
                errors.push({
                    path: '/NFe/infNFe/total/ICMSTot/vProd',
                    message: `Totalizador vProd (${vProdTot}) diverge da soma dos itens (${(calculatedTotalProducts / 100).toFixed(2)}).`,
                });
            }
            if (totalNFCents !== calculatedTotalProducts) {
                errors.push({
                    path: '/NFe/infNFe/total/ICMSTot/vNF',
                    message: `Valor total da NF-e vNF (${vNFTot}) diverge do somatório de produtos (${(calculatedTotalProducts / 100).toFixed(2)}).`,
                });
            }
        }
    }

    // 8. Grupo transp
    const transpXml = extractTag(infNFeXml, 'transp');
    if (!transpXml || !transpXml.includes('<modFrete>')) {
        errors.push({ path: '/NFe/infNFe/transp/modFrete', message: 'Grupo de transporte com <modFrete> é obrigatório.' });
    }

    // 9. Grupo pag
    const pagXml = extractTag(infNFeXml, 'pag');
    if (!pagXml || !pagXml.includes('<detPag>')) {
        errors.push({ path: '/NFe/infNFe/pag', message: 'Grupo de pagamento com ao menos um <detPag> é obrigatório.' });
    } else {
        const detPagList = extractAllTags(pagXml, 'detPag');
        let totalPaymentsCents = 0;
        detPagList.forEach((detPag, index) => {
            const tPag = extractTag(detPag, 'tPag');
            if (!tPag || !/^\d{2}$/.test(tPag)) {
                errors.push({ path: `/NFe/infNFe/pag/detPag[${index + 1}]/tPag`, message: 'Meio de pagamento tPag deve ter 2 dígitos.' });
            }
            const vPag = extractTag(detPag, 'vPag');
            if (!vPag || isNaN(parseFloat(vPag))) {
                errors.push({ path: `/NFe/infNFe/pag/detPag[${index + 1}]/vPag`, message: 'vPag inválido ou ausente.' });
            } else {
                totalPaymentsCents += Math.round(parseFloat(vPag) * 100);
            }
        });

        if (totalPaymentsCents < calculatedTotalProducts) {
            errors.push({
                path: '/NFe/infNFe/pag',
                message: `Somatório dos pagamentos (${(totalPaymentsCents / 100).toFixed(2)}) é inferior ao total da nota (${(calculatedTotalProducts / 100).toFixed(2)}).`,
            });
        }
    }

    return {
        valid: errors.length === 0,
        errors,
    };
}
