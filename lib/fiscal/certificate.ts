import { randomBytes, createCipheriv, createDecipheriv, scryptSync, createHash } from 'node:crypto';
import forge from 'node-forge';
import { RuleError } from '../errors.ts';
import type { FiscalCertificateRecord } from './types.ts';

/**
 * Nunca cair para uma chave fixa no código (§23: "nunca... colocar senha em variável
 * pública", "considerar KMS/secret manager em produção"). Sem `FISCAL_SECRET_KEY`
 * configurada, bloqueia — não criptografa certificado real com um segredo previsível
 * que qualquer leitor do código conseguiria reproduzir.
 */
function getMasterKey(): string {
    const key = process.env.FISCAL_SECRET_KEY;
    if (!key || key.length < 32) {
        throw new RuleError('FISCAL_SECRET_KEY não configurada (ou curta demais) no ambiente. Configure um segredo de ao menos 32 caracteres, idealmente via KMS/secret manager, antes de operar com certificados fiscais.', 500);
    }
    return key;
}

export type EncryptedPayload = {
    ciphertext: string;
    iv: string;
    salt: string;
    authTag: string;
};

/**
 * Criptografa dados em repouso utilizando AES-256-GCM com chave derivada via scrypt.
 */
export function encryptPayload(data: Buffer | string, masterKey = getMasterKey()): EncryptedPayload {
    const rawData = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const key = scryptSync(masterKey, salt, 32);

    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(rawData), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return {
        ciphertext: encrypted.toString('base64'),
        iv: iv.toString('base64'),
        salt: salt.toString('base64'),
        authTag: authTag.toString('base64'),
    };
}

/**
 * Descriptografa dados em repouso protegidos por AES-256-GCM.
 */
export function decryptPayload(payload: EncryptedPayload, masterKey = getMasterKey()): Buffer {
    const salt = Buffer.from(payload.salt, 'base64');
    const iv = Buffer.from(payload.iv, 'base64');
    const authTag = Buffer.from(payload.authTag, 'base64');
    const encrypted = Buffer.from(payload.ciphertext, 'base64');

    const key = scryptSync(masterKey, salt, 32);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);

    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

export type ParsedCertificate = {
    certPem: string;
    privateKeyPem: string;
    certBase64: string;
    subjectCnpj: string;
    validFrom: number;
    validTo: number;
    fingerprint: string;
    subjectName: string;
};

/**
 * Faz o parse estrito de um certificado A1 no formato PKCS#12 (.pfx / .p12) em memória,
 * sem persistir em disco e sem expor em texto plano.
 */
export function parsePfx(pfxBuffer: Buffer, passphrase: string): ParsedCertificate {
    let p12: forge.pkcs12.Pkcs12Pfx;
    try {
        const p12Asn1 = forge.asn1.fromDer(forge.util.createBuffer(pfxBuffer.toString('binary')));
        p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, passphrase);
    } catch {
        throw new RuleError('Senha incorreta ou arquivo de certificado A1 (.pfx/.p12) inválido/corrompido.', 400);
    }

    let cert: forge.pki.Certificate | null = null;
    let privateKey: forge.pki.rsa.PrivateKey | null = null;

    for (const safeContents of p12.safeContents) {
        for (const safeBag of safeContents.safeBags) {
            if (safeBag.cert && !cert) {
                cert = safeBag.cert;
            }
            if (safeBag.key && !privateKey) {
                privateKey = safeBag.key as forge.pki.rsa.PrivateKey;
            }
        }
    }

    if (!cert) {
        throw new RuleError('Nenhum certificado X.509 encontrado no arquivo PKCS#12 informado.', 400);
    }
    if (!privateKey) {
        throw new RuleError('Nenhuma chave privada RSA encontrada no arquivo PKCS#12 informado.', 400);
    }

    const validFrom = cert.validity.notBefore.getTime();
    const validTo = cert.validity.notAfter.getTime();

    // Extrai Common Name e CNPJ do Subject
    let subjectName = '';
    for (const attr of cert.subject.attributes) {
        if (attr.name === 'commonName' && typeof attr.value === 'string') {
            subjectName = attr.value;
        }
    }

    // Procura padrão de CNPJ no Common Name (ex.: "EMPRESA XPTO LTDA:12345678000190")
    const match = subjectName.match(/\b\d{14}\b/) || subjectName.match(/:(\d{14})/);
    const subjectCnpj = match ? match[1] || match[0] : '';

    const certDer = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
    const certBase64 = Buffer.from(certDer, 'binary').toString('base64');
    const fingerprint = createHash('sha1').update(Buffer.from(certDer, 'binary')).digest('hex');

    const certPem = forge.pki.certificateToPem(cert);
    const privateKeyPem = forge.pki.privateKeyToPem(privateKey);

    return {
        certPem,
        privateKeyPem,
        certBase64,
        subjectCnpj,
        validFrom,
        validTo,
        fingerprint,
        subjectName,
    };
}

export function validateA1Certificate(pfxBuffer: Buffer, passphrase: string, now = Date.now()): ParsedCertificate {
    const parsed = parsePfx(pfxBuffer, passphrase);
    if (parsed.validTo < now) {
        throw new RuleError('O certificado digital informado está expirado.', 400);
    }
    return parsed;
}

/**
 * Salva e criptografa o certificado A1 no banco relacional para uma loja do tenant.
 */
export async function saveFiscalCertificate(
    db: D1Database,
    tenantId: string,
    params: { storeId?: string | null; pfxBuffer: Buffer; passphrase: string },
    now = Date.now(),
): Promise<{ id: string; subjectCnpj: string; validFrom: number; validTo: number; fingerprint: string }> {
    const parsed = validateA1Certificate(params.pfxBuffer, params.passphrase, now);

    const bundle = JSON.stringify({
        pfxBase64: params.pfxBuffer.toString('base64'),
        passphrase: params.passphrase,
    });
    const enc = encryptPayload(bundle);
    const id = crypto.randomUUID();

    await db
        .prepare(
            `INSERT INTO fiscal_certificates
             (id, tenant_id, store_id, encrypted_data, encrypted_passphrase, iv, salt, auth_tag, subject_cnpj, valid_from, valid_to, fingerprint, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
            id,
            tenantId,
            params.storeId || null,
            enc.ciphertext,
            '', // Mantido vazio pois a senha está embutida no bundle cifrado
            enc.iv,
            enc.salt,
            enc.authTag,
            parsed.subjectCnpj,
            parsed.validFrom,
            parsed.validTo,
            parsed.fingerprint,
            now,
        )
        .run();

    return {
        id,
        subjectCnpj: parsed.subjectCnpj,
        validFrom: parsed.validFrom,
        validTo: parsed.validTo,
        fingerprint: parsed.fingerprint,
    };
}

/**
 * Carrega e descriptografa o certificado A1 em memória para assinatura ou mTLS.
 * Nunca expõe chaves para fora do backend.
 */
export async function loadFiscalCertificate(
    db: D1Database,
    tenantId: string,
    certificateId: string,
): Promise<{ pfx: Buffer; passphrase: string; parsed: ParsedCertificate }> {
    const row = await db
        .prepare(
            `SELECT encrypted_data, iv, salt, auth_tag
             FROM fiscal_certificates
             WHERE id = ? AND tenant_id = ?`,
        )
        .bind(certificateId, tenantId)
        .first<{
            encrypted_data: string;
            iv: string;
            salt: string;
            auth_tag: string;
        }>();

    if (!row) {
        throw new RuleError('Certificado digital não encontrado para este tenant.', 404);
    }

    const bundleJson = decryptPayload({
        ciphertext: row.encrypted_data,
        iv: row.iv,
        salt: row.salt,
        authTag: row.auth_tag,
    }).toString('utf8');

    const { pfxBase64, passphrase } = JSON.parse(bundleJson) as { pfxBase64: string; passphrase: string };
    const pfxBuffer = Buffer.from(pfxBase64, 'base64');
    const parsed = parsePfx(pfxBuffer, passphrase);

    return { pfx: pfxBuffer, passphrase, parsed };
}

