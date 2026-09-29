import { createHash } from 'node:crypto';
import { RuleError } from '../errors.ts';
import type { FiscalEnvironment } from './types.ts';

// QR Code da NFC-e (§20), formato "offline" com CSC, conforme NT 2015.002. A URL base de
// consulta (`qrCodeBaseUrl`) é específica de cada UF e É CONFIGURADA PELO USUÁRIO por loja
// (nunca hardcoded aqui) — §36/§79: não presumir dado fiscal/cadastral sem fonte
// verificada; o operador deve obter essa URL no credenciamento junto à SEFAZ da sua UF.
//
// RESSALVA (mesma classe das demais desta sessão): a fórmula do hash (SHA-1 hexadecimal
// da concatenação da URL de parâmetros com o CSC) segue a especificação amplamente
// documentada da NT 2015.002, mas não foi reverificada contra uma fonte oficial ao vivo
// nesta sessão (mesma limitação de rede já registrada em docs/analise-inicial.md).
// Confirmar contra a NT 2015.002 vigente antes de qualquer emissão real de NFC-e.
export type BuildNFCeQrCodeInput = {
    environment: FiscalEnvironment;
    qrCodeBaseUrl: string;
    accessKey: string;
    cscId: string;
    csc: string;
};

export function buildNFCeQrCode(input: BuildNFCeQrCodeInput): { url: string; params: string } {
    const baseUrl = (input.qrCodeBaseUrl || '').trim();
    if (!/^https:\/\/.+/i.test(baseUrl)) {
        throw new RuleError('URL de consulta do QR Code da NFC-e não configurada ou inválida para esta loja. Configure a URL oficial da SEFAZ da sua UF antes de emitir NFC-e.', 400);
    }
    if (!/^\d{44}$/.test(input.accessKey)) {
        throw new RuleError('Chave de acesso inválida para geração do QR Code.', 400);
    }
    const rawCscId = (input.cscId || '').trim();
    if (!rawCscId) {
        throw new RuleError('Identificador do CSC (idToken) não configurado para esta loja.', 400);
    }
    if (!/^\d{1,6}$/.test(rawCscId)) {
        throw new RuleError('Identificador do CSC deve ser numérico (até 6 dígitos), como informado pela SEFAZ.', 400);
    }
    // O schema oficial só aceita o identificador sem zeros à esquerda ("000001" -> "1"); o valor
    // é o mesmo, só muda a escrita (rejeitado com cStat 225 no validador da SVRS em 2026-09-28).
    const cscId = String(Number(rawCscId));
    if (!input.csc) {
        throw new RuleError('CSC (Código de Segurança do Contribuinte) não configurado para esta loja.', 400);
    }

    const tpAmb = input.environment === 'producao' ? '1' : '2';
    // Versão 2 do QR Code (emissão normal): chave|2|tpAmb|idCSC, seguidos do hash SHA-1
    // hexadecimal. O CPF/CNPJ do consumidor NÃO entra no QR Code da versão 2 (o schema oficial
    // rejeitou a URL com o CPF); a identificação fica só no grupo <dest> do XML.
    const params = `${input.accessKey}|2|${tpAmb}|${cscId}`;
    const hash = createHash('sha1').update(params + input.csc, 'utf8').digest('hex').toUpperCase();
    const url = `${baseUrl}?p=${params}|${hash}`;

    return { url, params };
}
