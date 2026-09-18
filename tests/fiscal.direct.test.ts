import assert from 'node:assert/strict';
import test from 'node:test';
import forge from 'node-forge';
import { createFakeD1 } from './helpers/fakeD1.ts';
import { getNextFiscalNumber, getCurrentFiscalSequence } from '../lib/fiscal/sequence.ts';
import { calculateDVMod11, generateAccessKey } from '../lib/fiscal/keys.ts';
import { encryptPayload, decryptPayload, parsePfx, saveFiscalCertificate, loadFiscalCertificate } from '../lib/fiscal/certificate.ts';
import { buildNFeXml } from '../lib/fiscal/builder.ts';
import { canonicalizeXml, signNFeXml, verifyNFeSignature } from '../lib/fiscal/signer.ts';
import { resolveSefazEndpoint } from '../lib/fiscal/endpoints.ts';
import { SefazDirectGateway } from '../lib/fiscal/gateway.ts';

import { createStore } from '../lib/catalog/service.ts';
import { permissionsForRole } from '../lib/authz/roles.ts';

// getMasterKey() em lib/fiscal/certificate.ts exige FISCAL_SECRET_KEY no ambiente (sem
// fallback fixo no código, §23) — o teste simula o que um deploy real precisa configurar.
process.env.FISCAL_SECRET_KEY ??= 'test-only-fiscal-secret-key-not-for-production!!';

const owner = { userId: 'owner-1', displayName: 'Dona', role: 'admin', storeId: null, permissions: permissionsForRole('OWNER') };

// Helper: gera um certificado A1 ICP-Brasil de teste em memória com node-forge
function generateTestPfx(passphrase: string, cnpj = '12345678000190') {
    const keys = forge.pki.rsa.generateKeyPair(1024); // 1024 para agilidade em testes
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = '01';
    cert.validity.notBefore = new Date(Date.now() - 1000 * 60);
    cert.validity.notAfter = new Date(Date.now() + 1000 * 60 * 60 * 24 * 365); // 1 ano

    const attrs = [
        { name: 'commonName', value: `EMPRESA DE TESTE LTDA:${cnpj}` },
        { name: 'countryName', value: 'BR' },
    ];
    cert.setSubject(attrs);
    cert.setIssuer(attrs);
    cert.sign(keys.privateKey, forge.md.sha256.create());

    const p12Asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], passphrase);
    const p12Der = forge.asn1.toDer(p12Asn1).getBytes();
    return {
        pfxBuffer: Buffer.from(p12Der, 'binary'),
        certPem: forge.pki.certificateToPem(cert),
        privateKeyPem: forge.pki.privateKeyToPem(keys.privateKey),
    };
}

test('FiscalSequenceService: numeração atômica sequencial por loja, modelo e série', async () => {
    const db = createFakeD1();
    await db.prepare("INSERT INTO accounts (id,name,state,revision,subscription_status,access_until,max_stores,created_at) VALUES ('t1','Tenant 1','{}',0,'trial',9999999999999,3,0)").bind().run();
    const s1 = await createStore(db, 't1', { name: 'Loja 1' }, owner);

    const n1 = await getNextFiscalNumber(db, 't1', s1, '55', 1);
    const n2 = await getNextFiscalNumber(db, 't1', s1, '55', 1);
    const n3 = await getNextFiscalNumber(db, 't1', s1, '55', 1);

    assert.equal(n1, 1);
    assert.equal(n2, 2);
    assert.equal(n3, 3);

    const current = await getCurrentFiscalSequence(db, 't1', s1, '55', 1);
    assert.equal(current, 3);

    // Série diferente inicia em 1
    const nSerie2 = await getNextFiscalNumber(db, 't1', s1, '55', 2);
    assert.equal(nSerie2, 1);
});

test('calculateDVMod11 e generateAccessKey: chave de 44 dígitos oficial MOC 7.00', () => {
    // Exemplo de chave parcial com 43 dígitos
    const key43 = '3526091234567800019055001000000001112345678';
    const dv = calculateDVMod11(key43);
    assert.ok(dv >= 0 && dv <= 9);

    const result = generateAccessKey({
        uf: 'SP',
        emissionDate: new Date('2026-09-16T12:00:00Z'),
        cnpj: '12.345.678/0001-90',
        model: '55',
        series: 1,
        number: 42,
        numericCode: '12345678',
    });

    assert.equal(result.accessKey.length, 44);
    assert.ok(result.accessKey.startsWith('3526091234567800019055001000000042112345678'));
});

test('CertificateService: criptografia AES-256-GCM e parse estrito de PKCS#12 A1', async () => {
    const db = createFakeD1();
    await db.prepare("INSERT INTO accounts (id,name,state,revision,subscription_status,access_until,max_stores,created_at) VALUES ('t1','Tenant 1','{}',0,'trial',9999999999999,3,0)").bind().run();
    const s1 = await createStore(db, 't1', { name: 'Loja 1' }, owner);

    const { pfxBuffer } = generateTestPfx('senha123', '12345678000190');

    // Roundtrip de criptografia
    const enc = encryptPayload(pfxBuffer);
    const dec = decryptPayload(enc);
    assert.deepEqual(dec, pfxBuffer);

    // Salva no banco e carrega
    const saved = await saveFiscalCertificate(db, 't1', {
        storeId: s1,
        pfxBuffer,
        passphrase: 'senha123',
    });

    assert.ok(saved.id);
    assert.equal(saved.subjectCnpj, '12345678000190');
    assert.ok(saved.validTo > Date.now());

    const loaded = await loadFiscalCertificate(db, 't1', saved.id);
    assert.equal(loaded.passphrase, 'senha123');
    assert.equal(loaded.parsed.subjectCnpj, '12345678000190');
});

test('NFeBuilder: constrói XML oficial no Layout 4.00 e bloqueia campos inválidos', () => {
    const emissionDate = new Date('2026-09-16T15:30:00Z');

    const result = buildNFeXml({
        environment: 'homologacao',
        series: 1,
        number: 1,
        emissionDate,
        issuer: {
            cnpj: '12.345.678/0001-90',
            legalName: 'LOJA TESTE LTDA',
            ie: '123456789',
            crt: '1_SIMPLES_NACIONAL',
            uf: 'SP',
            city: 'São Paulo',
            municipalityCode: '3550308',
            address: 'Rua das Flores',
            number: '123',
            district: 'Centro',
            zip: '01001-000',
        },
        items: [
            {
                code: 'SKU-01',
                description: 'Camiseta Algodão',
                ncm: '61091000',
                cfop: '5102',
                unit: 'UN',
                qty: 2,
                unitPrice: 5000, // R$ 50,00
                totalPrice: 10000, // R$ 100,00
                origin: '0',
                taxCode: '102',
            },
        ],
        payments: [
            { method: 'Pix', amount: 10000 },
        ],
        includeReformaTributaria2026: true,
    });

    assert.ok(result.xml.includes('<NFe xmlns="http://www.portalfiscal.inf.br/nfe">'));
    assert.ok(result.xml.includes('<infNFe Id="NFe' + result.accessKey + '" versao="4.00">'));
    assert.ok(result.xml.includes('<mod>55</mod>'));
    assert.ok(result.xml.includes('<tpAmb>2</tpAmb>')); // 2 = Homologação
    assert.ok(result.xml.includes('<ICMSSN102>'));
    assert.ok(result.xml.includes('<IBS>')); // Grupo preparatório Reforma Tributária 2026
    assert.ok(result.xml.includes('<CBS>'));
    assert.ok(result.xml.includes('<vNF>100.00</vNF>'));

    // Bloqueio de NCM com formato inválido
    assert.throws(() => {
        buildNFeXml({
            environment: 'homologacao',
            series: 1,
            number: 1,
            emissionDate,
            issuer: {
                cnpj: '12345678000190',
                legalName: 'LOJA',
                ie: '123',
                crt: '1_SIMPLES_NACIONAL',
                uf: 'SP',
                city: 'SP',
                municipalityCode: '3550308',
                address: 'Rua',
                number: '1',
                district: 'Bairro',
                zip: '01001000',
            },
            items: [{ code: 'P1', description: 'Item', ncm: '123', cfop: '5102', unit: 'UN', qty: 1, unitPrice: 10, totalPrice: 10 }],
            payments: [{ method: 'Dinheiro', amount: 10 }],
        });
    }, /NCM deve ter 8 dígitos/);
});

test('XmlSigner: assinatura digital XMLDSIG (C14N, SHA-1, RSA-SHA1) verificável', () => {
    const { pfxBuffer, certPem, privateKeyPem } = generateTestPfx('pass', '12345678000190');
    const parsed = parsePfx(pfxBuffer, 'pass');

    const rawXml =
        `<NFe xmlns="http://www.portalfiscal.inf.br/nfe">` +
        `<infNFe Id="NFe35260912345678000190550010000000011123456780" versao="4.00">` +
        `<ide><cUF>35</cUF></ide>` +
        `</infNFe>` +
        `</NFe>`;

    const signed = signNFeXml({
        xml: rawXml,
        accessKey: '35260912345678000190550010000000011123456780',
        privateKeyPem,
        certBase64: parsed.certBase64,
    });

    assert.ok(signed.signedXml.includes('<Signature xmlns="http://www.w3.org/2000/09/xmldsig#">'));
    assert.ok(signed.signedXml.includes('<DigestValue>' + signed.digestValue + '</DigestValue>'));
    assert.ok(signed.signedXml.includes('<SignatureValue>' + signed.signatureValue + '</SignatureValue>'));

    // Valida criptograficamente a assinatura
    const isValid = verifyNFeSignature(signed.signedXml, certPem);
    assert.equal(isValid, true);
});

test('FiscalEndpointResolver: resolução de URLs oficiais e bloqueio de produção', () => {
    const sp = resolveSefazEndpoint({ uf: 'SP', environment: 'homologacao', service: 'NFeStatusServico4' });
    assert.equal(sp.authorizer, 'SP');
    assert.ok(sp.url.includes('homologacao.nfe.fazenda.sp.gov.br'));

    const rj = resolveSefazEndpoint({ uf: 'RJ', environment: 'homologacao', service: 'NFeStatusServico4' });
    assert.equal(rj.authorizer, 'SVRS');
    assert.ok(rj.url.includes('nfe-homologacao.svrs.rs.gov.br'));

    // Produção deve estar estritamente bloqueada
    assert.throws(() => {
        resolveSefazEndpoint({ uf: 'SP', environment: 'producao', service: 'NFeStatusServico4' });
    }, /Ambiente de produção está bloqueado/);
});

test('SefazDirectGateway: instanciação da interface FiscalGateway oficial', () => {
    const gw = new SefazDirectGateway();
    assert.ok(typeof gw.checkServiceStatus === 'function');
    assert.ok(typeof gw.authorizeNFe === 'function');
});
