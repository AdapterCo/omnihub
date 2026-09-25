# OmniHub Web

Primeira versão funcional privada para validar a gestão de lojas. Windows fica fora desta etapa.

## Implementado

- Login por e-mail e senha (hash scrypt) com sessão em cookie HttpOnly validada no banco (`lib/auth/`, `app/api/auth/`). Cada conta (tenant) é criada no cadastro; papel e loja ficam no servidor.
- RBAC centralizado (Fase 1, `lib/authz/`): catálogo de permissões e papéis de sistema (OWNER, ADMIN, GERENTE, OPERADOR_CAIXA, ESTOQUISTA, CONSULTA) normalizados em tabelas próprias (`users`, `roles`, `permissions`, `role_permissions`, `user_tenant_roles`, `user_stores`), com backfill automático dos vínculos existentes em `memberships`. As checagens de mutação em `lib/domain.ts` usam permissões (`STORE_CREATE`, `PRODUCT_EDIT`, `STOCK_ADJUST`, `STOCK_TRANSFER`, ...), não mais `role === 'admin'` espalhado.
- Catálogo e estoque relacionais (Fase 2, `lib/catalog/`, `lib/inventory/`), **conectados ao PDV** (corte/cutover concluído): tabelas `stores`, `categories`, `products`, `product_fiscal_profiles`, `inventories`, `stock_movements`, `stock_transfers`, `stock_transfer_items`. Ajuste de estoque atômico via `UPDATE ... RETURNING` protegido por `CHECK (quantity >= 0)` no banco (sem janela de corrida em vendas concorrentes pelo último item); ledger completo de movimentações; ciclo de transferência com os 6 estados de §7 (o PDV usa `store.create/product.create/stock.receive/transfer.create/transfer.receive` como antes — a mudança é só no que acontece no servidor).
- Caixa e venda relacionais (Fase 3, `lib/cash/`, `lib/sales/`), também conectados ao PDV: tabelas `cash_registers` (terminal), `cash_sessions`, `cash_movements` (sangria/suprimento — **novo**, §15), `sales`, `sale_items`, `sale_payments`, `non_fiscal_receipts`. `lib/domain.ts`'s antigo `execute()`/`State` (que processava caixa/venda sobre um JSON) foi removido — não sobrou nenhum comando fora do modelo relacional. Venda e baixa de estoque agora cabem num único `db.batch()` (verdadeiramente atômico: venda + itens + pagamentos + comprovante + estoque, tudo ou nada).
- Pagamento misto (§13): `sale.create` aceita `payments: {method,amount}[]` além do `payment` único de sempre (soma validada contra o total). Sangria/suprimento (`cash.supply`/`cash.withdrawal`) entram no fechamento de caixa. Cancelamento de venda (`sale.cancel`) devolve o estoque. As três capacidades têm tela própria no frontend (múltiplas linhas de pagamento na Frente de caixa; suprimento/sangria e cancelamento nas telas de Caixas/Vendas).
- Idempotência (`command_idempotency`) e auditoria (`audit_logs`) cobrem todos os tipos de comando, já que nenhum vive mais em `state.requests`/`state.audit` do JSON.
- Gestão de usuários (Fase 1, `lib/users/`): aba **Equipe** para atribuir/remover papel e lojas de um membro (`user.assign`/`user.remove`), sincronizando `users`/`user_tenant_roles`/`user_stores` e `memberships`.
- Clientes e fornecedores (`lib/customers/`): cadastro relacional (`customers`, `suppliers`) com isolamento por tenant, RBAC próprio (`CUSTOMER_*`/`SUPPLIER_*`) e telas dedicadas; autocompleção de cliente na Frente de caixa.
- Fundação fiscal direta (Fase 4, `lib/fiscal/`): sem gateway/intermediário terceirizado — comunicação direta com os Web Services oficiais da SEFAZ. Certificado A1 (upload, parse PKCS#12, criptografia em repouso AES-256-GCM com chave obrigatória via `FISCAL_SECRET_KEY`, sem fallback no código), numeração fiscal atômica por loja/série, chave de acesso de 44 dígitos (Módulo 11), builder de XML NF-e 4.00, validador contra schema XSD (PL_009k), assinatura XMLDSIG e teste de conectividade (`NFeStatusServico4`) — tudo restrito a Homologação (produção bloqueada em código).
- Fase 5 (`fiscal.nfe.generate`/`fiscal.nfe.transmit`): gera a NF-e a partir de uma venda (bloqueia se faltar CNPJ/IE/UF/endereço da loja, NCM/CFOP/CST-CSOSN/origem do produto ou configuração fiscal da loja — nunca presume esses valores, §36/§37), assina e transmite para o autorizador oficial em Homologação, interpretando `cStat` da resposta (autoriza só com `cStat 100`; qualquer outro código rejeita, nunca autoriza sozinho, §27). Testado com um `FiscalGateway` mock explicitamente identificado como tal — **a estrutura exata do envelope SOAP não foi verificada contra uma fonte oficial ao vivo nesta sessão** (limitações de rede/certificado do ambiente de desenvolvimento); confirmar contra o MOC 7.00 Anexo II antes de qualquer emissão real.
- Várias lojas por conta; dados cadastrais/fiscais preparatórios por loja e produto.
- Catálogo compartilhado, estoque separado e consulta entre lojas.
- Entradas de estoque e transferências restritas ao administrador. Transferência sai da origem, permanece em trânsito e entra no destino após confirmação.
- Caixa por loja e operador, abertura e fechamento com diferença de dinheiro (agora com sangria/suprimento no cálculo). Operadores não movimentam outras lojas nem caixa/venda de outro operador.
- Venda com preço calculado pelo servidor, estoque validado e caixa aberto obrigatório. Pagamento único em dinheiro, Pix ou cartão registrado manualmente (ou dividido, via API).
- Comprovante com o título exato COMPROVANTE NÃO FISCAL. Reimprimir não altera estoque nem situação fiscal.
- Histórico e exportação JSON dos dados autorizados.
- Avaliação de 7 dias, limite de 3 lojas e bloqueio no servidor. Não há endpoint para o cliente alterar plano, validade ou limites.
- Depois do vencimento, são permitidos consulta, exportação, impressão, fechamento de caixa e confirmação de transferências já iniciadas.

## Limites desta primeira entrega

Esta é uma base de validação, não um sistema fiscal homologado nem uma assinatura comercial pronta para venda.

- NF-e modelo 55 (geração, assinatura e transmissão em Homologação) está implementada e testada com mock, mas **não validada contra o serviço real da SEFAZ** — ver ressalva na seção acima. NFC-e (modelo 65), cancelamento fiscal e inutilização ainda não foram implementados. Nenhuma regra tributária (alíquota, CFOP, CST/CSOSN) é presumida: dado obrigatório ausente bloqueia a emissão.
- Cobrança recorrente, checkout, notificações autenticadas do provedor, conciliação de pagamentos, estornos e reativação ainda dependem da escolha e configuração do provedor. Não há cobrança real ou botão de ativação simulada.
- O esquema RBAC suporta os 6 papéis de §4 e múltiplas lojas por usuário (`user_stores`), com aba **Equipe** para atribuir/remover papel e lojas de um membro. Login comercial (convite por e-mail, senha própria) ainda depende da identidade do Sites/ChatGPT — não é um cadastro de usuário independente.
- Preço é compartilhado entre lojas nesta versão. Preços por loja, devoluções parciais e comissões ficam para as próximas etapas. Pagamento dividido, sangria/suprimento e cancelamento de venda já têm backend e tela (ver acima).
- Catálogo/estoque (Fase 2) e caixa/venda (Fase 3) relacionais já são a fonte de verdade do PDV (corte concluído nas duas). Falta interface para categorias e o fluxo de transferência multi-item (hoje só o essencial está ligado ao PDV); rota `/api/v1/...` dedicada também não existe, o PDV ainda fala com o endpoint único `/api/workspace`.
- `lib/catalog`/`lib/inventory` (loja/produto/estoque/transferência) ainda não restringem operação por loja (checam só permissão, não `actor.storeId`) — diferente de `lib/cash`/`lib/sales` (Fase 3), que já restringem. Não regride nada hoje porque só existem usuários OWNER e OPERADOR_CAIXA; precisa ser resolvido antes de haver convite para ESTOQUISTA/GERENTE.
- Não há modo offline. O carrinho é temporário e não sobrevive ao fechamento/recarregamento do navegador. Operações confirmadas ficam no banco.
- `accounts.state`/`accounts.revision` (a persistência JSON original) não são mais lidos pela aplicação a partir da Fase 3 — todo o estado operacional é relacional. As colunas continuam existindo (não foram removidas, para evitar uma migração destrutiva sem necessidade imediata) mas sem uso funcional; `revision` agora só serve de contador de ordenação para o frontend, sem checagem condicional de conflito.
- A integração WebMCP de consulta é opcional e usa os mesmos dados já autorizados. Seu contrato não foi exercitado em um navegador com suporte nesta sessão. Não foi solicitado teste visual de navegador.

## Desenvolvimento e deploy (VPS)

Node >=22.13, npm, Next.js, React, TypeScript e **PostgreSQL**. Sem dependência de Cloudflare/ChatGPT Sites.

Variáveis de ambiente obrigatórias:

- `DATABASE_URL` — ex.: `postgres://usuario:senha@localhost:5432/omnihub`.
- `FISCAL_SECRET_KEY` — segredo de ≥32 caracteres que criptografa certificados A1/CSC (sem ela, operações fiscais são bloqueadas).
- `FISCAL_WORKER_INTERVAL_MS` (opcional) — intervalo do worker automático da fila fiscal; padrão 30000, `0` desliga. Ele roda dentro do próprio servidor (`instrumentation.ts`); com várias instâncias não duplica trabalho (claim atômico).

Passo a passo:

```
npm ci
export DATABASE_URL=postgres://... FISCAL_SECRET_KEY=...
npm run db:migrate     # aplica drizzle/*.sql (idempotente, registra em _migrations)
npm run build
npm run start         # Next.js em Node (porta 3000; PORT=... para mudar)
```

Use um gerenciador de processo (systemd/PM2) e um proxy reverso com HTTPS (nginx/Caddy) — o cookie de sessão é `Secure` em produção. Desenvolvimento: `npm run dev`.

Verificação: `npx tsc --noEmit` e `npm test` (`node --test tests/*.test.ts`; os testes usam um SQLite em memória — `tests/helpers/fakeD1.ts` + `tests/helpers/sqlite-migrations/` — como dublê do banco).

**Ao criar tabela/coluna:** adicionar uma nova migração em `drizzle/` (PostgreSQL) e o equivalente em `tests/helpers/sqlite-migrations/`; nunca alterar migração já aplicada.

### Deploy com Docker + Traefik (omnihub.adapterco.com.br)

`Dockerfile` + `docker-compose.yml` sobem o app (Next.js) e um PostgreSQL 16 dedicado. O app entra na rede externa `traefik9` (a mesma dos demais projetos da VPS) com roteadores HTTP→HTTPS (`https-redirect`) e HTTPS com `certresolver=letsencrypt`; o banco fica só na rede interna `omnihub_internal`, sem porta publicada. Porta interna do app: 3017.

```
cp .env.example .env   # preencher POSTGRES_PASSWORD e FISCAL_SECRET_KEY (DOMAIN já tem o padrão omnihub.adapterco.com.br)
docker compose up -d --build
```

O container roda `npm run db:migrate` antes de iniciar. O DNS de `omnihub.adapterco.com.br` precisa apontar para a VPS. Guarde a `FISCAL_SECRET_KEY`: sem ela, certificados A1/CSC já salvos ficam ilegíveis. O container ainda não foi construído/testado (o ambiente de desenvolvimento não tem Docker).

### Backup, restauração, health check e logs

- **Backup automático:** o serviço `backup` do `docker-compose.yml` roda `scripts/backup/backup.sh` logo após subir e depois a cada `BACKUP_INTERVAL_SECONDS` (padrão 24 h). Gera `pg_dump` comprimido no volume `omnihub_backups` (o dump inclui XMLs e eventos fiscais, que ficam no banco), valida que o arquivo é legível antes de publicá-lo e mantém `BACKUP_RETENTION_DAYS` dias (padrão 14), sem nunca apagar os 3 mais recentes. Falha de dump nunca apaga um backup bom.
- **Teste de restauração** (faça na primeira vez e periodicamente — backup nunca testado não é confiável): `docker compose exec backup sh /scripts/restore-test.sh`. Restaura o dump mais recente num banco temporário, confere tabelas e contagens e apaga o temporário; não toca a produção. Termina com `OK: restauração validada`.
- **Cópia fora da VPS (obrigatória para redundância real):** os dumps ficam no mesmo servidor. Copie-os para outro lugar, por exemplo: `docker cp omnihub-backup:/backups ./backups-$(date +%F)` e envie por `rsync`/`rclone`/armazenamento de objetos. Os dumps contêm hashes de senha e certificados criptografados: proteja o destino.
- **Restaurar de verdade** (desastre): pare o app (`docker compose stop web`), crie um banco vazio e rode `docker compose exec backup pg_restore --no-owner --clean --if-exists --dbname=omnihub /backups/<arquivo>.dump`, depois `docker compose start web`. A `FISCAL_SECRET_KEY` precisa ser a mesma de antes, senão os certificados restaurados não abrem.
- **Health check:** `GET /api/health` (público, sem detalhes internos) responde 200 se o banco responde e 503 se não. O `docker-compose.yml` o usa como `healthcheck` do app; sem resposta saudável o Traefik para de rotear.
- **Logs estruturados:** uma linha JSON por evento (`docker compose logs web`), com `requestId`; segredos são mascarados, e-mail aparece só como `emailRef` (hash) e o `detail` do PostgreSQL nunca é registrado. `LOG_LEVEL=debug|info|warn|error` (padrão `info`). Quando a tela mostrar "(código xxxxxxxx)", procure esse código nos logs. Eventos úteis: `auth.login.falhou`, `auth.login.bloqueado`, `workspace.escrita.erro`, `fiscal-worker.ciclo_falhou`, `backup.*`.
- **Fuso horário:** notas, chave de acesso, caixa e relatórios usam o horário de Brasília (`lib/time.ts`), independentemente do fuso do servidor.

### Pagamentos integrados no PDV (Mercado Pago)

- **Pix no balcão:** QR Code presencial dinâmico do Mercado Pago (`POST /v1/orders`, `type: "qr"`). Não pede e-mail nem CPF do cliente. Exige um **caixa** cadastrado na conta Mercado Pago da loja; o `external_id` desse caixa vai no campo "Caixa do Mercado Pago" em **Minhas lojas > Pagamentos integrados**.
- **Maquininha:** Mercado Pago Point (`type: "point"`), terminal em **modo PDV**. O botão "Listar maquininhas da conta" mostra os terminais e o modo de cada um.
- **Credenciais por loja:** Access Token e segredo do webhook da conta do próprio lojista, guardados criptografados com a `FISCAL_SECRET_KEY` (trocar essa chave obriga a salvar as credenciais de novo).
- **Webhook:** configure no painel da aplicação Mercado Pago (Webhooks > Configurar notificações > Modo produção, evento "Order (Mercado Pago)") a URL exibida na tela da loja e cole o segredo gerado. A assinatura `x-signature` é validada; o conteúdo da notificação nunca decide nada, só dispara uma consulta autenticada ao Mercado Pago.
- **Como a venda fecha:** a venda fica "Aguardando pagamento" com o estoque reservado e só é concluída quando o Mercado Pago confirma o **mesmo valor**. Expirou/cancelou/recusou: a venda é desfeita e o estoque volta. Cancelar venda paga estorna o total no Mercado Pago antes. Devolução parcial de venda paga por integração não é suportada (o provedor só estorna o total).
- **Reconciliação automática:** `PAYMENT_WORKER_INTERVAL_MS` (padrão 20000; `0` desliga) consulta cobranças abertas, inclusive depois de falha de rede na criação.
- **Não integrado (e por quê):** PagBank exige homologação obrigatória e CPF/CNPJ do cliente em todo Pix, e a maquininha deles é um app Android (SmartPOS); Asaas exige CPF/CNPJ do cliente; Efí exige mTLS no nosso servidor para o webhook; PicPay exige aprovação e certificação PCI DSS. A arquitetura (`lib/payments/`) está pronta para receber os próximos provedores.

**Limitação registrada:** o adaptador `lib/db/pgAdapter.ts` e o schema `drizzle/0001_init.sql` seguem a sintaxe padrão do PostgreSQL, mas não foram executados contra um servidor Postgres real (o ambiente de desenvolvimento não tinha PostgreSQL). A primeira execução real de `npm run db:migrate` e do fluxo de cadastro/login na VPS é o teste de verdade.

Emissão fiscal continua travada em Homologação (`lib/fiscal/endpoints.ts`).

## Próxima etapa

1. Definir o provedor de cobrança, planos, valores e política de renovação; implementar ciclo completo com eventos autenticados, repetição segura e conciliação.
2. Restrição por loja em `lib/catalog`/`lib/inventory` (já existe em `lib/cash`/`lib/sales`); login comercial independente para clientes finais.
3. Validar a transmissão de NF-e (Fase 5, Marco 3) contra o serviço real da SEFAZ de Homologação com certificado A1 de teste, confirmando a estrutura do envelope SOAP contra o MOC 7.00 Anexo II antes de qualquer emissão real.
4. Fase 6 (expandir NF-e: múltiplos produtos/clientes, rejeições, cancelamento fiscal, inutilização, DANFE) e Fase 7 (NFC-e modelo 65); testar concorrência e isolamento com volume antes do lançamento comercial.
