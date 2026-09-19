# Análise inicial e plano de adequação ao instrucoes.md

Data: 16/09/2026. Referência normativa: `../instrucoes.md`, seções 1–79. Base de código examinada: commit `86521ce7f5eb3318cc3092fff135dac1cdfb2a79`, mais o arquivo de instruções fornecido pelo usuário.

**Status de execução:** Fase 1 (§18, RBAC) **implementada** em `lib/authz/`, `db/schema.ts` (tabelas `users`, `roles`, `permissions`, `role_permissions`, `user_tenant_roles`, `user_stores`) e `drizzle/0001_material_sersi.sql` (seed + backfill de `memberships`), com `lib/domain.ts` e `app/api/workspace/route.ts` já usando permissões centralizadas em vez de `role==='admin'` disperso. Validado por `tests/authz.test.ts` e `tests/domain.test.ts` (19 testes, todos passando) e por `tsc --noEmit`/`eslint` sem erros. **Não** validado ainda: aplicação da migração 0001 contra D1 real fora do smoke test local, e interface para atribuir os papéis GERENTE/ESTOQUISTA/CONSULTA a um novo usuário (ainda não existe fluxo de convite).

Fase 2 (§18, catálogo/estoque relacional) **implementada e cortada (cutover) para produção**: schema relacional completo em `db/schema.ts`/`drizzle/0002_vengeful_sphinx.sql` (`stores`, `categories`, `products`, `product_fiscal_profiles`, `inventories`, `stock_movements`, `stock_transfers`, `stock_transfer_items`), serviços `lib/catalog/service.ts` e `lib/inventory/service.ts` com permissão centralizada, ledger de movimentação completo e o ciclo de transferência de 6 estados de §7 (PENDING→APPROVED→IN_TRANSIT→RECEIVED/CANCELLED). O ajuste de estoque usa uma instrução `UPDATE ... RETURNING` protegida por um `CHECK (quantity >= 0)` no banco — não uma revalidação em memória — o que elimina a janela de corrida de "ler saldo, decidir, gravar" mesmo sob duas vendas concorrentes disputando o último item; essa garantia está coberta por teste (`tests/inventory.test.ts`, incluindo o cenário de §65 "dois caixas vendendo o último item").

**Corte (cutover) concluído:**
- `app/api/workspace/route.ts` agora resolve `store.create/update`, `product.create/update`, `stock.receive`, `transfer.create/receive` via `lib/relationalCommands.ts` (que chama `lib/catalog`/`lib/inventory`), não mais via `lib/domain.ts`'s `execute()`. `lib/domain.ts`'s `State` perdeu `stores/products/stock/transfers`; só guarda `cash/sales/audit/requests` (o que resta para a Fase 3).
- `drizzle/0004_backfill_catalog_stock.sql` migra o que já existir no JSON (`accounts.state`) para as tabelas relacionais, preservando IDs, de forma idempotente (`NOT EXISTS` em cada INSERT — pode ser reaplicada sem duplicar). Validado manualmente com dados sintéticos no formato antigo (loja, produto, estoque aninhado e transferência), incluindo reexecução sem duplicação; **não** foi aplicado contra um D1 real de produção nesta sessão.
- Idempotência (§31) para os comandos relacionais preservada via nova tabela `command_idempotency` (`lib/idempotency.ts`), já que eles não usam mais `state.requests` do JSON.
- Auditoria (§42) de loja/produto/estoque/transferência preservada via nova tabela `audit_logs` (`lib/audit/service.ts`), mesclada com a auditoria de caixa/venda (ainda no JSON) na resposta da API — sem essa tabela, cortar essas ações para fora do JSON teria apagado o rastro de auditoria que já existia.
- Venda (`sale.create`) continua no JSON, mas agora lê preço/nome do produto das tabelas relacionais e baixa estoque via `applySaleStockBatch` (um único `db.batch()`, todo-ou-nada por item do carrinho). Se a baixa de estoque for bem-sucedida mas a gravação da venda no JSON falhar por conflito de revisão (dois caixas escrevendo ao mesmo tempo), o servidor **compensa** revertendo a baixa (mesmo mecanismo, sinal invertido, tipo `SALE_CANCEL`) antes de devolver o erro 409 ao cliente — não há venda "fantasma" nem estoque que some sem motivo.
- Contrato da API (`/api/workspace`) e forma da resposta (`state.stores/products/stock/transfers`) mantidos idênticos para o frontend (`app/workspace.tsx`); nenhuma mudança foi necessária nele.

**Lacunas conhecidas na época (Fase 2), agora resolvidas ou substituídas pela Fase 3 abaixo:** a compensação de `sale.create` por conflito de revisão (item antigo) não existe mais — venda e estoque são ambos relacionais agora e cabem numa única transação SQL.

## Fase 3 (§18, PDV/caixa relacional) — implementada e cortada (cutover)

Schema em `db/schema.ts`/`drizzle/0005_wandering_cyclops.sql`: `cash_registers` (terminal, §14), `cash_sessions`, `cash_movements` (sangria/suprimento, §15 — **funcionalidade nova**, não existia antes), `sales`, `sale_items`, `sale_payments`, `non_fiscal_receipts` (§12). Serviços `lib/cash/service.ts` e `lib/sales/service.ts`.

**O que mudou:**
- `lib/domain.ts`'s `execute()`/`State`/`visibleState`/`emptyState` foram **removidos** — não sobrava nenhum comando para eles tratarem depois que caixa e venda também viraram relacionais. `lib/domain.ts` agora só tem helpers puros (`money`, `date`, `requireActive`) e os schemas comerciais (`storeFields`, `productFields`) reaproveitados por `lib/catalog`. O catálogo único de comandos (todos os 14 tipos) vive em `lib/commands.ts`; o dispatcher único vive em `lib/relationalCommands.ts`'s `dispatchCommand`.
- **Pagamento misto (§13):** `sale.create` aceita o campo antigo `payment` (um método, comportamento idêntico ao de sempre) OU o novo `payments: {method,amount}[]` (vários métodos, soma validada contra o total). O frontend atual continua enviando só `payment` — nada muda para quem já usa o PDV; a capacidade de split fica pronta no backend, faltando o campo na tela de venda.
- **Sangria/suprimento (§15):** `cash.supply`/`cash.withdrawal`, novos comandos, entram no cálculo do valor esperado no fechamento (`opening + vendas em dinheiro + suprimentos - sangrias`). Sem tela própria ainda — só a API existe.
- `sale.create` e o estoque agora cabem em **um único `db.batch()`** (venda + itens + pagamentos + comprovante não fiscal + baixa de estoque), verdadeiramente atômico — a compensação de duas escritas separadas que a Fase 2 precisava (JSON + relacional) deixou de ser necessária.
- `cancelSale` (`SALE_CANCEL`) devolve o estoque integralmente e marca a venda como `CANCELLED`; só os status `COMPLETED`/`CANCELLED` de §17 são alcançáveis hoje (DRAFT/PENDING_PAYMENT/PAID/REFUNDED ficam para quando existir orçamento/pré-venda e devolução parcial, §54/§70).
- `lib/cash`/`lib/sales` **restringem por loja** (`actor.storeId === id` para não-admin, igual ao antigo `store()`), diferente de `lib/catalog`/`lib/inventory` (Fase 2), que ainda não fazem essa checagem — ver lacuna abaixo.
- `accounts.state`/`accounts.revision` ficam sem uso funcional a partir daqui (não removidos — seria uma migração destrutiva sem necessidade imediata); `revision` continua incrementando a cada escrita só como contador de ordenação para o merge-guard do frontend, sem mais checagem condicional de conflito.

**Lacunas conhecidas, documentadas (não escondidas):**
- `lib/catalog`/`lib/inventory` (loja/produto/estoque/transferência) ainda **não restringem por loja** — só checam permissão. Hoje não regride nada em produção (só existem OWNER e OPERADOR_CAIXA); precisa ser resolvido antes de haver convite para ESTOQUISTA/GERENTE.
- Transferências `CANCELLED` não aparecem na lista compatível com o frontend — o registro continua no banco (§55), só não é exibido.
- Sem UI para: pagamento misto, sangria/suprimento, cancelamento de venda. Backend pronto e testado; falta a tela.
- `drizzle/0005_wandering_cyclops.sql` não foi aplicado contra um D1 real de produção nesta sessão (só via `node:sqlite` local).
- 48/48 testes passam (`tests/*.test.ts`, incluindo os novos `tests/cash.test.ts` e `tests/sales.test.ts`, que cobrem o cenário de §65 "dois caixas vendendo o último item" também para venda); `tsc --noEmit`/`eslint` sem erros.

## Fase 4/5 (fundação fiscal / NF-e) — em andamento, com um incidente registrado e corrigido

Trabalho realizado em sessão(ões) separada(s) desta análise; detalhes de escopo em `falta.md` (o que foi construído) e `gemini.md` (um incidente confessado e revertido antes deste ponto). Resumo do que esta sessão auditou e corrigiu, para manter a rastreabilidade num único lugar:

- **Achado 1 (corrigido):** `lib/fiscal/certificate.ts` tinha uma chave mestra de criptografia com fallback fixo no código (`DEFAULT_KEY`) quando `FISCAL_SECRET_KEY` não estava configurada — exatamente a mesma classe de violação que `gemini.md` já tinha confessado uma vez (§23: nunca segredo em variável pública, nunca sem KMS/secret manager em produção). **Corrigido:** `getMasterKey()` agora bloqueia (`RuleError`) se a variável de ambiente não estiver configurada com pelo menos 32 caracteres; não há mais nenhum valor padrão no código.
- **Achado 2 (corrigido):** `lib/fiscal/builder.ts` presumia CSOSN `102` e CST `41` quando o produto não tinha código de tributação cadastrado (`item.taxCode || '102'`), e nunca validava a origem da mercadoria (`item.origin || '0'`). Isso é exatamente o que §36 proíbe explicitamente ("NCM ausente → bloquear emissão, não inventar" — o mesmo vale para CST/CSOSN/origem). **Corrigido:** `buildNFeXml` agora exige que cada item tenha origem (0–8) e CST/CSOSN explicitamente cadastrados, e só aceita os dois códigos cuja estrutura de XML sem cálculo de valores já está implementada (CSOSN 102 e CST 41); qualquer outro código bloqueia a emissão com mensagem explicando o que falta, em vez de gerar uma classificação fiscal inventada.
- **Pendência explícita:** o conjunto de CST/CSOSN aceito (102 e 41) e a estrutura dos grupos XSD associados foram montados a partir de conhecimento geral do layout NF-e 4.00, não de uma nova consulta ao schema oficial nesta sessão — `docs/fiscal/official-sources.md` já pede essa rastreabilidade e alguns de seus links têm parâmetros que parecem corrompidos/genéricos; recomendo confirmar contra o pacote XSD oficial (PL_009k) antes de qualquer emissão real, e antes de aceitar outros CST/CSOSN no futuro.
- Testes (`tests/fiscal.direct.test.ts`, `tests/fiscal.connectivity.test.ts`, `tests/fiscal.nfe-generation.test.ts`) ajustados/validados após a correção — 79/79 passam, `tsc --noEmit` limpo.
- **Achado 3 (corrigido):** o mesmo default silencioso de origem/CST-CSOSN reaparecia uma camada acima, em `generateNFeForSale` (`lib/fiscal/service.ts`), que calculava `taxCode: item.taxCode || (crt==='1_SIMPLES_NACIONAL'?'102':'41')` **antes** de chamar `buildNFeXml` — anulando a validação que tínhamos acabado de adicionar lá, porque o builder nunca recebia um valor vazio para bloquear. Corrigido: `generateNFeForSale` agora repassa exatamente o que está cadastrado no produto (vazio se não cadastrado), deixando `buildNFeXml` ser o único ponto de bloqueio.
- **Achado 4 (corrigido, encontrado numa auditoria de acompanhamento em 17/09):** `generateNFeForSale` também defaultava `cfop: item.cfop || '5102'` — mesmo padrão do Achado 2/3, agora para CFOP. Corrigido: bloqueia com "CFOP válido de 4 dígitos" se ausente. Teste de regressão adicionado.
- **Achado 5 (corrigido, mesma auditoria):** `generateNFeForSale` assumia `crt: fiscalConfig?.crt ?? '1_SIMPLES_NACIONAL'` quando a loja nunca tinha salvo configuração fiscal — violação direta de §37 ("não assumir que todas as empresas sejam Simples Nacional"). Corrigido: bloqueia pedindo para configurar CRT/série (`fiscal.config.save`) antes de emitir. Teste de regressão adicionado.

### Fase 5 — Marco 3 (assinatura + transmissão em homologação): implementado, com uma limitação de verificação explícita

- `lib/fiscal/service.ts` ganhou `transmitNFe()`: assina o XML já gerado (Marco 2) via `signNFeXml` (XMLDSIG), transmite via `FiscalGateway.authorizeNFe` (síncrono, `enviNFe indSinc="1"`), interpreta `cStat` da resposta (100 = autorizado; qualquer outro = rejeitado, nunca vira autorização automática — §27) e persiste em `fiscal_documents`/`fiscal_events`/`fiscal_audit_logs`. Novo comando `fiscal.nfe.transmit` (permissão `FISCAL_ISSUE`).
- Falha de comunicação (rede/timeout) devolve o documento para `SIGNED` (retomável) em vez de deixá-lo travado em `TRANSMITTING` ou autorizá-lo por engano; permite nova tentativa sem duplicar o documento (§31/§41).
- **Limitação explícita, não escondida:** não consegui verificar a estrutura exata do envelope SOAP (`enviNFe`/`nfeAutorizacao4`) nem o mapeamento completo de códigos `cStat` contra uma fonte oficial ao vivo nesta sessão — o Portal Nacional da NF-e devolveu um loop de redirecionamento a partir deste ambiente, e o endpoint real de homologação da SEFAZ exige uma cadeia de certificação ICP-Brasil que este sandbox não possui (`unable to get local issuer certificate`). O código segue o padrão geral já usado por `NFeStatusServico4` (que tem teste de integração com mock, mas não contra o serviço real). **Antes de qualquer transmissão real**, confirmar contra o MOC 7.00 Anexo II com um certificado A1 de teste de verdade.
- Testes: `tests/fiscal.transmission.test.ts` (7 testes) usam um `FiscalGateway` **mock, explicitamente identificado como tal no código** (autorização, rejeição, falha de comunicação com retentativa, bloqueio de retransmissão, bloqueio sem NF-e gerada, permissão, roteamento via `dispatchCommand`). Isso valida a integração interna; não substitui um teste real contra a SEFAZ de homologação.
- 88/88 testes passam (`tests/*.test.ts`, após os Achados 4 e 5 e seus testes de regressão), `tsc --noEmit`/`eslint` sem erros.

## Fase 6 — DANFE (§22, implementado e validado)

`lib/fiscal/danfe.ts` (`buildDanfeHtml`) + `lib/fiscal/service.ts` (`getDanfeData`) geram uma representação HTML do DANFE modelo 55 exclusivamente a partir de um documento com status `AUTHORIZED` — bloqueiam para qualquer outro status, e nunca incluem QR Code (exclusivo do DANFE de NFC-e, §20, ainda não implementado). Exposto via `GET /api/workspace?danfe=<saleId>`, reaproveitando a permissão `FISCAL_VIEW` e o isolamento por tenant já existentes. Testado em `tests/fiscal.danfe.test.ts` (5 testes). Nenhum dado novo foi inventado — os campos vêm de `fiscal_documents`/`sales`/`sale_items`/`sale_payments`/`stores`, já persistidos e validados nas fases anteriores. Pendência: falta o botão na UI de Vendas para abrir essa rota.

## Fase 6 — Cancelamento fiscal (§29, implementado e validado, com a mesma limitação de verificação do Marco 3)

- `lib/fiscal/events.ts` (`buildCancellationEventXml`): monta o evento `110111` (`<evento>`/`<infEvento>`), validando CNPJ (14 dígitos), chave de acesso (44 dígitos), justificativa (≥15 caracteres, exigência da SEFAZ) e protocolo de autorização — bloqueia em vez de aceitar dado incompleto, mesmo padrão do restante do módulo fiscal.
- `lib/fiscal/signer.ts` ganhou `signEventXml()`: generaliza a mesma rotina XMLDSIG (C14N, SHA-1, RSA-SHA1) de `signNFeXml`, assinando `<infEvento>` em vez de `<infNFe>` e inserindo `<Signature>` antes de `</evento>`.
- `lib/fiscal/gateway.ts` ganhou `FiscalGateway.cancelNFe()`/`SefazDirectGateway.cancelNFe()`: envelopa o evento assinado em `envEvento versao="1.00"` e transmite via SOAP 1.2/mTLS ao endpoint `NFeRecepcaoEvento4` (já resolvido por UF).
- `lib/fiscal/service.ts` ganhou `cancelNFeDocument()`: exige `FISCAL_CANCEL` (só OWNER/ADMIN); só cancela documento `AUTHORIZED` com protocolo gravado; interpreta `cStat` — **135** cancela (grava `fiscal_documents.status='CANCELLED'` + `cancelled_at` e `FiscalEvent(type='CANCELLATION')`), qualquer outro cStat grava `FiscalEvent(type='CANCELLATION_REJECTED')` e nunca cancela sozinho (mesmo princípio do §27), falha de comunicação grava `FiscalEvent(type='CANCELLATION_ERROR')` e mantém `AUTHORIZED` (retomável, `nSeqEvento` incrementa por tentativa). **Nunca executa `DELETE`**, conforme exigido pelo §29.
- `lib/sales/service.ts`'s `cancelSale()` ganhou um guard: bloqueia o cancelamento comercial de uma venda enquanto a NF-e vinculada estiver `AUTHORIZED`, forçando a ordem "cancelar a NF-e primeiro, depois a venda" — é assim que a coordenação exigida pelo §29 ("se cancelamento afetar estoque, caixa ou venda, executar de maneira controlada, transacional e auditável") é garantida, sem duplicar a lógica de reversão de estoque que `cancelSale` já fazia.
- Novo comando relacional `fiscal.nfe.cancel` (`saleId` + `justification`), permissão `FISCAL_CANCEL`.
- **Limitação explícita, não escondida (idêntica à do Marco 3):** não foi possível verificar a estrutura exata do envelope SOAP `envEvento`/`NFeRecepcaoEvento4` nem confirmar contra uma fonte oficial ao vivo o `cStat` de sucesso adotado (135, "Evento registrado e vinculado a NF-e" — valor padrão amplamente documentado na comunidade de integração fiscal brasileira, mas não reverificado nesta sessão) — mesma causa raiz do Marco 3 (sem cadeia de certificação ICP-Brasil confiável neste sandbox, sem acesso ao Portal Nacional da NF-e). **Antes de qualquer cancelamento real**, confirmar contra o MOC 7.00 Anexo V com um certificado A1 de teste de verdade.
- Testes: `tests/fiscal.cancellation.test.ts` (10 testes) usam o mesmo padrão de `FiscalGateway` mock explicitamente identificado.
- 103/103 testes passavam neste ponto (`tests/*.test.ts`), `tsc --noEmit` sem erros.

## Fase 6 — Inutilização de Numeração (§25, implementado e validado — fecha a Fase 6)

- `lib/fiscal/inutilizacao.ts` (`buildInutilizacaoXml`): monta `<inutNFe>`/`<infInut>` (MOC 7.00 Anexo I), `Id` = cUF+ano(2)+CNPJ+modelo+série(3)+nNFIni(9)+nNFFin(9), validando CNPJ (14 dígitos), série (1–999), faixa (fim ≥ início) e justificativa (≥15 caracteres) — bloqueia em vez de aceitar dado incompleto, mesmo padrão do restante do módulo fiscal.
- `lib/fiscal/signer.ts` ganhou `signInutilizacaoXml()`: terceira variação da mesma rotina XMLDSIG (C14N, SHA-1, RSA-SHA1), assinando `<infInut>` e inserindo `<Signature>` antes de `</inutNFe>`.
- `lib/fiscal/gateway.ts` ganhou `FiscalGateway.inutilizeNumbering()`/`SefazDirectGateway.inutilizeNumbering()`: transmite o `<inutNFe>` assinado diretamente ao endpoint `NFeInutilizacao4` (sem envelope de lote, diferente de `enviNFe`/`envEvento`).
- Nova tabela `fiscal_inutilizations` (`drizzle/0008_fiscal_inutilizacao.sql`) — tabela própria, não reaproveita `fiscal_events` porque este exige `fiscal_document_id NOT NULL` e a inutilização trata de números que nunca chegaram a ser um `fiscal_documents`.
- `lib/fiscal/service.ts` ganhou `inutilizeFiscalNumbering()`: reaproveita a permissão `FISCAL_CANCEL` (não há código dedicado de inutilização no catálogo atual — mesma gravidade/irreversibilidade perante o Fisco; decisão de engenharia documentada, não um dado fiscal inventado). Nunca inutiliza um número já emitido (verifica `fiscal_documents` na faixa antes de agir) nem repete uma faixa já `CONFIRMED`. Interpreta `cStat`: **102** confirma (grava `status='CONFIRMED'`+`confirmed_at`+protocolo), qualquer outro cStat rejeita (nunca confirma sozinho, mesmo princípio do §27), falha de rede grava `status='ERROR'` e relança o erro. Grava a linha em `fiscal_inutilizations` antes de chamar a SEFAZ (status `PENDING`) e atualiza a mesma linha depois — nunca `DELETE`.
- Novo comando relacional `fiscal.nfe.inutilizar` (`storeId`+`series`+`numberStart`+`numberEnd`+`justification`), permissão `FISCAL_CANCEL`.
- **Limitação explícita, não escondida (idêntica à do Marco 3/§29):** não foi possível verificar a estrutura exata do envelope SOAP `NFeInutilizacao4` nem confirmar contra uma fonte oficial ao vivo o `cStat` de sucesso adotado (102, "Inutilização de número homologada" — valor padrão amplamente documentado, mas não reverificado nesta sessão) — mesma causa raiz dos demais marcos fiscais (sem cadeia ICP-Brasil confiável neste sandbox). **Antes de qualquer inutilização real**, confirmar contra o MOC 7.00 Anexo I com um certificado A1 de teste de verdade.
- Testes: `tests/fiscal.inutilizacao.test.ts` (8 testes) usam o mesmo padrão de `FiscalGateway` mock explicitamente identificado.
- **Com esta entrega, a Fase 6 (DANFE + cancelamento fiscal + inutilização de numeração) está concluída no backend.**
- 112/112 testes passam no total (`tests/*.test.ts`), `tsc --noEmit` sem erros.

## Fase 6 — UI das três funcionalidades (implementada)

- `lib/fiscal/service.ts` ganhou `listFiscalInutilizationsForSnapshot()`; `lib/domain.ts` reexporta `FiscalInutilizationSummary` e `Snapshot.state.fiscalInutilizations`; `app/api/workspace/route.ts`'s `fullState()` inclui esse mapa quando o ator tem `FISCAL_VIEW`.
- `app/workspace.tsx`, aba Vendas: coluna Fiscal passou a exibir o status real da NF-e (mapa `fiscalStatusLabel`) com ações por estado — **Transmitir** (`GENERATED`/`SIGNED`, chama `fiscal.nfe.transmit` — corrigindo uma lacuna funcional pré-existente: a UI só tinha o botão de gerar a NF-e, nunca o de transmiti-la à SEFAZ, então nenhuma NF-e conseguia sair de `GENERATED` pela interface antes desta mudança), **DANFE** (`AUTHORIZED`, abre `GET /api/workspace?danfe=<saleId>` em nova aba), **Cancelar NF-e** (`AUTHORIZED`, modal com justificativa ≥15 caracteres, chama `fiscal.nfe.cancel`) e **Nova tentativa** (`REJECTED`, chama `fiscal.nfe.generate` de novo). O botão de cancelamento comercial da venda vira um aviso "Cancele a NF-e antes" enquanto a NF-e estiver `AUTHORIZED`, refletindo visualmente o guard já existente em `cancelSale`. O modal de visualização da NF-e deixou de mostrar sempre "Gerada e Validada" e passou a exibir o status real, protocolo e data de autorização quando existirem.
- `app/workspace.tsx`, modal de Configuração fiscal da loja: nova seção "Inutilização de Numeração (§25)" (série/faixa/justificativa + botão, chama `fiscal.nfe.inutilizar`) com histórico das inutilizações da loja.
- **Verificação:** `tsc --noEmit` sem erros; app rodado localmente (`npm run dev`, configurado em `.claude/launch.json`) e aberto no navegador embutido — carrega e renderiza sem erros de console (o único erro de rede é o `401` esperado da chamada não autenticada, tratado normalmente pela tela de login). **Limitação explícita, não escondida:** não foi possível clicar nos novos botões logado, porque o login usa OAuth do ChatGPT (`/signin-with-chatgpt?return_to=/`), inacessível neste ambiente sandbox — mesma classe de limitação de rede já registrada para a comunicação real com a SEFAZ. Recomenda-se um teste manual completo (logado) antes de considerar a UI definitivamente validada.

## Fase 7 — NFC-e Modelo 65 (§20, backend implementado, UI pendente)

- `drizzle/0009_nfce_foundation.sql`: adiciona `csc_id`/`csc_encrypted`/`qrcode_base_url` a `fiscal_configurations` (reaproveita a mesma tabela, uma linha `model='65'` por loja).
- `lib/fiscal/qrcode.ts` (`buildNFCeQrCode`): URL de QR Code no formato offline com CSC (NT 2015.002) — `chave|versão|tpAmb|idCSC[|cDest]` + hash SHA-1 hex. A `qrCodeBaseUrl` é sempre configurada pelo usuário por loja (nunca hardcoded), porque varia por UF e eu não tinha uma fonte oficial verificada para as 27 UFs nesta sessão.
- `lib/fiscal/builder.ts` generalizado: `BuildNFeInput.model?: '55'|'65'`, `qrCode?`, `numericCode?` (permite calcular a chave de acesso antes do XML, necessário para o QR Code). Para modelo 65: sem `<idDest>`, `<tpImp>4</tpImp>`, grupo `<infNFeSupl><qrCode>` fora da assinatura (conforme NT 2015.002).
- `lib/fiscal/validator.ts` generalizado: `validateNFeXmlSchema(xml, expectedModel)`.
- `lib/fiscal/danfe.ts` ganhou `buildDanfeNfceHtml` — layout cupom com QR Code como link/texto (não imagem escaneável: sem biblioteca de renderização QR no projeto). Nunca reaproveita `buildDanfeHtml` (NF-e nunca tem QR Code, por design).
- Novo módulo `lib/fiscal/nfce.ts` (`saveNFCeStoreConfig`, `getNFCeStoreConfig`, `generateNFCeForSale`, `getNFCeDanfeData`) — separado de `lib/fiscal/service.ts` por decisão explícita do §20 ("compartilhar componentes comuns sem serem tratadas como exatamente o mesmo documento"). `transmitNFe`/`cancelNFeDocument` são reaproveitados sem alteração (já genéricos quanto ao `model`), confirmado por teste dedicado.
- `GET /api/workspace?danfe=<saleId>` detecta o `model` do documento e roteia para o builder de DANFE correto.
- Novos comandos `nfce.config.save`/`nfce.generate`; `fiscal.nfe.transmit`/`fiscal.nfe.cancel` já servem para NFC-e sem modificação.
- Testes: `tests/fiscal.nfce.test.ts` (10 testes).
- **UI (`app/workspace.tsx`):** card da loja ganhou badge de status da NFC-e e botão "Configuração NFC-e" (série/CRT/CSC/URL do QR Code, reaproveitando o certificado A1 da configuração de NF-e); aba Vendas ganhou botão "Gerar NFC-e" ao lado de "Gerar NF-e" no estado pendente, e os botões/rótulos de Transmitir/DANFE/Cancelar/Ver documento passaram a se adaptar ao modelo (`fDoc.model`) sem precisar de comandos novos, já que `fiscal.nfe.transmit`/`fiscal.nfe.cancel` e a rota de DANFE já eram genéricos quanto ao modelo.
- **Pendências explícitas, registradas e não escondidas:** contingência (§20) não implementada (exigiria fila/armazenamento offline inexistentes); inutilização de numeração (§25) não generalizada para modelo 65 (logo, sem UI própria); QR Code sem imagem escaneável (só link/texto); mesma limitação de verificação SOAP/QR ao vivo já registrada para os demais marcos fiscais.
- 122/122 testes passam no total (`tests/*.test.ts`), `tsc --noEmit` sem erros; app verificado no navegador local sem erros de console/servidor.

## Fase 8 — Escala (backend implementado, UI pendente)

Escopo definido pelo usuário via pergunta de esclarecimento nesta sessão (o usuário escolheu entre alternativas apresentadas, não uma decisão minha): fila fiscal assíncrona baseada em D1 (não Cloudflare Queues — sem `wrangler.toml` editável no repositório, o binding de uma fila real exigiria configuração de infraestrutura que eu não posso adivinhar), relatórios de vendas/caixa/fiscal, e AuditLog completo (§42) como base primeiro.

- **AuditLog (§42):** `drizzle/0010_audit_full.sql` adiciona `entity`/`entity_id`/`before_data`/`after_data`/`ip`/`correlation_id` a `audit_logs`. `lib/audit/service.ts` reescrito com `sanitizeForAudit` (redige chaves de segredo conhecidas antes de serializar `before`/`after`, mesmo se um chamador esquecer). `lib/relationalCommands.ts`'s `dispatchCommand` ganhou um `context` opcional `{ip, correlationId}` (retrocompatível) e um helper `audit()` que propaga isso e `entity`/`entityId`/`before`/`after` para quase todas as ~28 ações do dispatcher. `correlationId` reaproveita a chave de idempotência da requisição (já um UUID), sem inventar novo identificador. Cobertura de `before` é parcial (documentado como limitação — a maioria das ações só grava `after`).
- **Relatórios (`lib/reports/service.ts`):** `getSalesReport`, `getCashReport`, `getFiscalReport` — agregações somente-leitura (SUM/COUNT/GROUP BY) sobre `sales`/`sale_payments`/`cash_sessions`/`cash_movements`/`fiscal_documents` já persistidos, nenhuma regra de negócio nova. Exigem `REPORT_VIEW` (permissão já existente). Expostos via `GET /api/workspace?report=sales|cash|fiscal`.
- **Fila fiscal assíncrona (§41, `lib/fiscal/queue.ts`):** tabela `fiscal_jobs` (`drizzle/0011_fiscal_jobs.sql`). `enqueueFiscalJob` idempotente (chave `jobType:saleId`, `ON CONFLICT...DO UPDATE...WHERE status IN (terminal)` — só reenfileira se o job anterior já terminou). `runFiscalJobWorker` reivindica atomicamente (`UPDATE...WHERE id=(SELECT...)...RETURNING`, mesmo padrão de `lib/fiscal/sequence.ts`), recarrega o ator via `loadPermissions` a partir do `userId` salvo (nunca confia em permissões potencialmente desatualizadas), e reaproveita `transmitNFe`/`cancelNFeDocument` **sem nenhuma alteração**. Backoff exponencial (teto 30 min), dead-letter após `maxAttempts`. Proteção extra contra duplicidade (§41: "nunca retries cegos que possam gerar duplicidades"): se o job falha mas o documento já está no estado desejado (sucesso anterior não confirmado a tempo), o worker trata como sucesso em vez de tentar de novo. `getFiscalJobsSummary` dá observabilidade (contagem por status + dead-letters recentes). Novos comandos `fiscal.nfe.retry`/`fiscal.jobs.process`.
- **Limitação explícita, registrada e não escondida:** sem Cloudflare Cron Trigger real (o build da vinext gera o `wrangler.json` automaticamente, sem um arquivo editável no repo para eu configurar um trigger sem adivinhar), o worker só roda quando `fiscal.jobs.process` é chamado — manualmente pela UI (ainda não construída) ou por um agendador externo autenticado. Não há processamento em background automático nesta entrega. UI dos relatórios e da fila também não foi construída. "Otimização" e "dashboards" (§75) não foram abordados — fora do escopo que o usuário priorizou.
- Testes: `tests/audit.full.test.ts` (4), `tests/reports.test.ts` (6), `tests/fiscal.queue.test.ts` (7).
- 139/139 testes passam no total (`tests/*.test.ts`), `tsc --noEmit` sem erros.

## Fase 8 — UI (implementada)

- `app/workspace.tsx` ganhou a aba "Relatórios" com quatro painéis (Vendas, Caixa, Fiscal, Fila Fiscal/§41), carregados sob demanda via `GET /api/workspace?report=sales|cash|fiscal|fiscal-jobs` quando a aba é aberta, respeitando o filtro de loja do topo. O painel da fila mostra contagem por status, um botão "Processar fila agora" (admin, chama `fiscal.jobs.process`) e a lista de jobs em `DEAD_LETTER` com o último erro.
- `app/api/workspace/route.ts` ganhou a rota `?report=fiscal-jobs` (`getFiscalJobsSummary`).
- **Atualização posterior (mesmo dia):** botão "Reenfileirar" (aba Vendas, documentos `SIGNED`, chama `fiscal.nfe.retry`) e seletor de período De/Até (aba Relatórios, filtra o relatório de Vendas via `from`/`to`) foram adicionados, fechando as duas lacunas de UI que restavam.
- Verificação: `tsc --noEmit` sem erros; app rodado localmente e aberto no navegador embutido — carrega e renderiza sem erros de console/servidor; mesma limitação de OAuth do ChatGPT para testar o fluxo autenticado, já registrada nas Fases 6/7.
- 139/139 testes passam no total.

**Com esta entrega, a Fase 8 está concluída (backend + UI)**, com as ressalvas já registradas (sem Cron Trigger real, AuditLog before/after parcial, "otimização"/"dashboards" fora de escopo).

## Migração para VPS (ChatGPT Sites/Cloudflare removidos)

Pedido do usuário: remover tudo do "ChatGPT site" para subir numa VPS; escolhas dele: e-mail+senha, PostgreSQL, Next.js padrão em Node. As seções anteriores deste documento que descrevem D1/Cloudflare/OAuth do ChatGPT retratam o estado histórico.

- **Diagnóstico:** o acoplamento estava em três camadas — autenticação por headers do proxy do ChatGPT Sites (`app/chatgpt-auth.ts`), runtime/banco Cloudflare (`env.DB` via `cloudflare:workers`, vinext, wrangler, plugin vite vendorizado, `.openai/hosting.json`) e o tipo global `D1Database` do `@cloudflare/workers-types`. `next@16` já era dependência direta e `db/index.ts`/`db/schema.ts` (Drizzle) eram código morto.
- **Decisão de menor risco:** em vez de reescrever cerca de 20 módulos, `lib/db/pgAdapter.ts` implementa a mesma interface `D1Database` (`prepare/bind/first/all/run/batch`) sobre `pg.Pool` (`?`→`$n`; `batch` em transação; int8/numeric convertidos para `number`, pois o `pg` os devolve como string) e o tipo passou a ser declarado em `types/database.d.ts`. `RETURNING` e `ON CONFLICT ... DO UPDATE ... WHERE` já eram compatíveis. O único SQL específico de SQLite em `lib/` (`strftime` no relatório de vendas) foi substituído por agrupamento por dia em JS (UTC), portável entre os dois bancos.
- **Schema:** consolidado em `drizzle/0001_init.sql` (instalação nova, sem dados a migrar; `integer`→`bigint` porque o `integer` do Postgres tem 4 bytes e estouraria com `Date.now()`); seed de permissões/papéis espelha `lib/authz/`. A migração de dados JSON (antiga 0004) não foi portada por não haver dados legados.
- **Auth:** scrypt + sessão opaca em `sessions` (cookie HttpOnly/SameSite=Lax/Secure em produção); cadastro cria conta+dono+sessão atomicamente (`registerAccount`). Sem 2FA, recuperação de senha ou rate limit.
- **Verificação:** `tsc` limpo, `next build` OK, 144/144 testes (dublê SQLite). **Não verificado:** execução contra PostgreSQL real — é o primeiro risco a checar na VPS.

Este documento atende à primeira entrega exigida na seção 78. Descreve o estado observado e propostas; não afirma que os módulos propostos já existem. Nenhuma regra tributária, alíquota, classificação fiscal ou política comercial nova foi implementada nesta análise. A especificação do usuário prevalece sobre o README anterior e as decisões provisórias anteriores.

## 1. Arquitetura encontrada

Aplicação web única publicada privadamente por Sites, com React/Vinext e uma API agregada. `app/workspace.tsx` reúne navegação, cadastro, estoque, PDV, caixa, assinatura e impressão. `app/api/workspace/route.ts` concentra leitura, criação de conta e todos os comandos. `lib/domain.ts` concentra validação e operações comerciais. Não existem módulos backend independentes por domínio.

A persistência combina duas tabelas relacionais com um documento JSON por conta. O servidor lê e clona o estado inteiro, aplica a operação, registra auditoria/idempotência e substitui o JSON mediante comparação de revisão. Essa atualização é atômica, mas não é uma modelagem relacional dos domínios comerciais.

Evidências principais: `app/workspace.tsx`, `app/api/workspace/route.ts`, `lib/domain.ts`, `db/schema.ts`, `build/sites-vite-plugin.ts`, `.openai/hosting.json`.

## 2. Tecnologias utilizadas

Versões declaradas no projeto, não uma recomendação de atualizar dependências:

| Camada | Encontrado |
|---|---|
| Interface | React 19.2.6, TypeScript 5.9.3, Tailwind 4.2.1, componentes Shadcn/Radix, Lucide e Sonner |
| Framework/build | Vinext 1.0.0-beta.5, Vite 8.0.13, APIs compatíveis com Next 16.2.6 |
| Runtime publicado | Cloudflare Workers, integração Sites |
| Banco | Cloudflare D1, compatível com SQLite |
| Esquema/migrações | Drizzle ORM 0.45.2 e Drizzle Kit 0.31.10 |
| Consultas executadas | Prepared statements da API D1; `db/index.ts` oferece Drizzle, mas a rota usa `db/database.ts` |
| Payloads | Zod 3.25.76 |
| Testes | `node:test` e assertions nativas; script HTTP de integração local |
| Pacotes | npm com lockfile; Node declarado >=22.13, testes TypeScript executados anteriormente e nesta análise no Node disponível |

Manter stack, lockfile, integração de hospedagem e componentes reaproveitáveis durante a transição. A adequação não exige trocar framework ou banco de imediato. A viabilidade do banco/runtime para o volume comercial e processamento fiscal precisa ser demonstrada, não presumida.

## 3. Banco atual

- `accounts`: `id`, `name`, `state`, `revision`, `subscription_status`, `access_until`, `max_stores`, `created_at`.
- `memberships`: `user_id` como chave primária, `account_id` com FK, `role`, `store_id` e `display_name`.
- Uma migração publicada: `drizzle/0000_yielding_franklin_richards.sql`. Não a reescrever.
- Índice único `(account_id, user_id)` em memberships; `user_id` sozinho já é único.
- `store_id` não possui FK, pois lojas estão dentro do JSON. Não há CHECK de papel, estados, valores ou saldos nas entidades operacionais.
- Binding D1 `DB`; R2 não configurado. Não existe armazenamento de XML/certificados.

A revisão é global por conta: operações independentes de lojas diferentes disputam o mesmo registro. Arrays de vendas, auditoria e chaves crescem indefinidamente; leituras e gravações carregam o histórico inteiro. Isso precisa mudar antes de operação comercial em volume.

## 4. Entidades existentes

Entidades físicas: Account e Membership. Tipos/coleções no JSON: StoreRecord, Product, estoque por loja/produto, Cash, Sale com itens embutidos, Transfer com um único produto, Audit e requests de idempotência. Entitlement é uma projeção de três campos da conta.

Ausentes como entidades próprias: User, UserStore, Role/Permission, Customer, Supplier, Category, ProductFiscalProfile, Inventory relacional, StockMovement, StockTransferItem, SalePayment, CashRegister/CashMovement, NonFiscalReceipt, FiscalDocument e todos os componentes fiscais, Plan/PlanFeature/Subscription/UsageLimit, Notification e sessões da aplicação.

## 5. Autenticação atual

`app/chatgpt-auth.ts` lê identidade dos cabeçalhos autenticados do Sites e usa o login/logout da plataforma. A API recusa ausência de identidade. A associação à conta é buscada no servidor pelo userId, não recebida do navegador.

A aplicação não implementa senhas próprias, hash, refresh tokens, listagem/revogação de dispositivos ou 2FA. Não se conclui que a plataforma não os possua: suas garantias e os controles disponíveis para o SaaS não foram verificados nesta auditoria local. Cabeçalhos só podem ser confiados atrás do dispatcher autenticador; implantar o Worker diretamente como público sem essa fronteira seria inseguro.

O plugin tem identidade fixa de desenvolvimento (`local_seedy`) em loopback. Não faz parte do login publicado, mas precisa ser restrito ao harness de testes para atender literalmente à seção 79, que só permite mocks em testes. Não substituir o login real por uma identidade fictícia na migração.

## 6. Permissões atuais

O backend possui checks de `role === 'admin'` e comparação com uma única loja atribuída. O frontend repete decisões semelhantes. Não há catálogo centralizado, papéis exigidos, permissões por ação, concessões configuráveis ou usuários vinculados a várias lojas.

`visibleState` filtra vendas, caixas e auditoria por loja para não administradores, mas mantém todas as lojas e transferências do tenant. Consulta a estoque não deveria automaticamente conceder acesso a todos esses dados. Custos são substituídos por zero em vez de omitidos, o que confunde ausência de autorização com um valor financeiro real. Exportação não tem autorização específica de relatórios/auditoria.

Reaproveitar a resolução server-side da associação e a verificação de loja, mas substituir regras dispersas por autorização centralizada e projeções por recurso.

## 7. Fluxo atual de venda

1. Operador mantém carrinho temporário no navegador.
2. Envia itens, quantidades, forma única de pagamento e identificação textual opcional do cliente.
3. Backend valida payload, acesso vigente, loja, caixa aberto e saldo; obtém preço do próprio cadastro.
4. Calcula total em centavos, baixa estoque e registra venda, auditoria e chave de idempotência no mesmo estado.
5. API grava condicionalmente à revisão; conflito retorna erro para atualização.
6. Interface oferece impressão não fiscal ou nenhuma impressão. A impressão tem o título correto e registra solicitação; não comprova sucesso físico da impressora.

Faltam estados comerciais, pagamento separado/misto, descontos/autorização, cliente cadastrado, cancelamentos, devoluções, troco e coordenação fiscal. Toda venda recebe `fiscalStatus: pending`, apesar de não existir FiscalDocument. Isso mistura conceitos e não comprova obrigação de emissão nem pedido de documento fiscal. Não há entidade NonFiscalReceipt nem `document_type = NON_FISCAL_RECEIPT`.

## 8. Fluxo atual de estoque

Saldo em `stock[storeId][productId]`. Entradas administrativas somam; vendas subtraem. Quantidades são inteiros positivos validados no backend; a interface também rejeita frações. Transferência administrativa remove da origem e cria estado `transit`; confirmação soma no destino e muda para `received`.

A permanência em trânsito é intencional, não uma falha parcial: saldo e estado da transferência são gravados juntos. A recepção também é atômica. Falta ledger com quantidade anterior/nova, tipos, referências e atores completos. A auditoria textual não substitui StockMovement. Transferências não têm múltiplos itens, aprovação, cancelamento ou todos os estados do documento.

## 9. Funcionalidades implementadas e reaproveitáveis

- Interface web responsiva e componentes reutilizáveis; Windows segue fora do escopo atual.
- Cadastro de lojas e produtos; consulta de saldo por loja; entrada e transferência em trânsito/recebimento.
- PDV simples, caixa por loja/operador, fechamento com diferença de dinheiro.
- Cálculo da venda no servidor, rejeição de saldo negativo na operação e gravação atômica por revisão.
- Chaves de idempotência e rejeição de reuso com payload diferente.
- Comprovante explicitamente não fiscal, sem chave, QR Code ou protocolo inventados.
- Validação Zod, prepared statements, rejeição de origem divergente, respostas sem cache para a API.
- Histórico e exportação dos dados retornados ao usuário.
- Validação de prazo/estado/limite de lojas no servidor.
- Conferência visual de preenchimento cadastral; não é habilitação fiscal.

## 10. Problemas funcionais e divergências diretas

| Achado | Exigência afetada | Correção proposta |
|---|---|---|
| Formulário assume Simples Nacional ao criar loja | §§37, 68 | Exigir seleção explícita; preservar informação existente sem presumir sua confirmação |
| Trial de 7 dias e 3 lojas fixos | §§43–45, instrução de não inventar | Plano/política configuráveis; valores comerciais dependem de definição do titular |
| CFOP no produto | §§8, 34–35 | Perfil/operação com contexto; migrar valor legado como informação não validada, sem aplicá-lo automaticamente |
| Fiscal apenas no frontend como checklist | §§18, 60, 67 | Validações autoritativas server-side, mantendo feedback visual |
| Sale.fiscalStatus sem documento | §§16, 26, 76–77 | Sale separado de FiscalDocument e NonFiscalReceipt; política de obrigatoriedade própria |
| Pagamento único e cartão genérico | §13 | SalePayment com tipos explícitos e soma consistente |
| Caixa sem terminal, sangria/suprimento ou ledger | §§14–15 | CashRegister, CashSession e CashMovement |
| Estoque sem ledger | §§6–7 | Inventory e StockMovement transacionais |
| Somente admin/operador | §4 | PermissionService e papéis exigidos; matriz de concessões explícita |
| Clientes/fornecedores/categorias ausentes | §§8–10 | Cadastros próprios com escopo de tenant |
| Formatação temporal fixa em São Paulo | §61 | Timezone configurado por loja e conversões centralizadas |
| Conversão decimal via Number/Math.round no browser | §62 | Parser monetário decimal determinístico; servidor mantém representação apropriada |

Os valores já registrados não serão reinterpretados nem removidos para encaixar a especificação. Identificar dados legados e pedir confirmação quando a procedência não permite determinar o valor correto.

## 11. Riscos de segurança

- RBAC incompleto e excesso de dados de outras lojas na resposta. Aplicar menor privilégio por recurso, ação e escopo.
- Isolamento entre empresas tem uma base favorável (consulta de membership por identidade); ainda não possui teste integrado com duas empresas e manipulação de IDs. Não afirmar vazamento entre tenants sem evidência, nem afirmar proteção absoluta sem esse teste.
- Não há rate limiting próprio; o limite de tamanho é verificado depois de ler todo o corpo da requisição. Crescimento do JSON pode amplificar consumo de CPU/memória.
- Não há gestão de sessões, reautenticação, MFA ou trilha de login implementadas pela aplicação. Verificar cobertura do provedor e requisitos da especificação antes de expor o SaaS a clientes.
- Auditoria é regravada no mesmo JSON; não existe proteção de append-only no banco, before/after ou correlation ID.
- Fingerprints de idempotência guardam o comando serializado, incluindo dados de cliente, indefinidamente. Usar hash canônico e dados mínimos, com retenção definida.
- Em replay, o domínio retorna antes da autorização da ação. A resposta é filtrada pela associação atual, mas o desenho futuro deve revalidar acesso ao resultado e estado da associação antes de recuperar resultado anterior.
- Não existe comprovação de backup/restauração, política de retenção ou testes de upload/segredos porque esses módulos ainda não existem.
- Nenhum teste de invasão, auditoria de dependências ou inspeção de infraestrutura de produção foi realizado nesta etapa.

## 12. Riscos de arquitetura e impacto das mudanças

| Problema | Por que mudar | Impacto | Solução proposta |
|---|---|---|---|
| JSON operacional por conta | Sem FKs/CHECKs por domínio; crescimento e contenção globais | Migrar dados, comandos e consultas preservando IDs e resultados | Tabelas normalizadas e migração por tenant com reconciliação |
| Controller e componente concentrados | Alteração fiscal/comercial interfere em outras áreas | Extrair serviços e componentes sem refazer o layout | Monólito modular com contratos claros |
| Membership usa userId como PK | Uma associação por identidade e uma loja atribuída | Evoluir relações sem duplicar identidades | User, TenantMembership e UserStore |
| Auditoria e pagamentos embutidos | Difícil reconciliar, consultar ou proteger histórico | Acrescentar eventos e referências | Ledgers e eventos append-only |
| Fiscal sem módulo | Não comporta ciclo real, certificados, versões e reenvios | Criar interfaces e estados sem fingir autorização | Fiscal modular e gateways server-side |
| Planos fixos | Não comporta assinatura comercial verificável | Configuração e integração externas | EntitlementService e ciclo de cobrança auditável |

Não se propõe microserviços nem troca de stack por padrão. Preservar a experiência existente e os invariantes corretos. Se testes demonstrarem inadequação do runtime/banco ao processamento fiscal ou volume, registrar uma decisão técnica específica antes de migrar infraestrutura.

## 13. Diferenças entre o projeto atual e a especificação (lista consolidada de gaps)

Consolida os achados das seções 3–12 em formato de checklist, para acompanhamento de execução. "Ausente" significa que não existe hoje; não significa que será implementado de uma vez.

| Área da especificação | Situação atual | Gap |
|---|---|---|
| §2 Multitenancy | 1 tenant = 1 JSON; isolamento por membership | Falta modelagem relacional por domínio com FK de tenant em toda tabela nova |
| §3 Empresas/lojas | StoreRecord dentro do JSON, sem FK | Falta tabela `stores` própria, matriz/filial, configuração fiscal por loja |
| §4 RBAC | `role==='admin'` disperso, 1 loja por usuário | Falta Role/Permission catalogados, `UserStore` N:N, PermissionService central |
| §5–7 Estoque/transferência | Mapa `stock[store][product]`, `Transfer` com 1 produto e 2 estados | Falta `Inventory` relacional, `StockMovement` (ledger completo), `StockTransfer`/`StockTransferItem` com estados DRAFT→RECEIVED |
| §8 Produtos | Um só tipo com campos comerciais e fiscais misturados; CFOP no produto | Falta separar `Product` de `ProductFiscalProfile`; CFOP deve vir de regra de operação, não do cadastro |
| §9–10 Clientes/fornecedores | Cliente é texto livre (`customer`/`document`); fornecedor inexistente | Falta `Customer` e `Supplier` como entidades próprias com validação de documento |
| §11–13 PDV/comprovante | Fluxo funcional; comprovante corretamente rotulado "não fiscal" | Falta `NonFiscalReceipt` como entidade própria (hoje é só o `Sale` com campo `document`) |
| §14–15 Caixa/sangria | Abertura/fechamento por operador e loja; sem terminal | Falta `CashRegister` (terminal), `CashSession` distinto de `CashRegister`, `CashMovement` (sangria/suprimento) |
| §16–17 Venda/status | `Sale` tem `fiscalStatus:'pending'` fixo, sem `FiscalDocument` | Falta separar Sale/FiscalDocument/NonFiscalReceipt; falta state machine de venda (DRAFT…REFUNDED) |
| §18–30 Módulo fiscal | `lib/fiscal.ts` é só checklist de preenchimento local | Módulo `fiscal/` completo inexistente: TaxEngine, DocumentBuilder, Signer, Gateway, FiscalDocument/Event/Error/Sequence, Certificate |
| §31 Idempotência | Existe para o comando genérico (`requests[key]`) | Adequado como padrão; precisa ser extendido a emissão fiscal quando essa existir |
| §32–33 Transação/concorrência | Escrita condicional por `revision` (otimista) no JSON inteiro | Ao normalizar em tabelas, recriar atomicidade por transação SQL e locking por (tenant, store, product) |
| §37–39 Regime/reforma tributária | Regime é um campo de texto na loja, não usado por motor algum | Falta `TaxEngine`, `TaxRuleVersion`, `FiscalSchemaVersion` |
| §42 Auditoria | Lista dentro do JSON da conta, sem correlation ID nem IP | Falta `AuditLog` append-only próprio, com before/after estruturado |
| §43–45 Assinatura SaaS | 3 campos na `accounts` (`subscription_status`, `access_until`, `max_stores`) | Falta `Subscription`, `Plan`, `PlanFeature`, `UsageLimit`, `EntitlementService` |
| §46–49 Segurança avançada | Auth via cabeçalho da plataforma; sem 2FA, sem gestão de sessão própria | Depende de validar o que a plataforma de hospedagem já oferece antes de decidir o que construir |
| §55 Exclusão | Não há hard delete nas operações implementadas | Manter esse princípio ao normalizar (usar status, não DELETE) |
| §62 Dinheiro | `cents:number` inteiro (correto), mas front usa `Number`/`Math.round` em alguns pontos | Confirmar que toda conversão decimal↔centavos é centralizada num único parser |

## 14. Estrutura de banco proposta (incremental, não substitutiva)

Objetivo: migrar do documento único por conta para tabelas relacionais, mantendo os dados e IDs já emitidos. Proposta de ordem de criação (cada uma pode ser uma migration Drizzle isolada e reversível):

**Fase 2.1 — Identidade e RBAC** (sem tocar em dados operacionais ainda)
```
tenants (renomeia accounts; mantém id, name, subscription_status, access_until, max_stores, created_at)
users (id, external_auth_id, display_name, created_at) — desacopla identidade do vínculo
roles (id, tenant_id, name, is_system)
permissions (id, code)               -- catálogo fixo: STORE_VIEW, PRODUCT_EDIT, ...
role_permissions (role_id, permission_id)
user_tenant_roles (user_id, tenant_id, role_id)     -- substitui memberships.role
user_stores (user_id, store_id)                     -- N:N, substitui memberships.store_id único
```
Migração de dados: 1 membership → 1 user + 1 role padrão (mapeada de `role` atual) + 1 user_store (se `store_id` não nulo). Reversível: manter `memberships` como view/tabela sombra até validação em produção.

**Fase 2.2 — Catálogo e estoque**
```
stores (id, tenant_id FK, nome/fantasia, razão social, cnpj, ie, endereço, regime_tributario, timezone, config_fiscal_json, created_at)
categories (id, tenant_id, name)
products (id, tenant_id, sku, barcode, name, category_id, unit, cost_price, sale_price, min_stock, active, image_url)
product_fiscal_profiles (id, product_id FK unique, ncm, cest, origin, taxable_gtin, tax_profile_id)
inventories (id, tenant_id, store_id FK, product_id FK, quantity, UNIQUE(store_id, product_id))
stock_movements (id, tenant_id, store_id, product_id, type, quantity, previous_quantity, new_quantity, reference_type, reference_id, user_id, created_at)
stock_transfers (id, tenant_id, from_store_id, to_store_id, status, requested_by, approved_by, received_by, created_at, ...)
stock_transfer_items (id, transfer_id FK, product_id, quantity)
```
Migração: `stores`/`products` do JSON viram linhas; `stock[store][product]` vira `inventories` + 1 `stock_movements` do tipo `INITIAL` por saldo existente (preserva rastreabilidade desde o dia da migração, sem inventar histórico anterior).

**Fase 2.3 — PDV/caixa**
```
cash_registers (id, tenant_id, store_id, name/terminal)
cash_sessions (id, tenant_id, cash_register_id FK, user_id, opened_at, opening_amount, closed_at, expected_amount, counted_amount, difference)
cash_movements (id, tenant_id, cash_session_id FK, type[SUPPLY|WITHDRAWAL], amount, reason, user_id, created_at)
customers (id, tenant_id, doc_type, doc_number, name, ie, email, phone, address_json)
suppliers (id, tenant_id, doc_number, name, ie, contact_json)
sales (id, tenant_id, store_id, cash_session_id, user_id, customer_id NULL, status, subtotal, discount, total, created_at)
sale_items (id, sale_id FK, product_id, name_snapshot, sku_snapshot, qty, unit_price, discount)
sale_payments (id, sale_id FK, method, amount)
non_fiscal_receipts (id, sale_id FK unique, printed_count, footer_text)
```

**Fase 4 — Fiscal** (só ao entrar na Fase 4 do plano, seção 15 abaixo)
```
fiscal_configurations (id, tenant_id, store_id, environment[HOMOLOGATION|PRODUCTION], series, next_number_by_model, csc_id, csc_token_ref)
fiscal_sequences (tenant_id, store_id, model, series, environment, last_number) -- obtenção transacional
certificates (id, tenant_id, store_id, encrypted_blob_ref, holder, expires_at, created_at) -- nunca a senha em claro
fiscal_documents (id, tenant_id, store_id, sale_id, model[55|65], series, number, environment, status, access_key, protocol, xml_sent_ref, xml_authorized_ref, created_at)
fiscal_document_items (id, fiscal_document_id FK, sale_item_id, cfop, cst/csosn, ...)
fiscal_events (id, fiscal_document_id FK, type[AUTHORIZATION|CANCELLATION|...], protocol, request_ref, response_ref, created_at)
fiscal_errors (id, fiscal_document_id FK, code, message, request_ref, response_ref, attempt, created_at)
fiscal_schema_versions (id, model, version, effective_from)
tax_rule_versions (id, version, effective_from, description)
```

**Fase 1/8 — Assinatura e auditoria** (pode ser feita cedo, é independente do resto)
```
plans (id, code, name)
plan_features (plan_id FK, feature_code, limit_value NULL)
subscriptions (id, tenant_id FK unique, plan_id FK, status, current_period_end, grace_period_end)
audit_logs (id, tenant_id, store_id NULL, user_id, action, entity_type, entity_id, before_json, after_json, ip, correlation_id, created_at)  -- somente INSERT
```

Todas as tabelas novas carregam `tenant_id` obrigatório com FK e índice; toda query de aplicação deve filtrar por `tenant_id` vindo da sessão autenticada no servidor, nunca do payload do cliente.

## 15. Arquitetura de backend proposta

Manter o monólito Next/Vinext atual (não introduzir microserviços). Extrair de `app/api/workspace/route.ts` e `lib/domain.ts` para módulos por domínio, com um `route.ts` fino por recurso, seguindo os caminhos já sugeridos pela especificação (§59):

```
lib/
  auth/            (identidade + resolução de tenant, reaproveita chatgpt-auth.ts)
  authz/           (PermissionService central; catálogo de permissions; checagem por ação)
  tenancy/         (contexto de tenant obrigatório em toda query)
  catalog/         (Product, Category, ProductFiscalProfile)
  inventory/       (Inventory, StockMovement, StockTransfer — regras transacionais)
  sales/           (Sale, SaleItem, SalePayment, NonFiscalReceipt, state machine)
  cash/            (CashRegister, CashSession, CashMovement)
  fiscal/          (módulo isolado, ver seção 16)
  billing/         (Subscription, Plan, EntitlementService)
  audit/           (AuditLog append-only, correlation ID)
app/api/v1/
  stores/, products/, inventory/, transfers/, customers/, sales/,
  cash-sessions/, fiscal/documents/, reports/, users/, subscription/
```

Cada módulo expõe funções de domínio puras e testáveis (como `lib/domain.ts` já faz bem hoje), e a camada de rota apenas: autentica → resolve tenant/loja → checa permissão → chama o serviço → serializa resposta. Isso preserva o que já funciona (validação Zod, prepared statements, checagem de origem, resposta sem cache) e resolve a concentração excessiva em um único arquivo.

Introduzir versionamento de API desde já (`/api/v1/...`), migrando gradualmente o endpoint único `/api/workspace` para os recursos específicos, sem quebrar o cliente atual durante a transição (endpoint antigo pode conviver até a migração do frontend).

## 16. Arquitetura fiscal proposta

Módulo `fiscal/` isolado, sem lógica fiscal no frontend, seguindo o pipeline conceitual da especificação (§18):

```
Sale → FiscalRequirementService (OPTIONAL/REQUIRED/NOT_APPLICABLE/BLOCKED)
     → FiscalService
     → TaxEngine (recebe TaxContext: issuer, customer, products, operation, origin, destination, taxRegime, date)
     → DocumentBuilder (monta estrutura do documento a partir de FiscalSchemaVersion vigente)
     → XML (gerado a partir de schema oficial, nunca hardcoded ad hoc)
     → SchemaValidator (contra XSD oficial da versão registrada)
     → Signer (usa CertificateService; nunca expõe certificado/senha)
     → FiscalGateway (interface FiscalProvider: issue/cancel/status)
     → SEFAZ
     → ResponseProcessor → FiscalDocument.status + FiscalEvent + FiscalError quando aplicável
```

`FiscalProvider` como interface permite `NFeProvider` e `NFCeProvider` hoje, e `NFSeProvider` no futuro, sem misturar regras municipais nas implementações atuais. `CertificateService` fica isolado com armazenamento criptografado (idealmente KMS/secret manager em produção), nunca retornando o certificado pela API.

Esta fase só deve ser iniciada quando o usuário confirmar tratamento explícito de: (a) qual PSP/gateway de transmissão será usado, (b) ambiente de homologação para os primeiros testes, (c) qual empresa/CNPJ real de testes será usada. Nenhuma regra tributária será presumida sem confirmação ou consulta à documentação oficial vigente (§67).

## 17. Arquitetura de assinatura (SaaS billing) proposta

```
Plan (BASIC/PRO/ENTERPRISE) → PlanFeature (feature_code, limit_value)
Subscription (tenant_id, plan_id, status: TRIAL/ACTIVE/PAST_DUE/SUSPENDED/CANCELLED/EXPIRED)
EntitlementService.canUse(tenant, "FISCAL_NFCE") → bool, checado no backend antes de qualquer operação sensível ao plano
```

Migração dos 3 campos atuais (`subscription_status`, `access_until`, `max_stores` em `accounts`) para essa estrutura preserva o comportamento hoje existente (`requireActive` em `lib/domain.ts`) como um caso particular do `EntitlementService`, sem quebrar a validação já feita no servidor. Estados de inadimplência (§45) devem preservar documentos fiscais e históricos mesmo em `SUSPENDED`.

## 18. Plano incremental de implementação

Seguindo a ordem sugerida pela própria especificação (§75), adaptada ao que já existe:

1. **Fundação SaaS (RBAC real)** — introduzir `users`, `roles`, `permissions`, `user_tenant_roles`, `user_stores` e `PermissionService`, migrando dados de `memberships` sem quebrar o login/rota atuais. Critério de saída: testes de isolamento entre tenants e de permissão por ação passando.
2. **Catálogo/estoque relacional** — introduzir `stores`, `products`, `product_fiscal_profiles`, `inventories`, `stock_movements`, `stock_transfers`/`items`, migrando o JSON existente com preservação de IDs. Critério de saída: teste de concorrência (dois caixas vendendo o último item) passando com locking real.
3. **PDV/caixa relacional** — `cash_registers`, `cash_sessions`, `cash_movements`, `customers`, `suppliers`, `sales`/`sale_items`/`sale_payments`/`non_fiscal_receipts`, com state machine de venda. Critério de saída: paridade funcional com o fluxo atual + pagamento misto + sangria/suprimento.
4. **Fundação fiscal** — `fiscal_configurations`, `certificates` (CertificateService), `fiscal_sequences`, `TaxEngine` inicial, `fiscal_schema_versions`/`tax_rule_versions`, ambiente de homologação. Nenhuma emissão real ainda.
5. **NF-e (homologação)** — 1 empresa, 1 loja, 1 produto, homologação, XML válido, assinatura, envio, autorização, protocolo.
6. **Expansão NF-e** — múltiplos produtos/clientes, rejeições, cancelamentos, inutilização, DANFE completo.
7. **NFC-e** — modelo 65, QR Code, CSC, contingência.
8. **Escala** — filas/workers para o pipeline fiscal, observabilidade, relatórios e dashboards agregados.

Cada fase é reversível e não remove funcionalidade existente antes de a substituta estar validada por teste. Nenhuma fase fiscal (4–7) começa sem confirmação do usuário sobre gateway de transmissão, dados de homologação e regras tributárias aplicáveis não presumidas.


## Deploy Docker + Traefik (omnihub.adapterco.com.br)

- `docker-compose.yml`: serviço `web` (build do `Dockerfile`, porta interna 3017, redes `omnihub_internal` + `traefik9` externa) e `db` (postgres:16-alpine, volume `omnihub_pgdata`, só rede interna). Labels Traefik no padrão dos demais projetos da VPS (`https-redirect`, `certresolver=letsencrypt`, `traefik.docker.network=traefik9`), roteadores `omnihub-web(-http)`.
- Segredos (`POSTGRES_PASSWORD`, `FISCAL_SECRET_KEY`) obrigatórios via `.env` (compose falha sem eles); `.env.example` versionado sem valores.
- Risco tratado: atrás do Traefik o Next vê `http://` interno enquanto o navegador envia `Origin: https://...`; a checagem anti-CSRF (`isSameOrigin`, `app/auth.ts`) compara também com `x-forwarded-host/proto`.
- Não validado: build da imagem e subida real (sem Docker no ambiente de desenvolvimento). Imagem mantém `node_modules` completo porque o Next precisa de TypeScript para ler `next.config.ts`.


## Auditoria pós-deploy em PostgreSQL real (2026-09-18)

**Método:** PostgreSQL 16 real (embedded, UTF-8) + `npm run db:migrate` + app em produção (`next start`) + fluxo HTTP completo + suíte inteira via `TEST_DATABASE_URL`.

**Bugs encontrados e corrigidos**
1. **Apelidos camelCase (crítico):** Postgres faz case-folding de identificadores sem aspas → `row.userId` `undefined` em ~190 consultas. Sintomas: cadastro "funcionava" mas a conta não era achada (401 → volta ao login sem mensagem) e login sempre falhava (`passwordHash` `undefined`). Correção central no adaptador.
2. **Pool sem handler de erro:** queda/restart do PostgreSQL derrubaria o processo. Corrigido (+ `DATABASE_POOL_MAX`).
3. **`?report=sales&from=abc`:** virava 503 (`bigint "NaN"`); agora 400.
4. **`pgAdapter.ts` com parameter properties:** incompatível com o Node em modo strip-only (testes); reescrito.

**Melhorias pendentes (não implementadas)**
- Segurança: rate limit/bloqueio de login e cadastro; limite de tamanho de senha (scrypt síncrono bloqueia o event loop e é vetor de DoS — usar `scrypt` assíncrono); cadastro aberto ao mundo (avaliar convite/captcha/verificação de e-mail); recuperação de senha; 2FA (§48); limpeza periódica de `sessions` expiradas; IP de auditoria vem de `cf-connecting-ip`/`x-forwarded-for` (forjável — confiar só no proxy); cabeçalhos de segurança (CSP, HSTS, X-Frame-Options, Referrer-Policy) no Traefik ou `next.config.ts`.
- Dependências (`npm audit --omit=dev`): `next` (crítico, bypass de middleware/proxy com Turbopack — o projeto não usa middleware, exposição baixa; corrigido em next@16.3.5), `postcss`/`sharp` (via next), `nanoid`, `baseline-browser-mapping`. Atualizar o Next e reexecutar build/testes.
- Operação: `healthcheck` do serviço `web` no compose; backup do volume `omnihub_pgdata` (pg_dump agendado); logs estruturados; migração roda a cada subida do container (ok para 1 réplica); `.env` com segredos fora do repositório.
- Código: `app/workspace.tsx` é um arquivo monolítico de linhas gigantes (manutenção difícil); `npm run lint` acusa 5 erros no arquivo (setState em effect, `Date.now()` no render, aspas sem escape) e ~3300 avisos (a maioria em `dist/`/`outputs/` — restringir o lint às pastas do código); alguns `catch` silenciosos na UI de relatórios.
- Banco: `ROLLBACK` que falha em `batch()` mascara o erro original; e-mail duplicado em cadastros simultâneos vira 503 genérico (índice único protege, mas a mensagem devia ser 409); `toPositionalSql` troca todo `?` (quebraria com `?` dentro de literal de texto no SQL).
- Relato do usuário "o navegador fecha sozinho": não há `window.close`/reload no código; não reproduzido. Investigar se persistir após o deploy (extensão/Brave/aba).


## Endurecimento de segurança (2026-09-18)

Implementado a partir da lista de melhorias da auditoria anterior: rate limit de login/cadastro (tabela `auth_rate_limits`), scrypt assíncrono + limite de 128 caracteres + hash fantasma, limpeza de sessões vencidas, `clientIp` confiável (`TRUSTED_PROXY_HOPS`), `REGISTRATION_ENABLED`, cabeçalhos de segurança/CSP (`next.config.ts`), Next 16.3.5 + `npm audit fix` (0 vulnerabilidades). Riscos residuais: bloqueio de e-mail por terceiros (DoS de conta por 15 min); CSP mantém `'unsafe-inline'` (Next injeta scripts inline; nonce exigiria renderização dinâmica); sem recuperação de senha, verificação de e-mail e 2FA (dependem de SMTP/decisão do usuário); sem CAPTCHA no cadastro. Se houver Cloudflare na frente do Traefik, definir `TRUSTED_PROXY_HOPS=2`.


## Operação e correção de fuso (2026-09-18)

**Achados corrigidos.** (1) `dhEmi` (builder) e `dhEvento` (cancelamento) faziam `toISOString().replace(Z, "-03:00")`: mantinham a hora UTC e só trocavam o rótulo, gravando a emissão 3 h à frente — a SEFAZ rejeita data de emissão posterior ao recebimento. (2) O AAMM da chave (`keys.ts`) e o ano da inutilização (`service.ts`) usavam `getFullYear/getMonth` do relógio do servidor (UTC no Docker): nota das 23h do último dia do mês ficava com o mês seguinte na chave. (3) O relatório de vendas agrupava por dia UTC (venda às 23h29 aparecia no dia seguinte) — achado numa passada real na interface. Correção central em `lib/time.ts` (`isoWithOffset`, `localParts`, `dayKey`, fuso `America/Sao_Paulo`, offset calculado). Risco residual: o fuso é único para o sistema (lojas em AM/AC/MT etc. teriam offset diferente; hoje o projeto já assumia Brasília no comprovante/DANFE/painel — decisão a revisar se houver lojas fora do horário de Brasília).

**Operação (§56/§57).** Health check, logs estruturados com redação, backup automático com validação e retenção segura, teste de restauração em banco temporário. Limitações honestas: `pg_dump`/`pg_restore` não existiam no ambiente de desenvolvimento — a lógica dos scripts foi testada com ferramentas simuladas (`tests/backup.scripts.test.ts`); o primeiro `restore-test.sh` na VPS é o teste real. Backup fica no mesmo servidor até alguém copiar para fora (manual, documentado). Sem métricas/alertas ativos (só logs e healthcheck).


## Descontos e devoluções (2026-09-19)

**Decisões.** (1) §53 não define X%/Y%: nenhum percentual foi assumido — limite ausente = 0%, só o OWNER é ilimitado; papéis configuráveis: ADMIN, GERENTE, OPERADOR_CAIXA. (2) `SALE_DISCOUNT` é a alçada de *autorizar* desconto de outros; desconto próprio depende só do limite do papel. (3) Supervisor = outro usuário da mesma conta, com `SALE_DISCOUNT` e limite suficiente, identificado por e-mail+senha (padrão de PDV), com o mesmo bloqueio por tentativas do login. (4) `sales.total` é o líquido; bruto = total + desconto. (5) Devolução ≠ cancelamento ≠ estorno ≠ cancelamento fiscal (§54): fluxos separados, sem hard delete.

**Achados corrigidos no caminho.** (a) `saveDiscountLimits` gravava item a item antes de validar a lista (limite salvo pela metade) — agora valida tudo e grava em transação (o teste pegou). (b) O validador de schema comparava `vNF` com a soma dos produtos e reprovaria qualquer nota com desconto. (c) `fingerprint` da idempotência guardava o comando inteiro em texto no banco — agora é SHA-256 (a senha de supervisor trafega no comando). (d) A emissão fiscal presumia pagamento `Dinheiro` sem linhas de pagamento — dado inventado removido, agora bloqueia. (e) Listagem de vendas do snapshot fazia 2 consultas por venda; agora 4 consultas em lote.

**Riscos e pendências.** Nota fiscal de devolução (finNFe=4) não existe: venda com documento ativo não pode ser devolvida. Auditar valores fiscais padrão ainda no builder: `tPag` de 'Cartão' presumido como crédito (03) sem distinguir débito, `natOp` padrão, `nro 'SN'`, `indPres`/`indFinal` fixos. Desconto só no total da venda (não por item). Limite de desconto é por conta/papel, não por loja. Estorno em Pix/cartão é só registro (conciliação fora do sistema). Migração `0003` validada em PostgreSQL real.
