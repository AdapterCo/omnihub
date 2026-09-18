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
    recipientDocument?: string; // cDest, quando o consumidor foi identificado
};

export function buildNFCeQrCode(input: BuildNFCeQrCodeInput): { url: string; params: string } {
    const baseUrl = (input.qrCodeBaseUrl || '').trim();
    if (!/^https:\/\/.+/i.test(baseUrl)) {
        throw new RuleError('URL de consulta do QR Code da NFC-e não configurada ou inválida para esta loja. Configure a URL oficial da SEFAZ da sua UF antes de emitir NFC-e.', 400);
    }
    if (!/^\d{44}$/.test(input.accessKey)) {
        throw new RuleError('Chave de acesso inválida para geração do QR Code.', 400);
    }
    const cscId = (input.cscId || '').trim();
    if (!cscId) {
        throw new RuleError('Identificador do CSC (idToken) não configurado para esta loja.', 400);
    }
    if (!input.csc) {
        throw new RuleError('CSC (Código de Segurança do Contribuinte) não configurado para esta loja.', 400);
    }

    const tpAmb = input.environment === 'producao' ? '1' : '2';
    const cDest = input.recipientDocument ? input.recipientDocument.replace(/\D/g, '') : '';

    // Parâmetros na ordem oficial da NT 2015.002: chave|versão|tpAmb|idCSC (+ cDest quando
    // o consumidor foi identificado), seguidos pelo hash SHA-1 hexadecimal.
    const params = `${input.accessKey}|2|${tpAmb}|${cscId}${cDest ? `|${cDest}` : ''}`;
    const hash = createHash('sha1').update(params + input.csc, 'utf8').digest('hex').toUpperCase();
    const url = `${baseUrl}?p=${params}|${hash}`;

    return { url, params };
}
