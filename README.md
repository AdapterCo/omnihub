# OmniHub Web

Primeira versão funcional privada para validar a gestão de lojas. Windows fica fora desta etapa.

## Implementado

- Entrada pela identidade autenticada do Sites/ChatGPT. Uma conta por identidade; associação a conta e papel ficam no servidor.
- Várias lojas por conta; dados cadastrais/fiscais preparatórios por loja e produto.
- Catálogo compartilhado, estoque separado e consulta entre lojas.
- Entradas de estoque e transferências restritas ao administrador. Transferência sai da origem, permanece em trânsito e entra no destino após confirmação.
- Caixa por loja e operador, abertura e fechamento com diferença de dinheiro. Operadores não movimentam outras lojas.
- Venda com preço calculado pelo servidor, estoque validado e caixa aberto obrigatório. Pagamento único em dinheiro, Pix ou cartão registrado manualmente.
- Venda, baixa de estoque, auditoria e chave de repetição são gravadas juntas com controle de revisão. Concorrência causa conflito explícito, sem sobrescrita silenciosa.
- Comprovante com o título exato COMPROVANTE NÃO FISCAL. Reimprimir não altera estoque nem situação fiscal.
- Histórico e exportação JSON dos dados autorizados.
- Avaliação de 7 dias, limite de 3 lojas e bloqueio no servidor. Não há endpoint para o cliente alterar plano, validade ou limites.
- Depois do vencimento, são permitidos consulta, exportação, impressão, fechamento de caixa e confirmação de transferências já iniciadas.

## Limites desta primeira entrega

Esta é uma base de validação, não um sistema fiscal homologado nem uma assinatura comercial pronta para venda.

- Emissão NF-e/NFC-e, autorização, cancelamento, XML, certificado, CSC e regras tributárias ainda não estão integrados. Vendas permanecem fiscalmente pendentes; não se gera nota fictícia. Os campos fiscais são preparatórios e não representam toda a parametrização tributária.
- Cobrança recorrente, checkout, notificações autenticadas do provedor, conciliação de pagamentos, estornos e reativação ainda dependem da escolha e configuração do provedor. Não há cobrança real ou botão de ativação simulada.
- Nesta publicação privada, o titular é administrador. A camada de autorização e o esquema suportam operador vinculado a uma loja, mas convites e administração de funcionários ainda precisam de interface e fluxo de adesão. Não divulgar para clientes antes de implementar o login comercial e a gestão de usuários.
- Preço é compartilhado entre lojas nesta versão. Preços por loja, pagamentos divididos, devoluções, descontos, sangrias, suprimentos, compras e comissões ficam para as próximas etapas.
- Não há modo offline. O carrinho é temporário e não sobrevive ao fechamento/recarregamento do navegador. Operações confirmadas ficam no banco.
- Armazenamento inicial: estado transacional por conta em D1 com atualização condicional por revisão. Antes de operação em volume, migrar os registros de produtos, saldos, vendas, itens, auditoria e idempotência para tabelas normalizadas, paginação e retenção dimensionada. Não usar este formato para carga comercial irrestrita.
- A integração WebMCP de consulta é opcional e usa os mesmos dados já autorizados. Seu contrato não foi exercitado em um navegador com suporte nesta sessão. Não foi solicitado teste visual de navegador.

## Desenvolvimento

Node >=22.13, npm, Vinext, React, TypeScript, Cloudflare D1 e Drizzle. A integração Sites é preservada.

- `npm run install:ci`
- `npm run dev -- --hostname 127.0.0.1`
- `npm run build`
- `node node_modules/typescript/bin/tsc --noEmit`
- `node --test tests/domain.test.ts` (Node com suporte nativo a TypeScript, validado em Node 26)
- `node tests/api-smoke.mjs` (servidor local na porta 5173, banco local migrado; cria apenas dados fictícios locais)

O login local `/signin-with-chatgpt?return_to=/` é simulado pelo plugin apenas em desenvolvimento. A publicação privada usa identidade fornecida pelo Sites. Não expor um servidor autônomo que aceite cabeçalhos de identidade sem proxy autenticador confiável.

Gerar migrações com `npm run db:generate`; não alterar migração já publicada. Para iniciar o banco local após o build:

```
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_yielding_franklin_richards.sql
```

No ambiente Windows desta sessão, os auxiliares Sites encontram uma falha no shim npm. A alternativa validada foi executar o `npm-cli.js` instalado por seu caminho completo. Nenhuma credencial de publicação deve ser gravada no projeto.

## Próxima etapa

1. Definir o provedor de cobrança, planos, valores e política de renovação; implementar ciclo completo com eventos autenticados, repetição segura e conciliação.
2. Implementar convites, operadores, restrições por loja e login para clientes finais.
3. Escolher o provedor fiscal e completar cadastros e emissão em homologação.
4. Normalizar o banco, implementar backup/restauração e testar concorrência e isolamento com volume antes do lançamento comercial.
