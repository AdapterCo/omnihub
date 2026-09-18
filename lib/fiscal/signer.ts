import { createHash, sign, verify } from 'node:crypto';
import { RuleError } from '../errors.ts';

/**
 * Aplica regras essenciais de Canonical XML 1.0 (C14N) sem comentários
 * (http://www.w3.org/TR/2001/REC-xml-c14n-20010315) para nós de NF-e:
 * - Converte tags vazias `<tag/>` para `<tag></tag>`
 * - Ordena atributos lexicograficamente
 * - Normaliza quebras de linha para LF
 * - Remove espaços desnecessários entre tags no nível raiz
 */
export function canonicalizeXml(xml: string): string {
    // Normaliza quebras de linha e remove declarações XML <?xml ...?>
    let clean = xml.replace(/<\?xml.*?\?>/gi, '').trim();

    // Expande tags auto-fechadas <tag attr="val"/> -> <tag attr="val"></tag>
    clean = clean.replace(/<([a-zA-Z0-9_:]+)((?:\s+[^>]*?)?)\s*\/>/g, '<$1$2></$1>');

    // Normaliza atributos de tags: ordena atributos alfabeticamente
    clean = clean.replace(/<([a-zA-Z0-9_:]+)((?:\s+[^>]+?)+)>/g, (_match, tagName, attrsStr) => {
        const attrRegex = /([a-zA-Z0-9_:]+)=["']([^"']*)["']/g;
        const attrs: { name: string; value: string }[] = [];
        let m: RegExpExecArray | null;
        while ((m = attrRegex.exec(attrsStr)) !== null) {
            attrs.push({ name: m[1]!, value: m[2]! });
        }

        // Ordena atributos por nome
        attrs.sort((a, b) => a.name.localeCompare(b.name));

        const formatted = attrs.map((a) => `${a.name}="${a.value}"`).join(' ');
        return formatted ? `<${tagName} ${formatted}>` : `<${tagName}>`;
    });

    return clean;
}

export type SignNFeInput = {
    xml: string;
    accessKey: string;
    privateKeyPem: string;
    certBase64: string;
};

/**
 * Assina digitalmente o XML da NF-e no padrão W3C XMLDSIG conforme MOC 7.00 Anexo II:
 * 1. Localiza a tag `<infNFe Id="NFe{chave}">`
 * 2. Calcula o DigestValue via SHA-1 sobre o fragmento canônico C14N de `<infNFe>`
 * 3. Constrói `<SignedInfo>` com as transformações oficiais (enveloped-signature + C14N)
 * 4. Assina `<SignedInfo>` com chave privada RSA via RSA-SHA1 gerando `<SignatureValue>`
 * 5. Insere `<Signature>` com `<KeyInfo><X509Data><X509Certificate>` antes de `</NFe>`
 */
export function signNFeXml(input: SignNFeInput): { signedXml: string; digestValue: string; signatureValue: string } {
    const { xml, accessKey, privateKeyPem, certBase64 } = input;

    // Localiza a tag infNFe
    const infNFeRegex = new RegExp(`(<infNFe[^>]*?Id=["']NFe${accessKey}["'][\\s\\S]*?<\\/infNFe>)`, 'i');
    const match = xml.match(infNFeRegex);
    if (!match || !match[1]) {
        throw new RuleError(`Nó <infNFe Id="NFe${accessKey}"> não encontrado no XML para assinatura digital.`, 400);
    }

    const rawInfNFe = match[1];
    const canonicalInfNFe = canonicalizeXml(rawInfNFe);

    // 1. Calcula Digest SHA-1 do infNFe
    const digestValue = createHash('sha1').update(canonicalInfNFe, 'utf8').digest('base64');

    // 2. Monta SignedInfo
    const rawSignedInfo =
        `<SignedInfo xmlns="http://www.w3.org/2000/09/xmldsig#">` +
        `<CanonicalizationMethod Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"/>` +
        `<SignatureMethod Algorithm="http://www.w3.org/2000/09/xmldsig#rsa-sha1"/>` +
        `<Reference URI="#NFe${accessKey}">` +
        `<Transforms>` +
        `<Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"/>` +
        `<Transform Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"/>` +
        `</Transforms>` +
        `<DigestMethod Algorithm="http://www.w3.org/2000/09/xmldsig#sha1"/>` +
        `<DigestValue>${digestValue}</DigestValue>` +
        `</Reference>` +
        `</SignedInfo>`;

    const canonicalSignedInfo = canonicalizeXml(rawSignedInfo);

    // 3. Assina SignedInfo com RSA-SHA1
    const signatureBuffer = sign('RSA-SHA1', Buffer.from(canonicalSignedInfo, 'utf8'), privateKeyPem);
    const signatureValue = signatureBuffer.toString('base64');

    // Limpa delimitadores do certificado para garantir base64 contínuo
    const cleanCertBase64 = certBase64.replace(/-----[^\n]+-----/g, '').replace(/\s+/g, '');

    // 4. Monta Signature
    const signatureBlock =
        `<Signature xmlns="http://www.w3.org/2000/09/xmldsig#">` +
        canonicalSignedInfo +
        `<SignatureValue>${signatureValue}</SignatureValue>` +
        `<KeyInfo>` +
        `<X509Data>` +
        `<X509Certificate>${cleanCertBase64}</X509Certificate>` +
        `</X509Data>` +
        `</KeyInfo>` +
        `</Signature>`;

    // 5. Insere Signature antes de </NFe>
    if (!xml.includes('</NFe>')) {
        throw new RuleError('XML inválido: tag de fechamento </NFe> não encontrada.', 400);
    }

    const signedXml = xml.replace('</NFe>', `${signatureBlock}</NFe>`);

    return { signedXml, digestValue, signatureValue };
}

export type SignEventInput = {
    xml: string;
    eventId: string;
    privateKeyPem: string;
    certBase64: string;
};

/**
 * Assina digitalmente o XML de um evento fiscal (ex.: cancelamento, §29) no mesmo padrão
 * XMLDSIG usado para a NF-e (signNFeXml), mas referenciando o nó `<infEvento Id="...">`
 * e inserindo a `<Signature>` antes de `</evento>` em vez de `</NFe>`.
 */
export function signEventXml(input: SignEventInput): { signedXml: string; digestValue: string; signatureValue: string } {
    const { xml, eventId, privateKeyPem, certBase64 } = input;

    const infEventoRegex = new RegExp(`(<infEvento[^>]*?Id=["']${eventId}["'][\\s\\S]*?<\\/infEvento>)`, 'i');
    const match = xml.match(infEventoRegex);
    if (!match || !match[1]) {
        throw new RuleError(`Nó <infEvento Id="${eventId}"> não encontrado no XML para assinatura digital.`, 400);
    }

    const rawInfEvento = match[1];
    const canonicalInfEvento = canonicalizeXml(rawInfEvento);

    const digestValue = createHash('sha1').update(canonicalInfEvento, 'utf8').digest('base64');

    const rawSignedInfo =
        `<SignedInfo xmlns="http://www.w3.org/2000/09/xmldsig#">` +
        `<CanonicalizationMethod Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"/>` +
        `<SignatureMethod Algorithm="http://www.w3.org/2000/09/xmldsig#rsa-sha1"/>` +
        `<Reference URI="#${eventId}">` +
        `<Transforms>` +
        `<Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"/>` +
        `<Transform Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"/>` +
        `</Transforms>` +
        `<DigestMethod Algorithm="http://www.w3.org/2000/09/xmldsig#sha1"/>` +
        `<DigestValue>${digestValue}</DigestValue>` +
        `</Reference>` +
        `</SignedInfo>`;

    const canonicalSignedInfo = canonicalizeXml(rawSignedInfo);

    const signatureBuffer = sign('RSA-SHA1', Buffer.from(canonicalSignedInfo, 'utf8'), privateKeyPem);
    const signatureValue = signatureBuffer.toString('base64');

    const cleanCertBase64 = certBase64.replace(/-----[^\n]+-----/g, '').replace(/\s+/g, '');

    const signatureBlock =
        `<Signature xmlns="http://www.w3.org/2000/09/xmldsig#">` +
        canonicalSignedInfo +
        `<SignatureValue>${signatureValue}</SignatureValue>` +
        `<KeyInfo>` +
        `<X509Data>` +
        `<X509Certificate>${cleanCertBase64}</X509Certificate>` +
        `</X509Data>` +
        `</KeyInfo>` +
        `</Signature>`;

    if (!xml.includes('</evento>')) {
        throw new RuleError('XML inválido: tag de fechamento </evento> não encontrada.', 400);
    }

    const signedXml = xml.replace('</evento>', `${signatureBlock}</evento>`);

    return { signedXml, digestValue, signatureValue };
}

export type SignInutilizacaoInput = {
    xml: string;
    infInutId: string;
    privateKeyPem: string;
    certBase64: string;
};

/**
 * Assina digitalmente o XML de inutilização de numeração (§25) no mesmo padrão XMLDSIG,
 * referenciando o nó `<infInut Id="...">` e inserindo a `<Signature>` antes de
 * `</inutNFe>`.
 */
export function signInutilizacaoXml(input: SignInutilizacaoInput): { signedXml: string; digestValue: string; signatureValue: string } {
    const { xml, infInutId, privateKeyPem, certBase64 } = input;

    const infInutRegex = new RegExp(`(<infInut[^>]*?Id=["']${infInutId}["'][\\s\\S]*?<\\/infInut>)`, 'i');
    const match = xml.match(infInutRegex);
    if (!match || !match[1]) {
        throw new RuleError(`Nó <infInut Id="${infInutId}"> não encontrado no XML para assinatura digital.`, 400);
    }

    const rawInfInut = match[1];
    const canonicalInfInut = canonicalizeXml(rawInfInut);

    const digestValue = createHash('sha1').update(canonicalInfInut, 'utf8').digest('base64');

    const rawSignedInfo =
        `<SignedInfo xmlns="http://www.w3.org/2000/09/xmldsig#">` +
        `<CanonicalizationMethod Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"/>` +
        `<SignatureMethod Algorithm="http://www.w3.org/2000/09/xmldsig#rsa-sha1"/>` +
        `<Reference URI="#${infInutId}">` +
        `<Transforms>` +
        `<Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"/>` +
        `<Transform Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"/>` +
        `</Transforms>` +
        `<DigestMethod Algorithm="http://www.w3.org/2000/09/xmldsig#sha1"/>` +
        `<DigestValue>${digestValue}</DigestValue>` +
        `</Reference>` +
        `</SignedInfo>`;

    const canonicalSignedInfo = canonicalizeXml(rawSignedInfo);

    const signatureBuffer = sign('RSA-SHA1', Buffer.from(canonicalSignedInfo, 'utf8'), privateKeyPem);
    const signatureValue = signatureBuffer.toString('base64');

    const cleanCertBase64 = certBase64.replace(/-----[^\n]+-----/g, '').replace(/\s+/g, '');

    const signatureBlock =
        `<Signature xmlns="http://www.w3.org/2000/09/xmldsig#">` +
        canonicalSignedInfo +
        `<SignatureValue>${signatureValue}</SignatureValue>` +
        `<KeyInfo>` +
        `<X509Data>` +
        `<X509Certificate>${cleanCertBase64}</X509Certificate>` +
        `</X509Data>` +
        `</KeyInfo>` +
        `</Signature>`;

    if (!xml.includes('</inutNFe>')) {
        throw new RuleError('XML inválido: tag de fechamento </inutNFe> não encontrada.', 400);
    }

    const signedXml = xml.replace('</inutNFe>', `${signatureBlock}</inutNFe>`);

    return { signedXml, digestValue, signatureValue };
}

/**
 * Valida a integridade criptográfica da assinatura digital XMLDSIG gerada.
 */
export function verifyNFeSignature(signedXml: string, certPem: string): boolean {
    const sigValueMatch = signedXml.match(/<SignatureValue[^>]*>([\s\S]*?)<\/SignatureValue>/i);
    const signedInfoMatch = signedXml.match(/(<SignedInfo[^>]*>[\s\S]*?<\/SignedInfo>)/i);

    if (!sigValueMatch || !sigValueMatch[1] || !signedInfoMatch || !signedInfoMatch[1]) {
        return false;
    }

    const signatureValue = Buffer.from(sigValueMatch[1].replace(/\s+/g, ''), 'base64');
    const canonicalSignedInfo = canonicalizeXml(signedInfoMatch[1]);

    try {
        return verify('RSA-SHA1', Buffer.from(canonicalSignedInfo, 'utf8'), certPem, signatureValue);
    } catch {
        return false;
    }
}
