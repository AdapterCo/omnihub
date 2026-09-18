# Fontes Oficiais da Legislação e Tecnologia Fiscal (NF-e 55)

Este documento registra os documentos normativos, manuais, notas técnicas e schemas oficiais primários vigentes que regem a implementação do emissor próprio de NF-e (modelo 55) no OmniHub, em estrita observância à seção §3 da especificação da Fase 5 e a `instrucoes.md` (§75, §76, §77, §79).

---

## 1. Manuais de Orientação do Contribuinte (MOC)

| Documento | Versão | Data / Vigência | URL Oficial | Finalidade |
| :--- | :--- | :--- | :--- | :--- |
| **MOC - Visão Geral** | 7.00 | Consolidado | [Portal NF-e - MOC](http://www.nfe.fazenda.gov.br/portal/listaConteudo.aspx?tipoConteudo=3/r3eMSc+kU=) | Visão geral da arquitetura do SPED / NF-e, princípios, modelos e papéis do contribuinte e do Fisco. |
| **MOC - Anexo I (Leiaute e Regras de Validação)** | 7.00 + NTs | Consolidado | [Portal NF-e - Leiaute](http://www.nfe.fazenda.gov.br/portal/listaConteudo.aspx?tipoConteudo=3/r3eMSc+kU=) | Especificação detalhada da tag `<infNFe>`, cardinalidade de nós, formatos de campos, grupos de tributação e regras de rejeição (cStat). |
| **MOC - Anexo II (Manual de Comunicação)** | 7.00 | Consolidado | [Portal NF-e - Comunicação](http://www.nfe.fazenda.gov.br/portal/listaConteudo.aspx?tipoConteudo=3/r3eMSc+kU=) | Padrões de comunicação SOAP 1.2 sobre HTTPS/TLS 1.2, autenticação mTLS ICP-Brasil com certificado digital A1 (X.509) e assinatura digital W3C XMLDSIG (C14N, Digest SHA-1, Assinatura RSA-SHA1). |

---

## 2. Schemas XSD Oficiais

| Documento | Versão / Pacote | Data | URL Oficial | Finalidade |
| :--- | :--- | :--- | :--- | :--- |
| **Pacote de Schemas XML da NF-e** | PL_009k (v4.00) | Vigente | [Portal NF-e - Schemas](http://www.nfe.fazenda.gov.br/portal/schemas.aspx) | Schemas de validação sintática estrita: `consStatServ_v4.00.xsd`, `enviNFe_v4.00.xsd`, `retEnviNFe_v4.00.xsd`, `nfe_v4.00.xsd`, `procNFe_v4.00.xsd`. |

---

## 3. Notas Técnicas Oficiais Vigentes Relevantes (2024–2026)

| Nota Técnica | Versão | Data | URL Oficial | Finalidade |
| :--- | :--- | :--- | :--- | :--- |
| **NT 2025.002 / NT 2026.001 (Reforma Tributária)** | 1.00 / 1.10 | 2025 / 2026 | [Portal NF-e - Notas Técnicas](http://www.nfe.fazenda.gov.br/portal/listaConteudo.aspx?tipoConteudo=YOD%20Kauai/NotaTecnica) | Estruturação dos grupos de IBS e CBS (`<IBS>`, `<CBS>`), novos campos e validações de transição da Emenda Constitucional 132/2023. |
| **NT 2024.001 (CNPJ Alfanumérico)** | 1.00 | 2024/2025 | [Portal NF-e - Notas Técnicas](http://www.nfe.fazenda.gov.br/portal/listaConteudo.aspx?tipoConteudo=YOD%20Kauai/NotaTecnica) | Adaptação para o formato alfanumérico do CNPJ definido pela Receita Federal do Brasil. |
| **NT 2020.006 (Intermediador da Operação)** | 1.40 | Vigente | [Portal NF-e - Notas Técnicas](http://www.nfe.fazenda.gov.br/portal/listaConteudo.aspx?tipoConteudo=YOD%20Kauai/NotaTecnica) | Tratamento do campo `indIntermed` e grupo `infIntermed` para operações comerciais presenciais e online. |
| **NT 2019.001 (Regras de Validação Gerais)** | 1.62 | Vigente | [Portal NF-e - Notas Técnicas](http://www.nfe.fazenda.gov.br/portal/listaConteudo.aspx?tipoConteudo=YOD%20Kauai/NotaTecnica) | Regras de validação de NCM, rateio de frete/desconto e rejeições 100/104/105/etc. |

---

## 4. Relação Oficial de Web Services e Autorizadores

| Autorizador / SEFAZ | Tipo | Abrangência de UFs | URL de Consulta Oficial |
| :--- | :--- | :--- | :--- |
| **SEFAZ Virtual do Rio Grande do Sul (SVRS)** | Autorizador Virtual | AC, AL, AP, DF, ES, PB, PI, RJ, RN, RO, RR, SC, SE, TO, BA, PE, CE, AM, PA | [WebServices SEFAZ](http://www.nfe.fazenda.gov.br/portal/webServices.aspx) |
| **SEFAZ Virtual do Ambiente Nacional (SVAN)** | Autorizador Virtual | MA | [WebServices SEFAZ](http://www.nfe.fazenda.gov.br/portal/webServices.aspx) |
| **SEFAZ SP** | SEFAZ Própria | SP | [WebServices SEFAZ SP](https://homologacao.nfe.fazenda.sp.gov.br/ws/) |
| **SEFAZ PR** | SEFAZ Própria | PR | [WebServices SEFAZ PR](https://homologacao.nfe.fazenda.pr.gov.br/nfe/) |
| **SEFAZ RS** | SEFAZ Própria | RS | [WebServices SEFAZ RS](https://nfe-homologacao.sefaz.rs.gov.br/ws/) |
| **SEFAZ MG** | SEFAZ Própria | MG | [WebServices SEFAZ MG](https://hnfe.fazenda.mg.gov.br/nfe2/) |
| **SEFAZ MS** | SEFAZ Própria | MS | [WebServices SEFAZ MS](https://hom.nfe.ms.gov.br/ws/) |
| **SEFAZ MT** | SEFAZ Própria | MT | [WebServices SEFAZ MT](https://homologacao.sefaz.mt.gov.br/nfews/v2/services/) |
| **SEFAZ GO** | SEFAZ Própria | GO | [WebServices SEFAZ GO](https://homolog.sefaz.go.gov.br/nfe/services/) |

---

## 5. Regra de Derivação e Rastreabilidade

Toda e qualquer tag XML, enum, regra de validação, alíquota de cálculo ou cabeçalho SOAP implementado no código do OmniHub deve ter sua origem fundamentada em um dos documentos listados nesta tabela. Não é admitido uso de regras presumidas, estimadas ou copiadas de fontes não oficiais.
