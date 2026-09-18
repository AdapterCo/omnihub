import https from 'node:https';
import { RuleError } from '../errors.ts';
import { resolveSefazEndpoint, type SefazService } from './endpoints.ts';
import type { FiscalEnvironment } from './types.ts';

export type ServiceStatusResult = {
    cStat: string;
    xMotivo: string;
    cUF: string;
    dhRecbto: string;
    tMed: string;
    rawXml: string;
};

export type AuthorizationResult = {
    cStat: string;
    xMotivo: string;
    nProt?: string;
    dhRecbto?: string;
    accessKey?: string;
    rawXml: string;
};

export interface FiscalGateway {
    checkServiceStatus(params: {
        uf: string;
        environment: FiscalEnvironment;
        pfx: Buffer;
        passphrase: string;
    }): Promise<ServiceStatusResult>;

    authorizeNFe(params: {
        uf: string;
        environment: FiscalEnvironment;
        signedXml: string;
        pfx: Buffer;
        passphrase: string;
    }): Promise<AuthorizationResult>;

    cancelNFe(params: {
        uf: string;
        environment: FiscalEnvironment;
        signedEventXml: string;
        pfx: Buffer;
        passphrase: string;
    }): Promise<AuthorizationResult>;

    inutilizeNumbering(params: {
        uf: string;
        environment: FiscalEnvironment;
        signedInutilizacaoXml: string;
        pfx: Buffer;
        passphrase: string;
    }): Promise<AuthorizationResult>;
}

function buildSoap12Envelope(serviceName: SefazService, payloadXml: string): string {
    return (
        `<?xml version="1.0" encoding="utf-8"?>` +
        `<soap12:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">` +
        `<soap12:Body>` +
        `<nfeDadosMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/${serviceName}">` +
        payloadXml +
        `</nfeDadosMsg>` +
        `</soap12:Body>` +
        `</soap12:Envelope>`
    );
}

function extractXmlTag(xml: string, tagName: string): string | undefined {
    const regex = new RegExp(`<(?:[a-zA-Z0-9_]+:)?${tagName}[^>]*>([\\s\\S]*?)<\\/(?:[a-zA-Z0-9_]+:)?${tagName}>`, 'i');
    const match = xml.match(regex);
    return match && match[1] ? match[1].trim() : undefined;
}

/**
 * Realiza uma requisição SOAP 1.2 direta com mTLS ICP-Brasil contra os servidores da SEFAZ,
 * sem intermediários ou APIs terceiras.
 */
async function postSoap(
    urlStr: string,
    soapAction: string,
    soapBody: string,
    pfx: Buffer,
    passphrase: string,
): Promise<{ status: number; body: string }> {
    const url = new URL(urlStr);

    const agent = new https.Agent({
        pfx,
        passphrase,
        // Mantém TLS 1.2 obrigatório conforme MOC 7.00
        minVersion: 'TLSv1.2',
        maxVersion: 'TLSv1.2',
        rejectUnauthorized: true,
    });

    const headers: Record<string, string> = {
        'Content-Type': 'application/soap+xml; charset=utf-8; action="' + soapAction + '"',
        'Content-Length': String(Buffer.byteLength(soapBody, 'utf8')),
    };

    return new Promise((resolve, reject) => {
        const req = https.request(
            url,
            {
                method: 'POST',
                headers,
                agent,
                timeout: 30000,
            },
            (res) => {
                let data = '';
                res.on('data', (chunk) => {
                    data += chunk;
                });
                res.on('end', () => {
                    resolve({ status: res.statusCode || 0, body: data });
                });
            },
        );

        req.on('error', (err) => {
            reject(new RuleError(`Falha na comunicação direta com a SEFAZ: ${err.message}`, 502));
        });

        req.on('timeout', () => {
            req.destroy();
            reject(new RuleError('Tempo limite (timeout de 30s) esgotado ao comunicar diretamente com a SEFAZ.', 504));
        });

        req.write(soapBody, 'utf8');
        req.end();
    });
}

/**
 * Implementação Oficial da comunicação direta com os Web Services oficiais da SEFAZ
 * via mTLS e SOAP 1.2 (SefazDirectGateway).
 */
export class SefazDirectGateway implements FiscalGateway {
    async checkServiceStatus(params: {
        uf: string;
        environment: FiscalEnvironment;
        pfx: Buffer;
        passphrase: string;
    }): Promise<ServiceStatusResult> {
        const { url, soapAction } = resolveSefazEndpoint({
            uf: params.uf,
            environment: params.environment,
            service: 'NFeStatusServico4',
        });

        const tpAmb = params.environment === 'producao' ? '1' : '2';
        const payloadXml = `<consStatServ xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00"><tpAmb>${tpAmb}</tpAmb><cUF>${params.uf.toUpperCase()}</cUF><xServ>STATUS</xServ></consStatServ>`;
        const soapEnvelope = buildSoap12Envelope('NFeStatusServico4', payloadXml);

        const response = await postSoap(url, soapAction, soapEnvelope, params.pfx, params.passphrase);
        const cStat = extractXmlTag(response.body, 'cStat') || '999';
        const xMotivo = extractXmlTag(response.body, 'xMotivo') || 'Resposta SEFAZ sem xMotivo';
        const cUF = extractXmlTag(response.body, 'cUF') || '';
        const dhRecbto = extractXmlTag(response.body, 'dhRecbto') || '';
        const tMed = extractXmlTag(response.body, 'tMed') || '1';

        return {
            cStat,
            xMotivo,
            cUF,
            dhRecbto,
            tMed,
            rawXml: response.body,
        };
    }

    async authorizeNFe(params: {
        uf: string;
        environment: FiscalEnvironment;
        signedXml: string;
        pfx: Buffer;
        passphrase: string;
    }): Promise<AuthorizationResult> {
        const { url, soapAction } = resolveSefazEndpoint({
            uf: params.uf,
            environment: params.environment,
            service: 'NFeAutorizacao4',
        });

        const idLote = String(Date.now()).slice(-15);
        const tpAmb = params.environment === 'producao' ? '1' : '2';

        // Envelopa o XML assinado da NF-e no lote de envio enviNFe versao="4.00" com indSinc="1" (síncrono)
        const payloadXml =
            `<enviNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">` +
            `<idLote>${idLote}</idLote>` +
            `<indSinc>1</indSinc>` +
            params.signedXml +
            `</enviNFe>`;

        const soapEnvelope = buildSoap12Envelope('NFeAutorizacao4', payloadXml);
        const response = await postSoap(url, soapAction, soapEnvelope, params.pfx, params.passphrase);

        const cStat = extractXmlTag(response.body, 'cStat') || '999';
        const xMotivo = extractXmlTag(response.body, 'xMotivo') || 'Resposta SEFAZ sem xMotivo';
        const nProt = extractXmlTag(response.body, 'nProt');
        const dhRecbto = extractXmlTag(response.body, 'dhRecbto');
        const accessKey = extractXmlTag(response.body, 'chNFe');

        return {
            cStat,
            xMotivo,
            nProt,
            dhRecbto,
            accessKey,
            rawXml: response.body,
        };
    }

    async cancelNFe(params: {
        uf: string;
        environment: FiscalEnvironment;
        signedEventXml: string;
        pfx: Buffer;
        passphrase: string;
    }): Promise<AuthorizationResult> {
        const { url, soapAction } = resolveSefazEndpoint({
            uf: params.uf,
            environment: params.environment,
            service: 'NFeRecepcaoEvento4',
        });

        // Envelopa o evento assinado no lote envEvento versao="1.00" conforme MOC 7.00 Anexo V.
        const idLote = String(Date.now()).slice(-15);
        const payloadXml =
            `<envEvento xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.00">` +
            `<idLote>${idLote}</idLote>` +
            params.signedEventXml +
            `</envEvento>`;

        const soapEnvelope = buildSoap12Envelope('NFeRecepcaoEvento4', payloadXml);
        const response = await postSoap(url, soapAction, soapEnvelope, params.pfx, params.passphrase);

        const cStat = extractXmlTag(response.body, 'cStat') || '999';
        const xMotivo = extractXmlTag(response.body, 'xMotivo') || 'Resposta SEFAZ sem xMotivo';
        const nProt = extractXmlTag(response.body, 'nProt');
        const dhRecbto = extractXmlTag(response.body, 'dhRegEvento') || extractXmlTag(response.body, 'dhRecbto');

        return {
            cStat,
            xMotivo,
            nProt,
            dhRecbto,
            rawXml: response.body,
        };
    }

    async inutilizeNumbering(params: {
        uf: string;
        environment: FiscalEnvironment;
        signedInutilizacaoXml: string;
        pfx: Buffer;
        passphrase: string;
    }): Promise<AuthorizationResult> {
        const { url, soapAction } = resolveSefazEndpoint({
            uf: params.uf,
            environment: params.environment,
            service: 'NFeInutilizacao4',
        });

        // Diferente de enviNFe/envEvento, o serviço de inutilização recebe o <inutNFe>
        // assinado diretamente dentro de nfeDadosMsg, sem envelope de lote adicional.
        const soapEnvelope = buildSoap12Envelope('NFeInutilizacao4', params.signedInutilizacaoXml);
        const response = await postSoap(url, soapAction, soapEnvelope, params.pfx, params.passphrase);

        const cStat = extractXmlTag(response.body, 'cStat') || '999';
        const xMotivo = extractXmlTag(response.body, 'xMotivo') || 'Resposta SEFAZ sem xMotivo';
        const nProt = extractXmlTag(response.body, 'nProt');
        const dhRecbto = extractXmlTag(response.body, 'dhRecbto');

        return {
            cStat,
            xMotivo,
            nProt,
            dhRecbto,
            rawXml: response.body,
        };
    }
}
