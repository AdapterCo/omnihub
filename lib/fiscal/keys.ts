import { RuleError } from '../errors.ts';
import { localParts } from '../time.ts';

export const UF_IBGE_CODES: Record<string, string> = {
    RO: '11', AC: '12', AM: '13', RR: '14', PA: '15', AP: '16', TO: '17',
    MA: '21', PI: '22', CE: '23', RN: '24', PB: '25', PE: '26', AL: '27',
    SE: '28', BA: '29', MG: '31', ES: '32', RJ: '33', SP: '35', PR: '41',
    SC: '42', RS: '43', MS: '50', MT: '51', GO: '52', DF: '53',
};

/**
 * Calcula o Dígito Verificador (DV) da chave de 43 dígitos utilizando
 * o algoritmo Módulo 11 com pesos de 2 a 9 da direita para a esquerda,
 * conforme o Manual de Orientação do Contribuinte (MOC) v7.00, item 5.4.
 */
export function calculateDVMod11(key43: string): number {
    if (!/^\d{43}$/.test(key43)) {
        throw new RuleError('A chave parcial para cálculo do DV deve conter exatamente 43 dígitos numéricos.', 400);
    }

    let sum = 0;
    let weight = 2;

    for (let i = key43.length - 1; i >= 0; i--) {
        const digit = Number(key43[i]);
        sum += digit * weight;
        weight = weight === 9 ? 2 : weight + 1;
    }

    const remainder = sum % 11;
    if (remainder === 0 || remainder === 1) {
        return 0;
    }
    return 11 - remainder;
}

export type GenerateAccessKeyInput = {
    uf: string;
    emissionDate: Date;
    cnpj: string;
    model: '55' | '65';
    series: number;
    number: number;
    emissionType?: '1'; // 1 = Emissão normal
    numericCode?: string; // cNF (8 dígitos aleatórios)
};

/**
 * Monta a chave de acesso oficial de 44 dígitos da NF-e / NFC-e.
 * Composição:
 * - cUF: 2 dígitos
 * - AAMM: 4 dígitos (ano e mês da emissão)
 * - CNPJ: 14 dígitos
 * - mod: 2 dígitos ('55' ou '65')
 * - serie: 3 dígitos (zeros à esquerda)
 * - nNF: 9 dígitos (zeros à esquerda)
 * - tpEmis: 1 dígito ('1' normal)
 * - cNF: 8 dígitos (código numérico)
 * - cDV: 1 dígito verificador
 */
export function generateAccessKey(input: GenerateAccessKeyInput): { accessKey: string; numericCode: string } {
    const ufCode = UF_IBGE_CODES[input.uf.toUpperCase()];
    if (!ufCode) {
        throw new RuleError(`UF '${input.uf}' inválida ou não reconhecida para emissão fiscal.`, 400);
    }

    const cleanCnpj = input.cnpj.replace(/\D/g, '');
    if (cleanCnpj.length !== 14) {
        throw new RuleError('CNPJ do emitente deve conter exatamente 14 dígitos para composição da chave de acesso.', 400);
    }

    // AAMM no fuso do sistema (o mesmo de dhEmi): no servidor em UTC, uma nota emitida às 23h do
    // último dia do mês teria o mês seguinte e a chave não bateria com a data de emissão.
    const emission = localParts(input.emissionDate.getTime());
    const year = String(emission.year).slice(-2);
    const month = String(emission.month).padStart(2, '0');
    const aamm = `${year}${month}`;

    const mod = input.model;
    const serie = String(input.series).padStart(3, '0');
    const nNF = String(input.number).padStart(9, '0');
    const tpEmis = input.emissionType ?? '1';

    // Se cNF não for fornecido, gera 8 dígitos numéricos aleatórios (mínimo 10000000)
    let cNF = input.numericCode;
    if (!cNF || !/^\d{8}$/.test(cNF)) {
        const randomInt = Math.floor(10000000 + Math.random() * 90000000);
        cNF = String(randomInt);
    }

    const key43 = `${ufCode}${aamm}${cleanCnpj}${mod}${serie}${nNF}${tpEmis}${cNF}`;
    const cDV = calculateDVMod11(key43);
    const accessKey = `${key43}${cDV}`;

    return { accessKey, numericCode: cNF };
}
