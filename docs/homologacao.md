# Roteiro de homologação fiscal (NF-e 55 e NFC-e 65)

Objetivo: no dia em que o certificado A1 chegar, sobrar só o que depende da SEFAZ. Tudo o que
pode ser feito antes está nas partes 1 e 2. Ambiente: **somente homologação** (produção está
bloqueada no código — liberar exige alteração consciente depois da homologação aprovada).

## 1. Antes do certificado (sem SEFAZ)

| # | O quê | Quem | Situação |
|---|---|---|---|
| 1.1 | Comprar o **e-CNPJ A1** da empresa emissora (arquivo .pfx + senha) em uma autoridade certificadora ICP-Brasil | Empresa | Pendente |
| 1.2 | **Credenciar** a empresa como emissora de NF-e e de NFC-e na SEFAZ da UF da loja (em SP, pelo Posto Fiscal Eletrônico) | Contador | Pendente |
| 1.3 | Gerar o **CSC de homologação** da NFC-e (código + identificador) no portal da SEFAZ | Contador / empresa | Pendente |
| 1.4 | Obter a **URL oficial de consulta do QR Code** da NFC-e em homologação da UF | Contador / empresa | Pendente |
| 1.5 | Confirmar com o contador: **regime (CRT)**, **natureza da operação**, e por produto **NCM, CFOP, CST/CSOSN, origem e CEST** | Contador | Pendente |
| 1.6 | Conferir o cadastro da loja: razão social, CNPJ, IE, endereço completo **com número** (ou "SN"), bairro, CEP, cidade, código IBGE do município e UF | Empresa | Pendente |
| 1.7 | Gerar XMLs de exemplo (`node scripts/homologacao/gerar-exemplos.ts <pasta>`) e passar em validador externo | OmniHub | Feito em 2026-09-28 — 5 defeitos corrigidos, 4 dependem de decisão (parte 5) |

**Bloqueante já identificado (corrigir antes do teste da NFC-e):** o envio para a SEFAZ usa o
mesmo endereço para NF-e e NFC-e (`lib/fiscal/endpoints.ts` não separa o modelo). Em várias
UFs, inclusive SP, a NFC-e tem servidores próprios. Os endereços oficiais da NFC-e da UF da
loja precisam ser conferidos no portal da SEFAZ e cadastrados antes do teste 3.6.

## 2. No OmniHub, com o certificado em mãos

1. **Minhas lojas > Configuração fiscal**: escolher o regime (CRT), informar a série e a natureza da operação e **Salvar Parâmetros**.
2. Na mesma janela, **Carregar Certificado A1** (.pfx + senha). Esperado: validade e CNPJ do certificado exibidos; o CNPJ precisa ser o da loja.
3. **Configuração NFC-e**: série, CRT, natureza, CSC + identificador (1.3) e URL do QR Code (1.4).
4. Produtos de teste com NCM, CFOP, CST/CSOSN e origem informados pelo contador (1.5) e unidade preenchida.
5. Abrir um caixa na loja.

## 3. Testes na SEFAZ (homologação), nesta ordem

Registrar para cada teste: data/hora, chave de acesso, cStat e xMotivo devolvidos.

| # | Teste | Como | Esperado |
|---|---|---|---|
| 3.1 | Status do serviço | Configuração fiscal > testar comunicação | cStat **107** (serviço em operação). Falha de conexão: cadeia ICP-Brasil ou certificado |
| 3.2 | NF-e simples | Venda no PDV com CPF e nome do cliente, Pix; Vendas > Gerar NF-e > Transmitir | cStat **100** (autorizada); DANFE abre |
| 3.3 | NF-e com desconto | Venda com desconto no total, 2 itens | cStat 100; `vDesc` por item e `vNF` = produtos − desconto |
| 3.4 | NF-e com cartão de crédito e de débito | Uma venda com cada | cStat 100; `tPag` 03 e 04 |
| 3.5 | NF-e de pedido pela internet | Pedido de venda com "Pela internet / WhatsApp", cliente da mesma UF da loja | cStat 100; `indPres` 2 |
| 3.6 | NFC-e sem CPF | Venda no PDV sem cliente; Gerar NFC-e > Transmitir | cStat 100; QR Code do DANFE abre a consulta da SEFAZ |
| 3.7 | NFC-e com CPF e nome | Venda com CPF e nome | cStat 100; CPF no QR Code |
| 3.8 | NFC-e com cartão | Venda com cartão de débito | cStat 100. **Se rejeitar pedindo o grupo `card`**, anotar o cStat (dúvida 4.2) |
| 3.9 | Cancelamento de NF-e | Cancelar a NF-e de 3.2 com justificativa de 15+ caracteres | cStat **135** (evento registrado); status "Cancelada" |
| 3.10 | Cancelamento de NFC-e | Cancelar a NFC-e de 3.6 | cStat 135 |
| 3.11 | Inutilização | Inutilizar uma faixa não usada da série da NF-e | cStat **102** (inutilização homologada) |
| 3.12 | Rejeição proposital | Produto com NCM inexistente (ex.: 99999999) | Rejeição da SEFAZ; documento fica "Rejeitado" e **nunca** vira autorizado |
| 3.13 | Falha de rede | Desligar a internet durante a transmissão | Documento fica "Assinado" (retomável) e vai para a fila; ao voltar, autoriza uma única vez |

## 4. Dúvidas a confirmar durante a homologação

1. **Envelopes SOAP** (`NFeAutorizacao4`, `NFeRecepcaoEvento4`, `NFeInutilizacao4`): montados conforme o MOC 7.00, nunca testados contra a SEFAZ real. Os testes 3.2, 3.9 e 3.11 confirmam.
2. ~~Grupo `card` na NFC-e~~ **respondido pelo validador (parte 5): é exigido para cartão e Pix na NFC-e**; falta decidir o tipo de integração.
3. **NFC-e com CPF sem nome**: hoje o OmniHub exige o nome. Se a SEFAZ aceitar só o CPF, dá para afrouxar.
4. **cStat de sucesso adotados**: 135 (cancelamento) e 102 (inutilização) — confirmar nos testes 3.9 e 3.11.
5. **Hash do QR Code (NT 2015.002)**: confirmar abrindo o QR Code do teste 3.6 na consulta da SEFAZ.
6. **`indFinal` = 1 e `indIEDest` = 9 fixos**: corretos para venda a consumidor. Venda a empresa contribuinte de ICMS precisa de decisão antes da produção.
7. **Endereços da NFC-e** (bloqueante da parte 1).

## 5. Validação externa dos XMLs de exemplo (item 1.7)

Cenários gerados por `scripts/homologacao/gerar-exemplos.ts` (dados fictícios: CNPJ 11.222.333/0001-81,
IE 110.042.490.114, CPF 529.982.247-25; certificado autoassinado, que nenhum validador reconhece
como ICP-Brasil — erro de cadeia do certificado é esperado e não indica defeito do XML):

| Arquivo | Modelo | Cenário |
|---|---|---|
| A-nfe55-presencial-pix-desconto | 55 | presencial, 2 itens com desconto, Pix, com CPF |
| B-nfe55-internet-cartao-credito | 55 | internet (`indPres` 2), cartão de crédito |
| C-nfe55-entrega-dinheiro-e-debito | 55 | entrega (`indPres` 4), dinheiro + débito |
| D-nfce65-presencial-debito-sem-cpf | 65 | presencial, débito, sem destinatário |
| E-nfce65-entrega-pix-com-cpf | 65 | entrega, Pix, com CPF |

### Resultado (2026-09-28, validador oficial da SVRS — sefaz.rs.gov.br/NFE/NFE-VAL.aspx)

- **Parser e schema XML: sem erros** nos modelos 55 e 65 (depois das correções abaixo).
- **Assinatura digital: Válida** — o cálculo da assinatura (canonicalização, digest, RSA-SHA1) do OmniHub confere com o da SEFAZ.
- Apontamentos **esperados** com dados fictícios (não são defeito): 290, 295, 296 (certificado autoassinado, fora da ICP-Brasil), 213 (CNPJ do certificado de teste), 245 (CNPJ fictício não cadastrado), 410 (o validador é do RS e o exemplo é de SP).

**Defeitos encontrados e já corrigidos:**

| cStat | O que era | Correção |
|---|---|---|
| 225 | NFC-e sem `idDest` (o código dizia que não existia no modelo 65) | `idDest` sai nos dois modelos |
| 225 | QR Code com identificador do CSC com zeros à esquerda (`000001`) | enviado sem os zeros (`1`) |
| 225 | QR Code com o CPF do consumidor (formato antigo) | a versão 2 não leva CPF; ele fica só no `<dest>` |
| 225 | NFC-e sem `urlChave` | novo campo obrigatório "URL de consulta pela chave" em Configuração NFC-e |
| 373 | 1º item da NFC-e em homologação sem o texto obrigatório | em homologação, a descrição do 1º item é "NOTA FISCAL EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL" |

**Defeitos encontrados que dependem de decisão (a NOTA SERÁ REJEITADA até resolver):**

| cStat | Regra | Onde | Decisão necessária |
|---|---|---|---|
| 726 | NF-e sem endereço do destinatário | toda NF-e | de onde vem o endereço do cliente numa venda do PDV (hoje a venda guarda só nome e CPF) |
| 788 | NFC-e de entrega em domicílio sem endereço do destinatário | NFC-e com "Entrega em domicílio" | idem (o pedido já tem o cliente cadastrado) |
| 434 | Falta o indicativo de intermediador (`indIntermed`) | venda não presencial (internet/entrega), NF-e e NFC-e | perguntar no pedido se a venda foi por plataforma de terceiros (marketplace) |
| 391 | Falta o grupo de dados do pagamento (`card`) | NFC-e paga com cartão de crédito, débito **ou Pix** | tipo de integração: maquininha avulsa (não integrada) ou integrada (Mercado Pago, exige CNPJ da credenciadora, bandeira e autorização) |

A NF-e (modelo 55) com cartão **não** exige o grupo `card` (não apareceu no validador).
