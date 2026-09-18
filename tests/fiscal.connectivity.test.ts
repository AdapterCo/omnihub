import assert from 'node:assert/strict';
import test from 'node:test';
import forge from 'node-forge';
import { createFakeD1 } from './helpers/fakeD1.ts';
import { createStore } from '../lib/catalog/service.ts';
import { permissionsForRole } from '../lib/authz/roles.ts';
import {
    getFiscalStoreConfig,
    saveFiscalStoreConfig,
    uploadCertificate,
    testSefazConnectivity,
} from '../lib/fiscal/service.ts';
import { loadFiscalCertificate } from '../lib/fiscal/certificate.ts';
import type { FiscalGateway } from '../lib/fiscal/gateway.ts';
import { dispatchCommand } from '../lib/relationalCommands.ts';

// getMasterKey() em lib/fiscal/certificate.ts exige FISCAL_SECRET_KEY no ambiente (sem
// fallback fixo no código, §23) — o teste simula o que um deploy real precisa configurar.
process.env.FISCAL_SECRET_KEY ??= 'test-only-fiscal-secret-key-not-for-production!!';

const owner = {
    userId: 'owner-1',
    displayName: 'Titular',
    role: 'ADMIN',
    storeId: null,
    permissions: permissionsForRole('OWNER'),
};

const operator = {
    userId: 'op-1',
    displayName: 'Operador',
    role: 'OPERADOR_CAIXA',
    storeId: null,
    permissions: permissionsForRole('OPERADOR_CAIXA'),
};

const plan = { status: 'active', accessUntil: Date.now() + 100000, maxStores: 3 };

function generateTestPfx(passphrase: string, cnpj = '12345678000190') {
    const keys = forge.pki.rsa.generateKeyPair(1024);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = '01';
    cert.validity.notBefore = new Date(Date.now() - 1000 * 60);
    cert.validity.notAfter = new Date(Date.now() + 1000 * 60 * 60 * 24 * 365);

    const attrs = [
        { name: 'commonName', value: `EMPRESA HOMOLOGACAO LTDA:${cnpj}` },
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

test('FiscalStoreConfig: salvar e consultar parâmetros de emissão da loja', async () => {
    const db = createFakeD1();
    await db.prepare("INSERT INTO accounts (id,name,state,revision,subscription_status,access_until,max_stores,created_at) VALUES ('t1','Tenant 1','{}',0,'active',9999999999999,3,0)").bind().run();
    const storeId = await createStore(db, 't1', { name: 'Matriz SP', uf: 'SP' }, owner);

    // Consulta inicial sem configuração
    const initialConfig = await getFiscalStoreConfig(db, 't1', storeId, owner);
    assert.equal(initialConfig.model, '55');
    assert.equal(initialConfig.environment, 'homologacao');
    assert.equal(initialConfig.series, 1);
    assert.equal(initialConfig.status, 'NOT_CONFIGURED');

    // Operador de caixa sem permissão FISCAL_CONFIG é bloqueado
    await assert.rejects(
        () => saveFiscalStoreConfig(db, 't1', storeId, { series: 2, crt: '3_REGIME_NORMAL' }, operator),
        /Você não tem permissão/
    );

    // Salvar configuração com OWNER
    await saveFiscalStoreConfig(db, 't1', storeId, { series: 2, crt: '3_REGIME_NORMAL' }, owner);

    const savedConfig = await getFiscalStoreConfig(db, 't1', storeId, owner);
    assert.equal(savedConfig.series, 2);
    assert.equal(savedConfig.crt, '3_REGIME_NORMAL');
    assert.equal(savedConfig.status, 'CONFIGURED');
});

test('Upload de certificado A1: criptografia em repouso AES-256-GCM e rejeição de senha inválida', async () => {
    const db = createFakeD1();
    await db.prepare("INSERT INTO accounts (id,name,state,revision,subscription_status,access_until,max_stores,created_at) VALUES ('t1','Tenant 1','{}',0,'active',9999999999999,3,0)").bind().run();
    const storeId = await createStore(db, 't1', { name: 'Filial 1', uf: 'SP' }, owner);

    const { pfxBuffer } = generateTestPfx('senha-secreta-123', '12345678000190');

    // Tentar com senha incorreta
    await assert.rejects(
        () => uploadCertificate(db, 't1', storeId, pfxBuffer, 'senha-errada', owner),
        /Senha incorreta ou arquivo de certificado A1/
    );

    // Upload correto
    const summary = await uploadCertificate(db, 't1', storeId, pfxBuffer, 'senha-secreta-123', owner);
    assert.equal(summary.subjectCnpj, '12345678000190');
    assert.equal(summary.status, 'VALID');
    assert.ok(summary.fingerprint.length > 20);

    // Verifica que o banco NÃO tem a senha em texto plano
    const certRow = await db.prepare("SELECT encrypted_data, encrypted_passphrase, iv, salt, auth_tag FROM fiscal_certificates WHERE id = ?").bind(summary.id).first<{ encrypted_data: string; encrypted_passphrase: string; iv: string; salt: string; auth_tag: string }>();
    assert.ok(certRow);
    assert.ok(!certRow.encrypted_data.includes('senha-secreta-123'), 'A senha não pode estar em texto plano no banco');
    assert.equal(certRow.encrypted_passphrase, '');

    // Consulta fiscalStoreConfig agora retorna status CERTIFICATE_VALID
    const config = await getFiscalStoreConfig(db, 't1', storeId, owner);
    assert.equal(config.status, 'CERTIFICATE_VALID');
    assert.equal(config.certificate?.subjectCnpj, '12345678000190');
    assert.equal(config.certificate?.status, 'VALID');
});

test('Isolamento de certificados e configurações fiscais entre tenants', async () => {
    const db = createFakeD1();
    await db.prepare("INSERT INTO accounts (id,name,state,revision,subscription_status,access_until,max_stores,created_at) VALUES ('t1','Tenant 1','{}',0,'active',9999999999999,3,0)").bind().run();
    await db.prepare("INSERT INTO accounts (id,name,state,revision,subscription_status,access_until,max_stores,created_at) VALUES ('t2','Tenant 2','{}',0,'active',9999999999999,3,0)").bind().run();

    const s1 = await createStore(db, 't1', { name: 'Loja T1', uf: 'SP' }, owner);
    const { pfxBuffer } = generateTestPfx('senha-t1', '11111111000111');
    const cert = await uploadCertificate(db, 't1', s1, pfxBuffer, 'senha-t1', owner);

    // Tenant 2 não consegue carregar o certificado do Tenant 1
    await assert.rejects(
        () => loadFiscalCertificate(db, 't2', cert.id),
        /Certificado digital não encontrado para este tenant/
    );
});

test('testSefazConnectivity: consulta direta NFeStatusServico4 em homologação com mTLS e auditoria', async () => {
    const db = createFakeD1();
    await db.prepare("INSERT INTO accounts (id,name,state,revision,subscription_status,access_until,max_stores,created_at) VALUES ('t1','Tenant 1','{}',0,'active',9999999999999,3,0)").bind().run();
    const storeId = await createStore(db, 't1', { name: 'Loja SP', uf: 'SP' }, owner);

    const { pfxBuffer } = generateTestPfx('senha123', '12345678000190');
    await uploadCertificate(db, 't1', storeId, pfxBuffer, 'senha123', owner);

    // Mock Gateway simulando resposta oficial SEFAZ SP em homologação
    const fakeGateway: FiscalGateway = {
        async checkServiceStatus(params) {
            assert.equal(params.uf, 'SP');
            assert.equal(params.environment, 'homologacao');
            assert.equal(params.passphrase, 'senha123');
            assert.ok(Buffer.isBuffer(params.pfx));

            return {
                cUF: '35',
                cStat: '107',
                xMotivo: 'Servico em Operacao',
                dhRecbto: '2026-09-17T02:30:00-03:00',
                tMed: '1',
                rawXml: '<retConsStatServ versao="4.00"><cUF>35</cUF><cStat>107</cStat><xMotivo>Servico em Operacao</xMotivo><dhRecbto>2026-09-17T02:30:00-03:00</dhRecbto><tMed>1</tMed></retConsStatServ>',
            };
        },
        async authorizeNFe() { throw new Error('Not implemented'); },
        async cancelNFe() { throw new Error('Not implemented'); },
        async inutilizeNumbering() { throw new Error('Not implemented'); },
    };

    const result = await testSefazConnectivity(db, 't1', storeId, owner, fakeGateway);

    assert.equal(result.environment, 'homologacao');
    assert.equal(result.uf, 'SP');
    assert.equal(result.authorizer, 'SP');
    assert.equal(result.service, 'NFeStatusServico4');
    assert.equal(result.cStat, '107');
    assert.equal(result.xMotivo, 'Servico em Operacao');
    assert.equal(result.status, 'OPERATIONAL');
    assert.ok(result.durationMs >= 0);

    // Verifica que o log de auditoria fiscal foi gravado
    const auditLogs = await db.prepare("SELECT * FROM fiscal_audit_logs WHERE tenant_id = 't1' AND store_id = ?").bind(storeId).all();
    assert.equal(auditLogs.results.length, 1);
    assert.equal(auditLogs.results[0].operation, 'NFeStatusServico4');
    assert.equal(auditLogs.results[0].status_code, 200);
});

test('dispatchCommand: integração completa dos comandos fiscais com idempotência e auditoria', async () => {
    const db = createFakeD1();
    await db.prepare("INSERT INTO accounts (id,name,state,revision,subscription_status,access_until,max_stores,created_at) VALUES ('t1','Tenant 1','{}',0,'active',9999999999999,3,0)").bind().run();
    const storeId = await createStore(db, 't1', { name: 'Loja RJ', uf: 'RJ' }, owner);

    // 1. fiscal.config.save
    await dispatchCommand(db, 't1', owner, plan, {
        type: 'fiscal.config.save',
        storeId,
        series: 10,
        crt: '1_SIMPLES_NACIONAL',
    });

    const cfg = await getFiscalStoreConfig(db, 't1', storeId, owner);
    assert.equal(cfg.series, 10);
    assert.equal(cfg.crt, '1_SIMPLES_NACIONAL');

    // 2. fiscal.certificate.upload
    const { pfxBuffer } = generateTestPfx('chave-rj', '98765432000100');
    const uploadRes = await dispatchCommand(db, 't1', owner, plan, {
        type: 'fiscal.certificate.upload',
        storeId,
        pfxBase64: pfxBuffer.toString('base64'),
        passphrase: 'chave-rj',
    });
    assert.ok(uploadRes);

    const cfgWithCert = await getFiscalStoreConfig(db, 't1', storeId, owner);
    assert.equal(cfgWithCert.certificate?.subjectCnpj, '98765432000100');
});
