import { RuleError } from '../errors.ts';
import type { FiscalEnvironment } from './types.ts';

export type SefazService =
    | 'NFeStatusServico4'
    | 'NFeAutorizacao4'
    | 'NFeRetAutorizacao4'
    | 'NFeConsultaProtocolo4'
    | 'NFeInutilizacao4'
    | 'NFeRecepcaoEvento4';

export type SefazAuthorizer = 'SP' | 'PR' | 'RS' | 'MG' | 'MS' | 'MT' | 'GO' | 'SVRS' | 'SVAN';

const UF_TO_AUTHORIZER: Record<string, SefazAuthorizer> = {
    SP: 'SP',
    PR: 'PR',
    RS: 'RS',
    MG: 'MG',
    MS: 'MS',
    MT: 'MT',
    GO: 'GO',
    MA: 'SVAN',
    // Estados atendidos pela SVRS
    AC: 'SVRS', AL: 'SVRS', AP: 'SVRS', DF: 'SVRS', ES: 'SVRS', PB: 'SVRS',
    PI: 'SVRS', RJ: 'SVRS', RN: 'SVRS', RO: 'SVRS', RR: 'SVRS', SC: 'SVRS',
    SE: 'SVRS', TO: 'SVRS', BA: 'SVRS', PE: 'SVRS', CE: 'SVRS', AM: 'SVRS', PA: 'SVRS',
};

// Endpoints oficiais em ambiente de HOMOLOGAÇÃO (Layout 4.00 / MOC 7.00)
const HOMOLOGACAO_ENDPOINTS: Record<SefazAuthorizer, Record<SefazService, string>> = {
    SP: {
        NFeStatusServico4: 'https://homologacao.nfe.fazenda.sp.gov.br/ws/nfestatusservico4.asmx',
        NFeAutorizacao4: 'https://homologacao.nfe.fazenda.sp.gov.br/ws/nfeautorizacao4.asmx',
        NFeRetAutorizacao4: 'https://homologacao.nfe.fazenda.sp.gov.br/ws/nferetautorizacao4.asmx',
        NFeConsultaProtocolo4: 'https://homologacao.nfe.fazenda.sp.gov.br/ws/nfeconsultaprotocolo4.asmx',
        NFeInutilizacao4: 'https://homologacao.nfe.fazenda.sp.gov.br/ws/nfeinutilizacao4.asmx',
        NFeRecepcaoEvento4: 'https://homologacao.nfe.fazenda.sp.gov.br/ws/nferecepcaoevento4.asmx',
    },
    PR: {
        NFeStatusServico4: 'https://homologacao.nfe.fazenda.pr.gov.br/nfe/NFeStatusServico4',
        NFeAutorizacao4: 'https://homologacao.nfe.fazenda.pr.gov.br/nfe/NFeAutorizacao4',
        NFeRetAutorizacao4: 'https://homologacao.nfe.fazenda.pr.gov.br/nfe/NFeRetAutorizacao4',
        NFeConsultaProtocolo4: 'https://homologacao.nfe.fazenda.pr.gov.br/nfe/NFeConsultaProtocolo4',
        NFeInutilizacao4: 'https://homologacao.nfe.fazenda.pr.gov.br/nfe/NFeInutilizacao4',
        NFeRecepcaoEvento4: 'https://homologacao.nfe.fazenda.pr.gov.br/nfe/NFeRecepcaoEvento4',
    },
    RS: {
        NFeStatusServico4: 'https://nfe-homologacao.sefaz.rs.gov.br/ws/NfeStatusServico/NfeStatusServico4.asmx',
        NFeAutorizacao4: 'https://nfe-homologacao.sefaz.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx',
        NFeRetAutorizacao4: 'https://nfe-homologacao.sefaz.rs.gov.br/ws/NfeRetAutorizacao/NFeRetAutorizacao4.asmx',
        NFeConsultaProtocolo4: 'https://nfe-homologacao.sefaz.rs.gov.br/ws/NfeConsulta/NfeConsulta4.asmx',
        NFeInutilizacao4: 'https://nfe-homologacao.sefaz.rs.gov.br/ws/nfeinutilizacao/nfeinutilizacao4.asmx',
        NFeRecepcaoEvento4: 'https://nfe-homologacao.sefaz.rs.gov.br/ws/recepcaoevento/recepcaoevento4.asmx',
    },
    MG: {
        NFeStatusServico4: 'https://hnfe.fazenda.mg.gov.br/nfe2/services/NFeStatusServico4',
        NFeAutorizacao4: 'https://hnfe.fazenda.mg.gov.br/nfe2/services/NFeAutorizacao4',
        NFeRetAutorizacao4: 'https://hnfe.fazenda.mg.gov.br/nfe2/services/NFeRetAutorizacao4',
        NFeConsultaProtocolo4: 'https://hnfe.fazenda.mg.gov.br/nfe2/services/NFeConsultaProtocolo4',
        NFeInutilizacao4: 'https://hnfe.fazenda.mg.gov.br/nfe2/services/NFeInutilizacao4',
        NFeRecepcaoEvento4: 'https://hnfe.fazenda.mg.gov.br/nfe2/services/NFeRecepcaoEvento4',
    },
    MS: {
        NFeStatusServico4: 'https://hom.nfe.fazenda.ms.gov.br/ws/NFeStatusServico4',
        NFeAutorizacao4: 'https://hom.nfe.fazenda.ms.gov.br/ws/NFeAutorizacao4',
        NFeRetAutorizacao4: 'https://hom.nfe.fazenda.ms.gov.br/ws/NFeRetAutorizacao4',
        NFeConsultaProtocolo4: 'https://hom.nfe.fazenda.ms.gov.br/ws/NFeConsultaProtocolo4',
        NFeInutilizacao4: 'https://hom.nfe.fazenda.ms.gov.br/ws/NFeInutilizacao4',
        NFeRecepcaoEvento4: 'https://hom.nfe.fazenda.ms.gov.br/ws/NFeRecepcaoEvento4',
    },
    MT: {
        NFeStatusServico4: 'https://homologacao.sefaz.mt.gov.br/nfews/v2/services/NfeStatusServico4',
        NFeAutorizacao4: 'https://homologacao.sefaz.mt.gov.br/nfews/v2/services/NfeAutorizacao4',
        NFeRetAutorizacao4: 'https://homologacao.sefaz.mt.gov.br/nfews/v2/services/NfeRetAutorizacao4',
        NFeConsultaProtocolo4: 'https://homologacao.sefaz.mt.gov.br/nfews/v2/services/NfeConsulta4',
        NFeInutilizacao4: 'https://homologacao.sefaz.mt.gov.br/nfews/v2/services/NfeInutilizacao4',
        NFeRecepcaoEvento4: 'https://homologacao.sefaz.mt.gov.br/nfews/v2/services/RecepcaoEvento4',
    },
    GO: {
        NFeStatusServico4: 'https://homolog.sefaz.go.gov.br/nfe/services/NFeStatusServico4',
        NFeAutorizacao4: 'https://homolog.sefaz.go.gov.br/nfe/services/NFeAutorizacao4',
        NFeRetAutorizacao4: 'https://homolog.sefaz.go.gov.br/nfe/services/NFeRetAutorizacao4',
        NFeConsultaProtocolo4: 'https://homolog.sefaz.go.gov.br/nfe/services/NFeConsultaProtocolo4',
        NFeInutilizacao4: 'https://homolog.sefaz.go.gov.br/nfe/services/NFeInutilizacao4',
        NFeRecepcaoEvento4: 'https://homolog.sefaz.go.gov.br/nfe/services/NFeRecepcaoEvento4',
    },
    SVRS: {
        NFeStatusServico4: 'https://nfe-homologacao.svrs.rs.gov.br/ws/NfeStatusServico/NfeStatusServico4.asmx',
        NFeAutorizacao4: 'https://nfe-homologacao.svrs.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx',
        NFeRetAutorizacao4: 'https://nfe-homologacao.svrs.rs.gov.br/ws/NfeRetAutorizacao/NFeRetAutorizacao4.asmx',
        NFeConsultaProtocolo4: 'https://nfe-homologacao.svrs.rs.gov.br/ws/NfeConsulta/NfeConsulta4.asmx',
        NFeInutilizacao4: 'https://nfe-homologacao.svrs.rs.gov.br/ws/nfeinutilizacao/nfeinutilizacao4.asmx',
        NFeRecepcaoEvento4: 'https://nfe-homologacao.svrs.rs.gov.br/ws/recepcaoevento/recepcaoevento4.asmx',
    },
    SVAN: {
        NFeStatusServico4: 'https://hom.sefazvirtual.fazenda.gov.br/NFeStatusServico4/NFeStatusServico4.asmx',
        NFeAutorizacao4: 'https://hom.sefazvirtual.fazenda.gov.br/NFeAutorizacao4/NFeAutorizacao4.asmx',
        NFeRetAutorizacao4: 'https://hom.sefazvirtual.fazenda.gov.br/NFeRetAutorizacao4/NFeRetAutorizacao4.asmx',
        NFeConsultaProtocolo4: 'https://hom.sefazvirtual.fazenda.gov.br/NFeConsultaProtocolo4/NFeConsultaProtocolo4.asmx',
        NFeInutilizacao4: 'https://hom.sefazvirtual.fazenda.gov.br/NFeInutilizacao4/NFeInutilizacao4.asmx',
        NFeRecepcaoEvento4: 'https://hom.sefazvirtual.fazenda.gov.br/NFeRecepcaoEvento4/NFeRecepcaoEvento4.asmx',
    },
};

export type ResolveEndpointInput = {
    uf: string;
    environment: FiscalEnvironment;
    service: SefazService;
};

/**
 * Resolve dinamicamente o endpoint oficial do Web Service da SEFAZ
 * sem hardcode em controladores ou adivinhações.
 */
export function resolveSefazEndpoint(input: ResolveEndpointInput): {
    url: string;
    authorizer: SefazAuthorizer;
    soapAction: string;
} {
    const cleanUf = input.uf.toUpperCase();
    const authorizer = UF_TO_AUTHORIZER[cleanUf];

    if (!authorizer) {
        throw new RuleError(`UF '${input.uf}' não possui autorizador SEFAZ mapeado para NF-e.`, 400);
    }

    if (input.environment === 'producao') {
        throw new RuleError('Ambiente de produção está bloqueado nesta fase (desenvolvimento restrito à Homologação conforme instrucoes.md).', 403);
    }

    const serviceMap = HOMOLOGACAO_ENDPOINTS[authorizer];
    const url = serviceMap[input.service];

    if (!url) {
        throw new RuleError(`Serviço '${input.service}' não encontrado para o autorizador '${authorizer}'.`, 404);
    }

    const soapAction = `http://www.portalfiscal.inf.br/nfe/wsdl/${input.service}`;

    return { url, authorizer, soapAction };
}
