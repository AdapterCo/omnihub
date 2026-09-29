// Gera XMLs de EXEMPLO FICTÍCIO (NF-e 55 e NFC-e 65) com o montador e o assinador do próprio
// OmniHub, para conferência em validador externo antes da homologação na SEFAZ.
//   node scripts/homologacao/gerar-exemplos.ts <pasta-de-saída>
// O certificado é AUTOASSINADO, criado na hora (não é ICP-Brasil): serve só para conferir a
// estrutura e o cálculo da assinatura. Nada aqui pode ser enviado à SEFAZ como documento real.
import fs from 'node:fs';
import path from 'node:path';
import forge from 'node-forge';
import { buildNFeXml } from '../../lib/fiscal/builder.ts';
import { generateAccessKey } from '../../lib/fiscal/keys.ts';
import { buildNFCeQrCode } from '../../lib/fiscal/qrcode.ts';
import { signNFeXml, verifyNFeSignature } from '../../lib/fiscal/signer.ts';
import { validateNFeXmlSchema } from '../../lib/fiscal/validator.ts';

const out = process.argv[2];
if (!out) {
    console.error('Uso: node scripts/homologacao/gerar-exemplos.ts <pasta-de-saída>');
    process.exit(1);
}
fs.mkdirSync(out, { recursive: true });

// Dados FICTÍCIOS de exemplo: CNPJ 11.222.333/0001-81, IE (SP) 110.042.490.114 e CPF 529.982.247-25
// são números de exemplo com dígitos verificadores válidos; não pertencem à empresa.
const ISSUER = { cnpj: '11222333000181', legalName: 'EMPRESA EXEMPLO FICTICIA LTDA', tradeName: 'LOJA EXEMPLO', ie: '110042490114', crt: '1_SIMPLES_NACIONAL' as const, uf: 'SP', city: 'SAO PAULO', municipalityCode: '3550308', address: 'AVENIDA EXEMPLO', number: '100', district: 'CENTRO', zip: '01001000' };
const item = (n: number, price: number, qty = 1, discount = 0) => ({ code: `P${n}`, description: `PRODUTO EXEMPLO ${n}`, ncm: '22021000', cfop: '5102', unit: 'UN', qty, unitPrice: price, totalPrice: price * qty, discount, origin: '0', taxCode: '102' });
const CPF = { document: '52998224725', name: 'CLIENTE EXEMPLO' };
const emission = new Date();

const keys = forge.pki.rsa.generateKeyPair(2048);
const cert = forge.pki.createCertificate();
cert.publicKey = keys.publicKey;
cert.serialNumber = '01';
cert.validity.notBefore = new Date(Date.now() - 60_000);
cert.validity.notAfter = new Date(Date.now() + 86_400_000 * 30);
const attrs = [{ name: 'commonName', value: `EMPRESA EXEMPLO FICTICIA LTDA:${ISSUER.cnpj}` }, { name: 'countryName', value: 'BR' }];
cert.setSubject(attrs);
cert.setIssuer(attrs);
cert.sign(keys.privateKey, forge.md.sha256.create());
const privateKeyPem = forge.pki.privateKeyToPem(keys.privateKey);
const certPem = forge.pki.certificateToPem(cert);
const certBase64 = forge.util.encode64(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes());

type Scenario = { file: string; model: '55' | '65'; number: number; presence: '1' | '2' | '4'; items: ReturnType<typeof item>[]; payments: { method: string; amount: number }[]; recipient?: typeof CPF };
const scenarios: Scenario[] = [
    { file: 'A-nfe55-presencial-pix-desconto', model: '55', number: 1, presence: '1', items: [item(1, 1000, 2, 150), item(2, 2550, 1, 350)], payments: [{ method: 'Pix', amount: 4050 }], recipient: CPF },
    { file: 'B-nfe55-internet-cartao-credito', model: '55', number: 2, presence: '2', items: [item(1, 15990)], payments: [{ method: 'Cartão de crédito', amount: 15990 }], recipient: CPF },
    { file: 'C-nfe55-entrega-dinheiro-e-debito', model: '55', number: 3, presence: '4', items: [item(1, 5000), item(3, 1234, 3)], payments: [{ method: 'Dinheiro', amount: 3000 }, { method: 'Cartão de débito', amount: 5702 }], recipient: CPF },
    { file: 'D-nfce65-presencial-debito-sem-cpf', model: '65', number: 1, presence: '1', items: [item(1, 500, 2)], payments: [{ method: 'Cartão de débito', amount: 1000 }] },
    { file: 'E-nfce65-entrega-pix-com-cpf', model: '65', number: 2, presence: '4', items: [item(2, 2990)], payments: [{ method: 'Pix', amount: 2990 }], recipient: CPF },
];

for (const s of scenarios) {
    let numericCode: string | undefined;
    let qrCode: { url: string; consultaUrl: string } | undefined;
    if (s.model === '65') {
        const k = generateAccessKey({ uf: ISSUER.uf, emissionDate: emission, cnpj: ISSUER.cnpj, model: '65', series: 1, number: s.number });
        numericCode = k.numericCode;
        // CSC e URL de consulta FICTÍCIOS: a SEFAZ confere o hash com o CSC real da empresa e a URL
        // vem da configuração da loja; aqui só a estrutura importa.
        qrCode = { url: buildNFCeQrCode({ environment: 'homologacao', qrCodeBaseUrl: 'https://www.homologacao.nfce.fazenda.sp.gov.br/qrcode', accessKey: k.accessKey, cscId: '000001', csc: 'CSC-FICTICIO-DE-EXEMPLO' }).url, consultaUrl: 'https://www.homologacao.nfce.fazenda.sp.gov.br/consulta' };
    }
    const { xml, accessKey } = buildNFeXml({ environment: 'homologacao', model: s.model, series: 1, number: s.number, numericCode, emissionDate: emission, issuer: ISSUER, recipient: s.recipient, items: s.items, payments: s.payments, natureOfOperation: 'VENDA DE MERCADORIA EXEMPLO', presence: s.presence, qrCode });
    const schema = validateNFeXmlSchema(xml, s.model);
    const { signedXml } = signNFeXml({ xml, accessKey, privateKeyPem, certBase64 });
    fs.writeFileSync(path.join(out, `${s.file}.xml`), signedXml);
    console.log(`${s.file}  chave ${accessKey}  schema local: ${schema.valid ? 'ok' : JSON.stringify(schema.errors)}  assinatura local: ${verifyNFeSignature(signedXml, certPem) ? 'ok' : 'FALHOU'}`);
}
