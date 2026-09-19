# OmniHub — Progresso do projeto (Fases 1–5 Concluídas)
Atualizado em 17 de setembro de 2026

## Contexto
O OmniHub é um sistema de vendas/PDV, gestão de lojas, estoque, caixa e emissão fiscal, sendo construído como SaaS multiempresa/multiloja. A especificação funcional e arquitetural de referência é [instrucoes.md](instrucoes.md) (79 seções), na raiz do repositório — qualquer trabalho futuro deve reler as seções aplicáveis antes de implementar algo novo.

O repositório é um app Next.js/Vinext + React, publicado no Cloudflare Workers com banco Cloudflare D1 (SQLite) e Drizzle ORM para schema/migrações. Não existe outro serviço de backend — tudo roda em `app/api/workspace/route.ts`.

Princípio de execução (§74/§75 de `instrucoes.md`): nada é implementado de uma vez. O trabalho é dividido em fases (Fundação SaaS → Catálogo/Estoque → PDV/Caixa → Fundação fiscal → NF-e → NFC-e → Escala → NFS-e futura), cada uma cortada (*cutover*) para produção só depois de testada. As Fases 1 a 4 estão implementadas e validadas por testes automatizados.

---

## Fase 1 — RBAC e Gestão de Usuários (Implementada e Validada)
- **Permissões e Papéis:** Catálogo de 24 permissões em `lib/authz/permissions.ts` e 6 papéis de sistema (`OWNER`, `ADMIN`, `GERENTE`, `OPERADOR_CAIXA`, `ESTOQUISTA`, `CONSULTA`) em `lib/authz/roles.ts` conforme §4.
- **Serviço de Usuários:** `lib/users/service.ts` com `listTenantUsers`, `assignTenantUser` e `removeTenantUser`. Sincroniza tabelas relacionais (`users`, `user_tenant_roles`, `user_stores`) e mantém compatibilidade com `memberships`.
- **Frontend:** Aba **Equipe** em `app/workspace.tsx` permitindo listar membros, visualizar papéis e lojas atribuídas, além de modal para atribuir novos membros (`user.assign`) e remoção (`user.remove`).
- **Validação:** `tests/authz.test.ts` e `tests/users.test.ts`.

---

## Fase 2 — Catálogo/Estoque Relacional (Implementada e Validada)
- **Tabelas:** `stores`, `categories`, `products`, `product_fiscal_profiles` (§8), `inventories`, `stock_movements` (ledger completo, §6), `stock_transfers` e `stock_transfer_items` (§7).
- **Garantia de concorrência:** Ajuste de estoque com `UPDATE ... RETURNING` e constraint `CHECK (quantity >= 0)` em SQLite/D1, impossibilitando saldo negativo mesmo sob requisições concorrentes disputando a última unidade (§65).
- **Transferências:** Máquina de estados completa (`transit`, `received`, `cancelled`).
- **Frontend:** Catálogo com dados fiscais preparatórios, controle de estoque por loja, visualização de transferências em trânsito/recebidas/canceladas, com ações de confirmação (`transfer.receive`) e cancelamento (`transfer.cancel`).
- **Validação:** `tests/catalog.test.ts`, `tests/inventory.test.ts`.

---

## Fase 3 — PDV/Caixa Relacional (Implementada e Validada)
- **Tabelas:** `cash_registers`, `cash_sessions`, `cash_movements` (§15), `sales`, `sale_items`, `sale_payments`, `non_fiscal_receipts` (§12).
- **Caixa:** Abertura, fechamento cego com cálculo do valor esperado no servidor, suprimento e sangria.
- **Venda e Pagamentos:** Criação atômica via `db.batch()` (venda + itens + pagamentos + baixa de estoque no mesmo lote). Suporte a pagamento misto (§13) com múltiplas formas e valores, cancelamento de venda com devolução atômica de estoque.
- **Frontend:**
  - **Frente de caixa:** Seleção de produtos, adição de múltiplas linhas de pagamento (Dinheiro, Pix, Cartão), identificação opcional de cliente e documento.
  - **Caixas:** Registro de abertura, suprimento, sangria e fechamento com exibição de data e diferença.
  - **Vendas:** Histórico de vendas, emissão/impressão de comprovante não fiscal e cancelamento de venda (`sale.cancel`) com estorno de estoque.
- **Validação:** `tests/cash.test.ts`, `tests/sales.test.ts`, `tests/relationalCommands.test.ts`.

---

## Fase 4 — Fundação Fiscal Direta (Implementada e Validada)
- **Definição Aprovada:** Integração direta com os Web Services oficiais da SEFAZ, sem gateways intermediários (Focus NFe, Nuvem Fiscal, TecnoSpeed, PlugNotas).
- **Migração:** `drizzle/0006_fiscal_foundation.sql` com tabelas `fiscal_configurations`, `fiscal_certificates`, `fiscal_sequences`, `fiscal_documents`, `fiscal_events`, `fiscal_audit_logs`.
- **Serviço de Numeração (`lib/fiscal/sequence.ts`):** Numeração estritamente atômica e sequencial por loja, modelo ('55') e série.
- **Chave de Acesso Oficial (`lib/fiscal/keys.ts`):** Composição de 44 dígitos com cálculo do dígito verificador via Módulo 11 (pesos de 2 a 9) conforme MOC 7.00.
- **CertificateService (`lib/fiscal/certificate.ts`):** Criptografia em repouso com AES-256-GCM, parse estrito de PKCS#12 A1 em memória, validação de validade e CNPJ do titular. Chaves privadas nunca são expostas na API ou em texto plano.
- **NFeBuilder (`lib/fiscal/builder.ts`):** Construtor de XML no Layout 4.00 oficial (MOC 7.00) com grupos ide, emit, dest, det (imposto ICMS/PIS/COFINS), total, transp e pag. Suporte modular preparatório para a Reforma Tributária 2026 (grupos `<IBS>` e `<CBS>`).
- **XmlSigner (`lib/fiscal/signer.ts`):** Assinador digital no padrão W3C XMLDSIG (Canonicalização C14N sem comentários, Digest SHA-1 sobre `<infNFe>`, assinatura RSA-SHA1 com chave privada A1 e inclusão da tag `<Signature>`).
- **FiscalEndpointResolver (`lib/fiscal/endpoints.ts`):** Resolução dinâmica de Web Services oficiais da SEFAZ em Homologação por UF (SP, PR, RS, MG, MS, MT, GO, SVRS, SVAN), com bloqueio estrito de ambiente de produção nesta fase.
- **SefazDirectGateway (`lib/fiscal/gateway.ts`):** Implementação oficial da interface `FiscalGateway` realizando comunicação direta via SOAP 1.2 sobre HTTPS/TLS 1.2 com mTLS do certificado A1.
- **Validação:** `tests/fiscal.direct.test.ts`.

---

## Módulo Relacional — Clientes e Fornecedores (Implementado e Validado)
- **Migração:** `drizzle/0007_customers_suppliers.sql` com tabelas `customers` e `suppliers` (§1, §2, §23, §24).
- **Isolamento Multi-Tenant:** Cada registro possui `tenant_id` e chave única `(tenant_id, document)`. Clientes e fornecedores de um tenant nunca são visíveis ou alteráveis por outro tenant.
- **Controle de Acesso RBAC:** 6 novas permissões granulares (`CUSTOMER_VIEW`, `CUSTOMER_CREATE`, `CUSTOMER_EDIT`, `SUPPLIER_VIEW`, `SUPPLIER_CREATE`, `SUPPLIER_EDIT`). `OPERADOR_CAIXA` possui permissão de visualização e criação de clientes para permitir agilidade no PDV.
- **Serviço e Schemas (`lib/customers/service.ts`):**
  - Schemas com Zod e pré-processamento de limpeza de dígitos e uppercase de UF.
  - CRUD completo com suporte a atualizações parciais (`customerUpdateInputSchema`, `supplierUpdateInputSchema`).
- **Frontend (`app/workspace.tsx`):**
  - Navegação e páginas dedicadas para **Clientes** e **Fornecedores** com busca em tempo real, visualização tabular e formulários modais de cadastro/edição.
  - **Frente de caixa:** Autocompleção com seleção rápida de clientes cadastrados via `datalist`, preenchendo automaticamente o nome e documento (CPF/CNPJ).
- **Validação:** `tests/customers.suppliers.test.ts`.

---

## Fase 5 — Primeira Emissão Real de NF-e em Homologação (Em Progresso)

### Marco 1: Status do Serviço SEFAZ em Homologação (Implementado e Validado)
- **Fontes Oficiais Registradas:** `docs/fiscal/official-sources.md` documentando MOC 7.00, Schemas PL_009k, NTs 2019-2026 e URLs oficiais dos Web Services da SEFAZ em Homologação.
- **Configuração Fiscal da Loja (`lib/fiscal/service.ts`):** Gestão de série (1 a 999), CRT (`1_SIMPLES_NACIONAL`, `2_SIMPLES_EXCESSO`, `3_REGIME_NORMAL`), modelo fixo '55' e ambiente estritamente fixado em `'homologacao'` (produção travada em código: `resolveSefazEndpoint`, em `lib/fiscal/endpoints.ts`, lança `RuleError` sempre que `environment === 'producao'` — não existe variável de ambiente `FISCAL_PRODUCTION_ENABLED` no código; essa referência estava incorreta e foi corrigida aqui em 17/09).
- **Upload Seguro de Certificado A1:** Transmissão via HTTPS, validação de integridade e titular em memória com `node-forge`, criptografia em repouso com **AES-256-GCM** em `fiscal_certificates`. Senha e chave privada em texto plano nunca são expostas na API, em logs ou salvas no banco.
- **Conectividade Direta SEFAZ (`NFeStatusServico4`):** Resolução automática do autorizador estadual conforme a UF da loja (ex: SP, PR, RS, MG, SVRS, SVAN), comunicação direta mTLS/SOAP 1.2 sem intermediários, medição de tempo de resposta em milissegundos e registro de auditoria em `fiscal_audit_logs`.
- **Frontend (`app/workspace.tsx`):**
  - Card da loja em *Minhas lojas* exibindo badges de ambiente (`NF-e 55: Homologação`) e status do certificado (`OK`, `Expirando`, `Expirado` ou `Sem certificado`).
  - Painel modal de **Configuração fiscal** com:
    - Parâmetros da NF-e (CRT e Série).
    - Gestão de Certificado A1 (resumo com CNPJ do titular, fingerprint SHA-1, validade e formulário de upload seguro de arquivo `.pfx`/`.p12` e senha).
    - Botão de ação `[ Testar Comunicação com SEFAZ ]` com feedback em tempo real e cartão detalhado com cStat, xMotivo, tempo de resposta e carimbo de data/hora do Fisco.
- **Validação:** `tests/fiscal.connectivity.test.ts`.

### Marco 2: Geração de NF-e a Partir de Venda e Validação Formal de Schema (Implementado e Validado)
- **Validador de Schema XSD (`lib/fiscal/validator.ts`):** Validação estrutural e sintática em conformidade estrita com o pacote oficial SEFAZ **PL_009k** e MOC 7.00. Verifica elemento raiz `<NFe>` e namespace oficial, chave de 44 dígitos no atributo `Id` com verificação de DV Módulo 11, campos ide, emit, dest, det (produtos, NCM 8 dígitos, CFOP 4 dígitos, tributação), conciliação matemática exata de totais (`vProd` e `vNF`), transporte e pagamentos.
- **Geração de NF-e (`lib/fiscal/service.ts` -> `generateNFeForSale`):**
  - Vinculação direta com a venda cadastrada no banco.
  - Bloqueio de vendas canceladas ou que já possuam documento fiscal ativo emitido ou gerado.
  - Verificação de campos obrigatórios da loja (CNPJ 14 dígitos, IE, UF, endereço, município IBGE) e produtos (NCM de 8 dígitos) sem preenchimento por suposição.
  - Atribuição sequencial e atômica de número fiscal por loja e série via `getNextFiscalNumber`.
  - Construção do XML Layout 4.00 com `buildNFeXml`, geração de chave de acesso de 44 dígitos com DV Módulo 11 e validação contra o schema SEFAZ via `validateNFeXmlSchema`.
  - Persistência em `fiscal_documents` com status `'GENERATED'` e `raw_xml`.
- **Comando Relacional e Snapshot:**
  - Adição do comando `fiscal.nfe.generate` com auditoria e controle de acesso RBAC (`FISCAL_ISSUE`).
  - Carregamento de documentos fiscais por `saleId` no snapshot via `listFiscalDocumentsForSnapshot`.
- **Frontend (`app/workspace.tsx`):**
  - Tabela de **Vendas** com coluna fiscal atualizada: exibe badge `NF-e: S.{série} Nº{número}` e botão `[ Ver NF-e ]` para notas geradas, ou badge `Pendente` com botão `[ Gerar NF-e ]` para notas ainda não emitidas.
  - Modal interativo de visualização de NF-e gerada: exibição formatada da chave de acesso de 44 dígitos com botão para copiar, badges de status e schema XSD SEFAZ válido, resumo dos dados (série, número, data de emissão) e prévia do código XML com botão para baixar o arquivo `.xml`.
- **Validação:** `tests/fiscal.nfe-generation.test.ts` (11 testes: os 9 originais mais duas rejeições adicionadas na auditoria de 17/09 — CFOP ausente e loja sem configuração fiscal salva, ver abaixo).

---

## Fase 5 — Marco 3: Assinatura Digital e Transmissão em Homologação (Implementado e Validado, com uma ressalva)

- **Assinatura + transmissão (`lib/fiscal/service.ts` → `transmitNFe`):** assina o XML já gerado (Marco 2) via `signNFeXml` (XMLDSIG), transmite via `FiscalGateway.authorizeNFe` (envelope síncrono `enviNFe indSinc="1"`), interpreta `cStat` da resposta (100 = autorizado; qualquer outro valor = rejeitado — **nunca vira autorização automática**, §27) e persiste em `fiscal_documents`/`fiscal_events`/`fiscal_audit_logs`.
- **Comando relacional:** `fiscal.nfe.transmit`, permissão `FISCAL_ISSUE`.
- **Falha de comunicação:** o documento volta para o status `SIGNED` (retomável) em vez de travar em `TRANSMITTING` ou autorizar sozinho; permite nova tentativa sem duplicar o documento (§31/§41).
- **Validação:** `tests/fiscal.transmission.test.ts` (7 testes) usando um `FiscalGateway` **mock explicitamente identificado como tal no código** (autorização, rejeição, falha de comunicação com retentativa, bloqueio de retransmissão de documento já autorizado, bloqueio sem NF-e gerada, controle de permissão, roteamento via `dispatchCommand`).
- **Ressalva registrada, não escondida:** a estrutura exata do envelope SOAP (`enviNFe`/`nfeAutorizacao4`) e o mapeamento completo de códigos `cStat` **não foram reverificados contra uma fonte oficial ao vivo** nesta sessão — o Portal Nacional da NF-e devolveu um loop de redirecionamento a partir deste ambiente, e o endpoint real de homologação da SEFAZ exige uma cadeia de certificação ICP-Brasil que este ambiente não possui (`unable to get local issuer certificate`). Os testes com mock validam a integração interna (assinatura → transmissão → interpretação de resposta → persistência), não a comunicação real contra a SEFAZ. **Antes de qualquer emissão real**, confirmar a estrutura do envelope contra o MOC 7.00 Anexo II com um certificado A1 de teste de verdade, num ambiente com a cadeia ICP-Brasil confiável.

---

## Fase 6 — DANFE (§22, Implementado e Validado)

- **Geração de DANFE (`lib/fiscal/danfe.ts` → `buildDanfeHtml`, `lib/fiscal/service.ts` → `getDanfeData`):** monta uma representação HTML do DANFE modelo 55 **exclusivamente a partir de um `fiscal_documents` com status `AUTHORIZED`** — bloqueia (`RuleError`) para qualquer outro status, inclusive `GENERATED`/`SIGNED`/`REJECTED` (§22: "somente a partir dos dados fiscais válidos/autorizados"). Inclui chave de acesso formatada em grupos de 4, protocolo de autorização, dados do emitente/destinatário, itens (código, NCM, CFOP, unidade, quantidade, valores) e formas de pagamento. **Nunca inclui QR Code** — QR Code é exclusivo do DANFE de NFC-e (modelo 65, §20), que ainda não foi implementado (Fase 7).
- **Rota:** `GET /api/workspace?danfe=<saleId>` retorna o HTML diretamente (`Content-Type: text/html`), reaproveitando a mesma checagem de permissão (`FISCAL_VIEW`) e isolamento por tenant já usados no resto do módulo fiscal.
- **Validação:** `tests/fiscal.danfe.test.ts` (5 testes: bloqueio sem NF-e gerada, bloqueio para NF-e não autorizada, checagem de permissão, geração completa com dados corretos, isolamento entre tenants).
- **Pendência:** não há botão na tela de Vendas do frontend para abrir essa rota ainda — backend pronto e testado, falta a UI.

---

## Fase 6 — Cancelamento Fiscal (§29, Implementado e Validado, com a mesma ressalva do Marco 3)

- **Evento de Cancelamento (`lib/fiscal/events.ts` → `buildCancellationEventXml`):** monta o XML `<evento>`/`<infEvento>` do evento `110111` (Cancelamento) validando CNPJ (14 dígitos), chave de acesso (44 dígitos), justificativa (mínimo 15 caracteres, exigido pela SEFAZ) e presença do número de protocolo de autorização — bloqueia (`RuleError`) em vez de aceitar dado incompleto.
- **Assinatura do Evento (`lib/fiscal/signer.ts` → `signEventXml`):** generaliza a mesma rotina XMLDSIG (C14N, Digest SHA-1, RSA-SHA1) já usada para `<infNFe>`, agora assinando o nó `<infEvento Id="...">` e inserindo `<Signature>` antes de `</evento>`.
- **Transmissão (`lib/fiscal/gateway.ts` → `FiscalGateway.cancelNFe`, `SefazDirectGateway`):** envelopa o evento assinado em `envEvento versao="1.00"` e transmite via SOAP 1.2/mTLS ao endpoint `NFeRecepcaoEvento4` (já resolvido por UF em `lib/fiscal/endpoints.ts`).
- **Orquestração (`lib/fiscal/service.ts` → `cancelNFeDocument`):**
  - Exige permissão `FISCAL_CANCEL` (só OWNER/ADMIN, conforme `lib/authz/roles.ts` — GERENTE e OPERADOR_CAIXA não têm).
  - Só cancela documento com status `AUTHORIZED` e com protocolo de autorização gravado; bloqueia se já `CANCELLED` ou se nunca foi autorizado.
  - Interpreta `cStat` da resposta: **135** = cancelado (grava `fiscal_documents.status = 'CANCELLED'` + `cancelled_at`, e `FiscalEvent(type='CANCELLATION')`); qualquer outro `cStat` = rejeição, grava `FiscalEvent(type='CANCELLATION_REJECTED')` e **nunca cancela sozinho** (mesmo princípio do §27 aplicado à autorização); falha de comunicação grava `FiscalEvent(type='CANCELLATION_ERROR')`, mantém o documento `AUTHORIZED` (retomável) e relança o erro — nunca duplica o documento numa nova tentativa (`nSeqEvento` incrementa por tentativa registrada).
  - **Nunca executa `DELETE`** em `fiscal_documents` — exatamente como pedido pelo §29.
- **Coordenação com a venda (`lib/sales/service.ts` → `cancelSale`):** agora bloqueia (`RuleError`) o cancelamento comercial de uma venda enquanto sua NF-e estiver `AUTHORIZED` — força a ordem correta: cancelar a NF-e primeiro (via `fiscal.nfe.cancel`), só depois a venda pode ser cancelada comercialmente (com reversão de estoque).
- **Comando relacional:** `fiscal.nfe.cancel` (`saleId` + `justification`, mínimo 15 caracteres), permissão `FISCAL_CANCEL`.
- **Validação:** `tests/fiscal.cancellation.test.ts` (10 testes): bloqueio sem NF-e gerada, bloqueio se não `AUTHORIZED`, checagem de permissão (`FISCAL_CANCEL` distinto de `FISCAL_ISSUE`/`SALE_CANCEL`), justificativa curta, cancelamento bem-sucedido com evento gravado e nunca-DELETE, rejeição da SEFAZ não cancela sozinho, falha de rede não cancela sozinho e permite retentativa, bloqueio de cancelamento repetido, guard de `cancelSale` e roteamento do comando.
- **Ressalva idêntica à do Marco 3, registrada e não escondida:** a estrutura exata do envelope SOAP `NFeRecepcaoEvento4`/`envEvento` e o `cStat` de sucesso adotado (135, "Evento registrado e vinculado a NF-e" — valor padrão amplamente documentado, mas não reverificado contra fonte oficial ao vivo nesta sessão) precisam ser confirmados contra o MOC 7.00 Anexo V com certificado A1 de teste de verdade, num ambiente com cadeia ICP-Brasil confiável, antes de qualquer cancelamento real.

---

## Fase 6 — Inutilização de Numeração (§25, Implementado e Validado — Fase 6 concluída)

- **Migração:** `drizzle/0008_fiscal_inutilizacao.sql` com a tabela `fiscal_inutilizations` (`tenant_id`, `store_id`, `environment`, `model`, `series`, `year`, `number_start`, `number_end`, `justification`, `status`, `cstat`, `xmotivo`, `protocol_number`, `raw_xml`, `signed_xml`, `created_at`, `confirmed_at`) — tabela própria porque `fiscal_events` exige `fiscal_document_id NOT NULL` e a inutilização trata de números que **nunca** viraram um `fiscal_documents`.
- **XML Oficial (`lib/fiscal/inutilizacao.ts` → `buildInutilizacaoXml`):** monta `<inutNFe>`/`<infInut>` (MOC 7.00 Anexo I) com `Id` composto por cUF+ano(2)+CNPJ+modelo+série(3)+nNFIni(9)+nNFFin(9), validando CNPJ, série, faixa (fim ≥ início) e justificativa (≥15 caracteres) — bloqueia em vez de aceitar dado incompleto.
- **Assinatura (`lib/fiscal/signer.ts` → `signInutilizacaoXml`):** generaliza a mesma rotina XMLDSIG já usada para `<infNFe>`/`<infEvento>`, assinando `<infInut>` e inserindo `<Signature>` antes de `</inutNFe>`.
- **Transmissão (`lib/fiscal/gateway.ts` → `FiscalGateway.inutilizeNumbering`, `SefazDirectGateway`):** transmite o `<inutNFe>` assinado diretamente (sem envelope de lote, diferente de `enviNFe`/`envEvento`) ao endpoint `NFeInutilizacao4` (já resolvido por UF).
- **Orquestração (`lib/fiscal/service.ts` → `inutilizeFiscalNumbering`):**
  - Reaproveita a permissão `FISCAL_CANCEL` (só OWNER/ADMIN) — não há um código dedicado de inutilização no catálogo de permissões atual; mesma gravidade/irreversibilidade perante o Fisco que o cancelamento. Se o usuário preferir um código próprio (`FISCAL_INUTILIZE`), avaliar antes de expor na UI.
  - **Nunca inutiliza um número já emitido:** verifica `fiscal_documents` na faixa solicitada e bloqueia se encontrar qualquer número já usado.
  - **Nunca repete inutilização de uma faixa já confirmada:** verifica sobreposição com registros `CONFIRMED` existentes.
  - Interpreta `cStat` da resposta: **102** = confirmado (grava `status='CONFIRMED'` + `confirmed_at` + protocolo); qualquer outro `cStat` = rejeição (`status='REJECTED'`), **nunca confirma sozinho** (mesmo princípio do §27); falha de comunicação grava `status='ERROR'` e relança o erro.
  - Grava linha em `fiscal_inutilizations` **antes** de chamar a SEFAZ (status `PENDING`) e atualiza a mesma linha depois — nunca `DELETE`.
- **Comando relacional:** `fiscal.nfe.inutilizar` (`storeId` + `series` + `numberStart` + `numberEnd` + `justification`, mínimo 15 caracteres), permissão `FISCAL_CANCEL`.
- **Validação:** `tests/fiscal.inutilizacao.test.ts` (8 testes): loja inexistente, permissão, justificativa curta, bloqueio de número já emitido, confirmação com cStat 102, rejeição da SEFAZ não confirma sozinho, falha de rede não confirma sozinho, bloqueio de faixa repetida, roteamento do comando.
- **Ressalva idêntica à do Marco 3/§29:** a estrutura exata do envelope SOAP `NFeInutilizacao4` e o `cStat` de sucesso adotado (102, "Inutilização de número homologada" — valor padrão amplamente documentado, mas não reverificado contra fonte oficial ao vivo nesta sessão) precisam ser confirmados contra o MOC 7.00 Anexo I com certificado A1 de teste de verdade, num ambiente com cadeia ICP-Brasil confiável, antes de qualquer inutilização real.
- **Com esta entrega, a Fase 6 está concluída** (DANFE + cancelamento fiscal + inutilização de numeração).

---

## Fase 6 — UI das três funcionalidades (DANFE, cancelamento fiscal, inutilização) — Implementada

- **`lib/fiscal/service.ts`:** nova função `listFiscalInutilizationsForSnapshot` (histórico de inutilizações por loja, para exibição).
- **`lib/domain.ts`:** re-exporta `FiscalInutilizationSummary`; `Snapshot.state` ganhou `fiscalInutilizations?: Record<storeId, FiscalInutilizationSummary[]>`.
- **`app/api/workspace/route.ts`:** `fullState()` agora também retorna `fiscalInutilizations` quando o ator tem `FISCAL_VIEW` (mesmo gate de `fiscalConfigs`/`fiscalDocuments`).
- **`app/workspace.tsx` — aba Vendas:** a coluna Fiscal passou a refletir o status real do ciclo de vida da NF-e (mapa `fiscalStatusLabel`: Gerada/Assinada/Transmitindo/Autorizada/Rejeitada/Cancelada) com ações contextuais:
  - `GENERATED`/`SIGNED` → botão **Transmitir** (`fiscal.nfe.transmit`) — **esta era uma lacuna anterior**: a UI só tinha o botão de gerar, nunca o de transmitir para a SEFAZ; sem ele a NF-e nunca saía de `GENERATED` pela interface.
  - `AUTHORIZED` → botão **DANFE** (abre `GET /api/workspace?danfe=<saleId>` em nova aba) e botão **Cancelar NF-e** (abre modal `nfe.cancel` com campo de justificativa ≥15 caracteres, chama `fiscal.nfe.cancel`).
  - `REJECTED` → botão **Nova tentativa** (chama `fiscal.nfe.generate` de novo, já suportado pelo backend para documentos rejeitados).
  - O botão de cancelamento comercial da venda (`sale.cancel`) é substituído por um aviso "Cancele a NF-e antes" enquanto a NF-e estiver `AUTHORIZED`, refletindo visualmente o guard já existente em `cancelSale`.
  - Modal "NF-e Modelo 55 · Documento Gerado" agora mostra o status real (não mais fixo em "Gerada e Validada") e exibe protocolo/data de autorização quando existirem.
- **`app/workspace.tsx` — modal de Configuração fiscal da loja:** nova seção **Inutilização de Numeração (§25)** com campos série/número inicial/número final/justificativa e botão "Inutilizar Faixa" (`fiscal.nfe.inutilizar`), mais uma lista do histórico de inutilizações da loja (série, faixa, ano, status).
- **Verificação:** `npx tsc --noEmit` sem erros; app iniciado localmente (`npm run dev` via `.claude/launch.json`) e verificado no navegador — compila e renderiza sem erros de console. **Não foi possível testar o fluxo autenticado completo** (clicar nos novos botões logado) porque o login usa OAuth do ChatGPT (`/signin-with-chatgpt`), que não está disponível neste ambiente sandbox — mesma classe de limitação já registrada para a comunicação com a SEFAZ real. Recomenda-se validação manual em um ambiente com login funcional antes de considerar a UI definitivamente pronta para uso.

---

## Fase 7 — NFC-e Modelo 65 (§20, backend implementado, UI pendente)

- **Migração:** `drizzle/0009_nfce_foundation.sql` adiciona `csc_id`, `csc_encrypted` e `qrcode_base_url` a `fiscal_configurations` (uma linha `model='65'` por loja, mesma tabela já usada para NF-e — o índice único `(tenant_id, store_id, model)` já suportava isso).
- **QR Code (`lib/fiscal/qrcode.ts` → `buildNFCeQrCode`):** monta a URL de consulta no formato "offline com CSC" da NT 2015.002 (`chave|versão|tpAmb|idCSC[|cDest]` + hash SHA-1 hexadecimal). A URL base é **sempre configurada pelo usuário por loja** (`qrCodeBaseUrl`) — nunca hardcoded aqui, porque essa URL é específica de cada UF e eu não tenho uma fonte oficial verificada para todas elas nesta sessão (§36: melhor bloquear e pedir do que presumir/errar um dado que varia por estado).
- **Builder generalizado (`lib/fiscal/builder.ts`):** `BuildNFeInput` ganhou `model?: '55'|'65'` e `qrCode?`. Para modelo 65: `<mod>65</mod>`, sem `<idDest>` (não existe no schema NFC-e), `<tpImp>4</tpImp>` (DANFE NFC-e), e grupo `<infNFeSupl><qrCode>` inserido entre `</infNFe>` e `</NFe>` (fora da assinatura digital, conforme NT 2015.002). `numericCode` agora pode ser repassado para permitir calcular a chave de acesso ANTES de montar o XML (necessário para computar o QR Code, que depende da chave).
- **Validador generalizado (`lib/fiscal/validator.ts`):** `validateNFeXmlSchema(xml, expectedModel)` — `idDest` só é exigido quando `expectedModel==='55'`; mensagem de erro do `mod` reflete o modelo esperado.
- **Módulo próprio (`lib/fiscal/nfce.ts`)** — separado de `lib/fiscal/service.ts` porque §20 exige que NF-e/NFC-e "compartilhem componentes comuns sem serem tratadas como exatamente o mesmo documento":
  - `saveNFCeStoreConfig`/`getNFCeStoreConfig`: série, CRT, CSC (criptografado com o mesmo `encryptPayload` AES-256-GCM já usado para certificados — nunca em texto plano no banco, nunca exposto de volta na leitura) e URL do QR Code. Reaproveita o certificado A1 já vinculado à configuração de NF-e da loja (mesmo CNPJ, mesma assinatura).
  - `generateNFCeForSale`: mesmas regras de "nunca presumir" da NF-e (NCM/CFOP/origem/CST-CSOSN/dados cadastrais da loja bloqueiam se ausentes) — mas destinatário é **sempre opcional** (nunca força CPF/CNPJ nem o texto de homologação sobre uma venda sem consumidor identificado, diferente da NF-e). Bloqueia se a loja não configurou CSC/URL do QR Code. Numeração e série são **independentes da NF-e** (sequência própria por modelo, já suportado por `lib/fiscal/sequence.ts`).
  - `getNFCeDanfeData`: extrai o QR Code do XML autorizado (nunca recalcula/inventa), monta os dados do DANFE NFC-e a partir de um documento `AUTHORIZED` (mesma regra do §22).
- **Reaproveitamento de componentes comuns confirmado por teste:** `transmitNFe` e `cancelNFeDocument` (já genéricos quanto ao `model` da linha em `fiscal_documents`) funcionam para NFC-e **sem nenhuma alteração** — testado explicitamente.
- **DANFE NFC-e (`lib/fiscal/danfe.ts` → `buildDanfeNfceHtml`):** layout compacto tipo cupom, com QR Code — mas **apenas como link/texto clicável, não como imagem escaneável** (este projeto não tem biblioteca de geração de imagem QR disponível; para uso real em caixa é preciso integrar uma antes de imprimir para o consumidor). Nunca reaproveita `buildDanfeHtml` (o de NF-e nunca inclui QR Code, por design).
- **Rota:** `GET /api/workspace?danfe=<saleId>` agora detecta o `model` do documento e roteia para `buildDanfeHtml` (55) ou `buildDanfeNfceHtml` (65) automaticamente.
- **Comandos:** `nfce.config.save` e `nfce.generate` (novos); `fiscal.nfe.transmit`/`fiscal.nfe.cancel` já servem para NFC-e sem modificação (operam por `saleId`, não fixam `model`).
- **Validação:** `tests/fiscal.nfce.test.ts` (10 testes): config NOT_CONFIGURED/READY, CSC nunca exposto em texto plano, bloqueio de geração sem config, XML modelo 65 sem `idDest` com QR Code, destinatário sempre opcional, numeração independente da NF-e, `transmitNFe`/`cancelNFeDocument` genéricos funcionando para NFC-e, DANFE NFC-e com QR Code, roteamento dos comandos.
- **122/122 testes passando** no total, `tsc --noEmit` sem erros.

### Pendências explícitas da Fase 7 (registradas, não escondidas)

| Item | Status | Detalhe |
| :--- | :--- | :--- |
| **Contingência (§20)** | **Não implementada** | Exigiria fila de reenvio + armazenamento local para emissão offline, que não existem no projeto. |
| **Inutilização de numeração (§25) para NFC-e** | **Não implementada** | `inutilizeFiscalNumbering` continua exclusiva ao modelo 55; generalizar é factível, mas não foi feito nesta entrega. |
| **QR Code como imagem escaneável** | **Não implementado** | DANFE NFC-e mostra a URL como link/texto; falta biblioteca de renderização de imagem QR para uso real em caixa. |
| **Verificação SOAP/QR contra fonte oficial ao vivo** | **Pendente** | Mesma limitação de rede/certificado ICP-Brasil já registrada para NF-e — o reaproveitamento de `NFeAutorizacao4` para modelo 65 e a fórmula de hash do QR Code (NT 2015.002) não foram reverificados contra uma fonte oficial ao vivo. |

### UI da Fase 7 (Implementada)

- **`app/workspace.tsx`, card da loja ("Minhas lojas"):** badge "NFC-e 65: Homologação" com status (Pronta/Incompleta/Não configurada, a partir de `state.nfceConfigs[storeId].status`) e botão **Configuração NFC-e** (admin), abrindo um modal com série, CRT, identificador do CSC, CSC (sempre reenviado por completo ao salvar — sem "atualização parcial" de segredo) e URL do QR Code. Reaproveita o certificado A1 já vinculado à configuração de NF-e da mesma loja (mesmo CNPJ/assinatura); chama `nfce.config.save`.
- **`app/workspace.tsx`, aba Vendas:** estado "Pendente" ganhou um segundo botão **Gerar NFC-e** ao lado de "Gerar NF-e" (`nfce.generate`) — a venda escolhe qual dos dois documentos emitir (mutuamente exclusivos por venda, já que `fiscal_documents` é único por `sale_id` independente do modelo). Uma vez gerado o documento (NF-e ou NFC-e), a coluna Fiscal e o modal de visualização (`nfe.view`) passaram a exibir o rótulo correto ("NF-e"/"NFC-e", "Modelo 55"/"Modelo 65") e os botões contextuais (Transmitir/DANFE/Cancelar/Nova tentativa) continuam funcionando para os dois, porque `fiscal.nfe.transmit`/`fiscal.nfe.cancel` já eram genéricos quanto ao modelo — nenhum comando novo foi necessário para essa parte.
- **Verificação:** `tsc --noEmit` sem erros; `node --test tests/*.test.ts` → 122/122; app rodado localmente e aberto no navegador embutido — carrega e renderiza sem erros de console/servidor. Mesma limitação de teste do fluxo autenticado já registrada na UI da Fase 6 (login via OAuth do ChatGPT, indisponível neste sandbox).

---

## Auditoria de 17/09/2026: dados fiscais presumidos encontrados e corrigidos

Depois da confissão registrada em `gemini.md` (alíquotas de ICMS e chave de criptografia inventadas, revertidas), uma nova auditoria do código fiscal então existente encontrou **quatro** casos remanescentes do mesmo padrão — presumir um valor fiscal em vez de bloquear a emissão (§36) — todos corrigidos e agora com teste de regressão:

| # | Onde | O que presumia | Correção |
| :-- | :--- | :--- | :--- |
| 1 | `lib/fiscal/certificate.ts` | Chave mestra de criptografia com fallback fixo no código (`DEFAULT_KEY`) quando `FISCAL_SECRET_KEY` não configurada | `getMasterKey()` bloqueia (`RuleError`) sem a variável de ambiente configurada (≥32 caracteres) |
| 2 | `lib/fiscal/builder.ts` | CSOSN `102`/CST `41` e origem `0` quando o produto não tinha esses campos cadastrados | `buildNFeXml` exige origem (0–8) e CST/CSOSN explícitos por item; só aceita os dois códigos cuja estrutura sem cálculo de valor está implementada |
| 3 | `lib/fiscal/service.ts` (`generateNFeForSale`) | Recalculava o mesmo default de origem/CST-CSOSN **antes** de chamar `buildNFeXml`, anulando a correção nº 2 | Repassa exatamente o que está cadastrado no produto (vazio se ausente) |
| 4 | `lib/fiscal/service.ts` (`generateNFeForSale`) | CFOP `5102` como padrão quando o produto não tinha CFOP cadastrado | Bloqueia com "CFOP válido de 4 dígitos" se ausente |
| 5 | `lib/fiscal/service.ts` (`generateNFeForSale`) | Regime tributário (CRT) da loja assumido como `1_SIMPLES_NACIONAL` quando a loja nunca salvou configuração fiscal (§37: "não assumir que todas as empresas sejam Simples Nacional") | Bloqueia pedindo para configurar CRT/série (`fiscal.config.save`) antes de emitir |

Testes de regressão adicionados: `Rejeita geração se produto não possuir CFOP cadastrado`, `Rejeita geração se a loja não tiver configuração fiscal salva`.

---

## Fase 8 — Escala (backend implementado, UI pendente)

Escopo definido pelo usuário via pergunta de esclarecimento nesta sessão: (1) fila assíncrona fiscal baseada em D1 — não Cloudflare Queues, porque este projeto (vinext/Cloudflare Workers) gera `dist/server/wrangler.json` automaticamente no build e não há um `wrangler.toml` editável no repositório para configurar um binding real sem adivinhar infraestrutura; (2) relatórios de vendas, fechamento de caixa e fiscal; (3) AuditLog completo (§42) primeiro, como base para os relatórios.

### AuditLog completo (§42)

- **Migração:** `drizzle/0010_audit_full.sql` adiciona `entity`, `entity_id`, `before_data`, `after_data`, `ip`, `correlation_id` a `audit_logs`.
- **`lib/audit/service.ts` reescrito:** `recordAudit` aceita os novos campos; `sanitizeForAudit` remove chaves de segredo conhecidas (`passphrase`, `csc`, `pfxBase64`, `privateKeyPem`, `certBase64` etc.) de `before`/`after` antes de serializar — rede de segurança mesmo se um chamador futuro esquecer de omitir um segredo manualmente (§42: "Não armazenar segredos nos logs").
- **`lib/relationalCommands.ts`:** `dispatchCommand` ganhou um 6º parâmetro opcional `context: {ip, correlationId}` (retrocompatível — todas as chamadas existentes continuam funcionando sem passá-lo) e um helper interno `audit()` que grava `entity`/`entityId`/`before`/`after` em quase todas as ~28 ações, propagando o mesmo IP e correlation ID da requisição.
- **`app/api/workspace/route.ts`:** extrai o IP do cabeçalho (`cf-connecting-ip`/`x-forwarded-for`) e reaproveita a própria chave de idempotência da requisição (`body.key`, já um UUID validado) como correlation ID — nenhum identificador novo foi inventado.
- **Limitação registrada:** a cobertura de `before` (estado anterior) é parcial — a maioria das ações grava apenas `after` (estado novo); `before` só foi adicionado onde uma consulta barata já estava disponível (ex.: `product.update`). Uma auditoria antes/depois completa em 100% das ações exigiria buscar o estado anterior em cada uma das ~28 ações antes de executá-las, o que não foi feito nesta entrega.
- **Validação:** `tests/audit.full.test.ts` (4 testes) — propagação de IP/correlation ID, before/after em `product.update`, e dois testes de redação de segredo (via `dispatchCommand` real e via `recordAudit` direto, simulando um chamador que esqueceria de omitir).

### Relatórios (`lib/reports/service.ts`)

Agregações somente-leitura sobre dados já persistidos — nenhuma regra de negócio nova, nenhum número presumido. Todas exigem a permissão `REPORT_VIEW` (já existente no catálogo, concedida a OWNER/ADMIN/GERENTE/CONSULTA).

- **`getSalesReport`**: totais por dia/loja, ticket médio, formas de pagamento somadas, contagem de vendas canceladas (excluídas dos totais de faturamento). Filtros opcionais `storeId`/`from`/`to`.
- **`getCashReport`**: sessões de caixa com sangria/suprimento somados por sessão, diferença de fechamento, contagem de sessões abertas.
- **`getFiscalReport`**: contagem de `fiscal_documents` por modelo/status, valor total autorizado, contagem de documentos pendentes de transmissão (`GENERATED`/`SIGNED`).
- **Rota:** `GET /api/workspace?report=sales|cash|fiscal[&storeId=][&from=][&to=]`, retorna JSON.
- **Validação:** `tests/reports.test.ts` (6 testes).

### Fila fiscal assíncrona (§41, `lib/fiscal/queue.ts`)

- **Migração:** `drizzle/0011_fiscal_jobs.sql` cria a tabela `fiscal_jobs` (job_type, sale_id/store_id, payload, status, attempts, max_attempts, next_attempt_at, last_error, user_id, correlation_id, idempotency_key único por tenant).
- **`enqueueFiscalJob`**: idempotente — a mesma chave (`jobType:saleId`) nunca cria um segundo job enquanto o anterior estiver `PENDING`/`PROCESSING`; só permite reenfileirar quando o anterior já terminou (sucesso, falha ou dead-letter).
- **`runFiscalJobWorker`**: reivindica atomicamente o próximo job pendente (`UPDATE...WHERE id=(SELECT...)...RETURNING`, mesmo padrão de `lib/fiscal/sequence.ts`), recarrega o ator (`loadPermissions`) a partir do `userId` salvo no job (nunca confia num snapshot de permissões potencialmente desatualizado), e reaproveita **sem nenhuma alteração** `transmitNFe`/`cancelNFeDocument` de `lib/fiscal/service.ts`. Backoff exponencial com teto de 30 minutos; após `maxAttempts` (padrão 5), move para `DEAD_LETTER`. **Nunca retry cego que gere duplicidade (§41):** se o job falhar mas o documento já tiver alcançado o estado desejado (ex.: uma tentativa anterior teve sucesso mas o job não foi marcado a tempo), o worker reconhece isso como sucesso em vez de tentar de novo.
- **`getFiscalJobsSummary`**: observabilidade (§41) — contagem por status + até 20 jobs em dead-letter mais recentes.
- **Novos comandos:** `fiscal.nfe.retry` (enfileira `TRANSMIT_NFE`/`CANCEL_NFE` para uma venda, exige `FISCAL_ISSUE`/`FISCAL_CANCEL`) e `fiscal.jobs.process` (dispara o worker manualmente para até 10 jobs, exige `FISCAL_ISSUE`).
- **Limitação explícita, registrada e não escondida:** não há Cloudflare Cron Trigger real configurado — o worker só roda quando `fiscal.jobs.process` é chamado (um botão manual na UI, ainda não construído, ou um agendador externo que chame a API autenticado). Não há processamento em background automático nesta entrega.
- **Validação:** `tests/fiscal.queue.test.ts` (7 testes): idempotência do enfileiramento, processamento com sucesso, falha de rede agenda retry com backoff, esgotamento de tentativas vai para dead-letter, falha com estado já alcançado marca sucesso (evita falso dead-letter), roteamento dos comandos com checagem de permissão, resumo de observabilidade.

### UI da Fase 8 (Implementada)

- **`app/workspace.tsx`, nova aba "Relatórios"** (ícone `BarChart3`, entre "Equipe" e "Assinatura"): quatro painéis carregados sob demanda quando a aba é aberta (`GET /api/workspace?report=sales|cash|fiscal|fiscal-jobs`, respeitando o filtro de loja do topo):
  - **Vendas:** total, contagem, ticket médio, canceladas, formas de pagamento somadas, tabela por dia/loja.
  - **Caixa:** sessões, sessões em aberto, suprimentos/sangrias totais, tabela por sessão com diferença de fechamento.
  - **Fiscal:** valor total autorizado, pendências de transmissão, tabela por modelo (NF-e/NFC-e) e status.
  - **Fila Fiscal (§41):** contagem de jobs por status (`byStatus`), botão **Processar fila agora** (restrito a admin, chama `fiscal.jobs.process` e mostra um toast com o resumo), e tabela dos jobs em `DEAD_LETTER` com tipo, venda, tentativas e último erro.
- **`app/api/workspace/route.ts`:** nova rota `GET ?report=fiscal-jobs` expondo `getFiscalJobsSummary`.
- **Verificação:** `tsc --noEmit` sem erros; `node --test tests/*.test.ts` → 139/139; app rodado localmente e aberto no navegador embutido — carrega e renderiza sem erros de console/servidor. Mesma limitação de teste do fluxo autenticado já registrada nas UIs das Fases 6/7 (login via OAuth do ChatGPT, indisponível neste sandbox).
- **Atualização posterior (mesmo dia):** as duas lacunas de UI abaixo foram fechadas — aba Vendas ganhou botão **Reenfileirar** (ícone `PlayCircle`) para documentos `SIGNED`, chamando `fiscal.nfe.retry`; aba Relatórios ganhou seletor de período De/Até que filtra o relatório de Vendas via `from`/`to`. `tsc --noEmit` sem erros, 139/139 testes continuam passando, verificado no navegador local sem erros de console/servidor.

### Pendências explícitas da Fase 8

| Item | Status | Detalhe |
| :--- | :--- | :--- |
| **UI de `fiscal.nfe.retry` (reenfileirar 1 venda)** | **Concluído** | Botão "Reenfileirar" na aba Vendas para documentos `SIGNED`. |
| **Filtro de data nos relatórios** | **Concluído** | Seletor De/Até na aba Relatórios, filtra o relatório de Vendas. |
| **Cron Trigger real** | **Não implementada** | Sem `wrangler.toml` editável no projeto; worker só roda sob chamada manual/externa autenticada. |
| **AuditLog before/after completo** | **Parcial** | A maioria das ações grava só `after`; `before` só onde já havia consulta barata disponível. |
| **"Otimização" e "dashboards" (§75)** | **Não abordados** | Fora do escopo desta entrega — o usuário priorizou fila + relatórios + AuditLog; os "relatórios" desta entrega são tabelas/métricas, não gráficos. |

**139/139 testes passam no total** (`tests/*.test.ts`), `tsc --noEmit` sem erros.

---

## Migração para VPS (remoção do ChatGPT Sites/Cloudflare) — implementada

Decisões do usuário: e-mail+senha, PostgreSQL, Next.js padrão em Node. Detalhe completo em `CLAUDE.md` (item "Migração para VPS") e passo a passo de deploy no `README.md`. As seções acima que citam D1, OAuth do ChatGPT ou `wrangler` são históricas.

- **Feito:** remoção de todos os artefatos ChatGPT Sites/Cloudflare/vinext/drizzle-kit; `db/database.ts` + `lib/db/pgAdapter.ts` (Postgres com a interface `D1Database`, sem tocar `lib/*/service.ts`); `drizzle/0001_init.sql` + `npm run db:migrate`; auth por e-mail/senha (`lib/auth`, `app/auth.ts`, `app/api/auth/*`, tela de login/cadastro); `next build` padrão passa; **144/144 testes** (5 novos em `tests/auth.test.ts`), `tsc` sem erros.
- **Pendente / não verificado:** rodar `db:migrate` e o cadastro/login contra um PostgreSQL real (o sandbox não tinha Postgres); recuperação de senha, verificação de e-mail, 2FA e limite de tentativas de login; (resolvido: worker automático da fila fiscal em `lib/fiscal/worker.ts`/`instrumentation.ts`, `FISCAL_WORKER_INTERVAL_MS`, retry automático após falha de rede na transmissão; ainda não validado em processo real de produção); `.kilo/`, `outputs/` e `dist/` locais (ignorados pelo git) podem ser apagados na VPS.

---

## Situação das Lacunas e Próximos Passos

| Item | Status | Detalhe |
| :--- | :--- | :--- |
| **Fase 1 (RBAC / Usuários)** | **Concluído** | Backend e UI completos. |
| **Fase 2 (Catálogo / Estoque)** | **Concluído** | Concorrência e integridade atômica validadas. |
| **Fase 3 (PDV / Caixa)** | **Concluído** | Pagamento misto, sangria, suprimento e cancelamento completos. |
| **Fase 4 (Fundação Fiscal Direta)** | **Concluído** | Banco, criptografia A1, builder 4.00, XMLDSIG, endpoints e gateway direto implementados e testados. |
| **Clientes e Fornecedores** | **Concluído** | Tabelas relacionais, CRUD, RBAC, auditoria e UI completos. |
| **Fase 5 — Marco 1 (Status do Serviço SEFAZ)** | **Concluído** | Configuração fiscal por loja, upload criptografado de certificado A1 e teste direto mTLS de status de serviço em Homologação. |
| **Fase 5 — Marco 2 (Geração de NF-e e Validação XSD)** | **Concluído** | Geração de XML de NF-e modelo 55 a partir de venda, validação sintática formal contra schemas XSD do PL_009k e visualização no frontend. |
| **Fase 5 — Marco 3 (Assinatura e Transmissão em Homologação)** | **Concluído, com ressalva** | Assinatura XMLDSIG e transmissão implementadas e testadas com mock explícito; estrutura do envelope SOAP não verificada contra fonte oficial ao vivo (ver seção acima) — confirmar antes de emissão real. |
| **Auditoria de dados fiscais presumidos** | **Concluído** | 5 casos encontrados e corrigidos (tabela acima); testes de regressão adicionados. |
| **Fase 6 — DANFE (§22)** | **Concluído** | `lib/fiscal/danfe.ts`/`getDanfeData`: representação HTML só a partir de NF-e `AUTHORIZED`, sem QR Code (exclusivo de NFC-e). Exposto em `GET /api/workspace?danfe=<saleId>`. Falta o botão na UI de Vendas. |
| **Fase 6 — Cancelamento fiscal (§29)** | **Concluído, com ressalva** | Evento `110111` assinado e transmitido via `NFeRecepcaoEvento4`; nunca faz `DELETE`; `cancelSale` bloqueia cancelamento comercial com NF-e ainda `AUTHORIZED`. Estrutura do envelope SOAP e `cStat` de sucesso (135) não verificados contra fonte oficial ao vivo (ver seção acima) — confirmar antes de cancelamento real. Falta UI (botão de cancelar NF-e). |
| **Fase 6 — Inutilização de numeração (§25)** | **Concluído, com ressalva** | `<inutNFe>` assinado e transmitido via `NFeInutilizacao4`; nunca inutiliza número já emitido; nunca repete faixa já confirmada. Estrutura do envelope SOAP e `cStat` de sucesso (102) não verificados contra fonte oficial ao vivo — confirmar antes de inutilização real. |
| **Fase 6 — UI (DANFE, cancelamento, inutilização)** | **Concluído, não testado com login real** | Botões/telas adicionados em `app/workspace.tsx`. Compilação e render sem erros verificados no navegador; fluxo autenticado não pôde ser clicado por falta de OAuth do ChatGPT neste sandbox. **Fase 6 concluída com esta entrega.** |
| **Fase 7 — NFC-e Modelo 65 (§20), backend + UI** | **Concluído, com ressalvas** | Config (CSC/QR Code), builder/validator generalizados, geração, DANFE NFC-e (sem imagem QR), reaproveitamento de transmissão/cancelamento, UI completa (botão de configuração + gerar/transmitir/DANFE/cancelar na aba Vendas). Ver tabela de pendências explícitas abaixo (contingência, inutilização NFC-e, imagem QR). |
| **Fase 8 — AuditLog completo (§42)** | **Concluído, com ressalva** | IP/correlation ID em todas as ações, entity/entityId/after na maioria; `before` só parcial. Nunca grava segredo (sanitização com rede de segurança). |
| **Fase 8 — Relatórios (vendas/caixa/fiscal)** | **Concluído, backend** | `GET /api/workspace?report=sales\|cash\|fiscal`. Falta UI. |
| **Fase 8 — Fila fiscal assíncrona (§41)** | **Concluído, com ressalva** | Fila em D1 (não Cloudflare Queues); retry/backoff/dead-letter/idempotência testados. Sem Cron Trigger real — só roda sob chamada manual/externa. UI: botão "Processar fila agora" + observabilidade; falta UI para reenfileirar 1 venda específica. |
| **Fase 8 — UI (Relatórios + Fila)** | **Concluído, não testado com login real** | Aba "Relatórios" com 4 painéis em `app/workspace.tsx`. Compilação e render sem erros verificados no navegador; fluxo autenticado não pôde ser clicado por falta de OAuth do ChatGPT neste sandbox. **Fase 8 concluída com esta entrega.** |

| **Deploy Docker + Traefik** | **Configurado, não testado** | `Dockerfile`, `docker-compose.yml` (app + Postgres 16, rede externa `traefik9`, `omnihub.adapterco.com.br`, roteadores http→https e https com `letsencrypt`, porta 3017), `.env.example`. `isSameOrigin` aceita `x-forwarded-*` (senão 403 atrás do proxy). Sem Docker no ambiente de desenvolvimento: build da imagem e subida ainda não executados. |

---

## Como Rodar e Verificar

1. **Checagem estática de tipos (TypeScript):**
   ```bash
   npx tsc --noEmit
   ```
   *Resultado esperado:* 0 erros de tipo.

2. **Suíte de Testes Automatizados:**
   ```bash
   node --test tests/*.test.ts
   ```
   *Resultado esperado:* **139 testes passando** (0 falhas).

3. **Antes de qualquer emissão, cancelamento ou inutilização real de NF-e/NFC-e:** confirmar a estrutura dos envelopes SOAP (`enviNFe`/`NFeAutorizacao4`, `envEvento`/`NFeRecepcaoEvento4` e `inutNFe`/`NFeInutilizacao4`), o mapeamento de `cStat` contra o MOC 7.00 Anexos I, II e V, e a fórmula do hash do QR Code da NFC-e contra a NT 2015.002 vigente, com um certificado A1 de teste de verdade e um CSC real num ambiente com a cadeia ICP-Brasil confiável (este ambiente de desenvolvimento não tem essa cadeia disponível).