# Análise inicial e plano de adequação ao instrucoes.md

Data: 16/09/2026. Referência normativa: `../instrucoes.md`, seções 1–79. Base de código examinada: commit `86521ce7f5eb3318cc3092fff135dac1cdfb2a79`, mais o arquivo de instruções fornecido pelo usuário.

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
