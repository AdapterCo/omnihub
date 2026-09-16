Quero desenvolver um sistema profissional de vendas/PDV, gestão de lojas, estoque, caixa e emissão fiscal. Antes de implementar qualquer funcionalidade, analise cuidadosamente toda esta especificação e trate-a como a base arquitetural do projeto.

O sistema deve ser projetado desde o início para ser comercializado como SaaS por assinatura, multiempresa e multiloja. Segurança, integridade financeira, integridade fiscal, rastreabilidade, auditoria e isolamento entre clientes são requisitos fundamentais.

Não implemente atalhos que possam comprometer posteriormente a arquitetura.

# 1. OBJETIVO DO SISTEMA

Criar uma plataforma completa de gestão comercial que permita:

* múltiplas empresas/clientes SaaS;
* múltiplas lojas por empresa;
* múltiplos usuários;
* múltiplos caixas/PDVs;
* vendas;
* vendas fiscais;
* vendas com comprovante não fiscal;
* estoque individual por loja;
* consulta de estoque entre lojas;
* transferência de estoque;
* abertura e fechamento de caixa;
* controle financeiro do PDV;
* clientes;
* fornecedores;
* produtos;
* usuários e permissões;
* auditoria;
* relatórios;
* assinatura SaaS;
* emissão de NF-e;
* emissão de NFC-e;
* cancelamento e demais eventos fiscais necessários;
* impressão de DANFE/documentos correspondentes;
* impressão de comprovante não fiscal;
* arquitetura preparada para NFS-e futuramente.

IMPORTANTE:

NFS-e NÃO deverá ser implementada agora.

Entretanto, a arquitetura fiscal deve ser criada de maneira modular para permitir futuramente:

Fiscal
├── NF-e
├── NFC-e
└── NFS-e (futuro)

Não criar dependências que tornem difícil adicionar NFS-e posteriormente.

# 2. ARQUITETURA MULTITENANT

O sistema será SaaS.

Devemos separar claramente:

Tenant/Empresa SaaS
├── Loja 1
├── Loja 2
├── Loja 3
└── ...

Cada cliente SaaS deve possuir isolamento absoluto dos seus dados.

Nunca confiar apenas no frontend para isolamento.

Toda operação do backend deve validar a qual tenant/empresa o usuário pertence.

Um usuário da Empresa A jamais poderá consultar, alterar ou descobrir dados pertencentes à Empresa B, inclusive manipulando IDs diretamente na API.

Aplicar essa regra a:

* lojas;
* produtos;
* clientes;
* fornecedores;
* estoques;
* vendas;
* caixas;
* documentos fiscais;
* XML;
* certificados;
* relatórios;
* configurações;
* usuários;
* transferências;
* auditorias;
* arquivos;
* qualquer entidade futura.

Utilizar UUIDs onde forem apropriados.

Mesmo utilizando UUID, nunca considerar UUID como mecanismo de autorização.

# 3. EMPRESAS E LOJAS

Uma empresa poderá possuir várias lojas.

Exemplo:

Empresa ABC

├── Loja Centro
├── Loja Shopping
└── Loja Campo Grande

Cada loja deverá possuir configurações próprias.

Considerar informações como:

* nome fantasia;
* razão social;
* CNPJ;
* inscrição estadual;
* endereço;
* telefone;
* e-mail;
* configurações fiscais;
* série fiscal;
* numeração;
* ambiente fiscal;
* estoque;
* caixas;
* usuários vinculados;
* impressoras/configurações locais;
* configurações comerciais.

Não assumir automaticamente que todas as lojas utilizarão exatamente a mesma configuração fiscal.

A modelagem deve permitir matriz e filiais.

# 4. USUÁRIOS E PERMISSÕES

Implementar RBAC profissional.

Inicialmente considerar:

OWNER
ADMIN
GERENTE
OPERADOR_CAIXA
ESTOQUISTA
CONSULTA

Não espalhar verificações como:

if (role === "admin")

pelo sistema inteiro.

Criar sistema centralizado de permissões.

Exemplos:

STORE_VIEW
STORE_CREATE
STORE_EDIT

PRODUCT_VIEW
PRODUCT_CREATE
PRODUCT_EDIT
PRODUCT_DELETE

STOCK_VIEW
STOCK_ADJUST
STOCK_TRANSFER

SALE_CREATE
SALE_CANCEL
SALE_DISCOUNT

CASH_OPEN
CASH_CLOSE
CASH_SUPPLY
CASH_WITHDRAWAL

FISCAL_ISSUE
FISCAL_CANCEL

USER_VIEW
USER_CREATE
USER_EDIT

REPORT_VIEW

AUDIT_VIEW

O OWNER deverá ter acesso administrativo completo dentro de seu próprio tenant.

O ADMIN poderá executar operações administrativas conforme configuração.

Operações críticas deverão exigir permissões específicas.

# 5. ESTOQUE POR LOJA

O estoque deverá pertencer à loja.

Não utilizar simplesmente:

product.stock

Modelar conceitualmente:

Product
+
Store
=
Inventory

Exemplo:

Produto X

Loja A: 10
Loja B: 25
Loja C: 3

Usuários autorizados da mesma empresa poderão consultar o estoque das demais lojas.

Entretanto, consulta não significa alteração.

Uma loja poderá visualizar:

Loja Centro
Produto X: 10

Loja Shopping
Produto X: 25

mas não poderá modificar diretamente o estoque de outra loja sem possuir autorização administrativa específica.

# 6. MOVIMENTAÇÃO DE ESTOQUE

Não tratar estoque apenas como um número que aumenta ou diminui.

Criar um ledger/histórico de movimentações.

Exemplo:

StockMovement

id
tenant_id
store_id
product_id
type
quantity
previous_quantity
new_quantity
reference_type
reference_id
user_id
created_at

Tipos possíveis:

INITIAL
PURCHASE
SALE
SALE_CANCEL
TRANSFER_OUT
TRANSFER_IN
MANUAL_ADJUSTMENT
LOSS
DAMAGE
RETURN
INVENTORY_ADJUSTMENT

Toda mudança de estoque deverá gerar rastreabilidade.

Evitar alteração silenciosa de quantidade.

# 7. TRANSFERÊNCIA ENTRE LOJAS

Somente usuários com permissão administrativa adequada poderão realizar transferência.

Fluxo:

Loja A
↓
Solicitação de transferência
↓
Itens
↓
Quantidade
↓
Confirmação
↓
Saída Loja A
↓
Entrada Loja B

Não simplesmente executar:

estoqueA -= quantidade
estoqueB += quantidade

Criar entidade StockTransfer.

Estados possíveis:

DRAFT
PENDING
APPROVED
IN_TRANSIT
RECEIVED
CANCELLED

Registrar:

* origem;
* destino;
* produtos;
* quantidades;
* usuário solicitante;
* usuário aprovador;
* usuário responsável pelo recebimento;
* datas;
* observações.

A movimentação deverá ser transacional.

Nunca permitir que estoque saia de uma loja sem entrar corretamente na outra por falha parcial da aplicação.

# 8. PRODUTOS

Separar informações comerciais de informações fiscais.

Product

Informações comerciais:

* SKU;
* código interno;
* EAN/GTIN;
* nome;
* descrição;
* categoria;
* marca;
* unidade;
* preço de custo;
* preço de venda;
* margem;
* estoque mínimo;
* ativo/inativo;
* imagem.

Informações fiscais:

* NCM;
* CEST quando aplicável;
* origem da mercadoria;
* unidade tributável;
* GTIN tributável;
* perfil tributário;
* demais informações exigidas pelos documentos fiscais.

Não assumir que CFOP seja uma propriedade fixa do produto.

CFOP depende da operação.

O motor fiscal deverá considerar contexto da operação.

# 9. CLIENTES

Criar cadastro de clientes permitindo pessoa física e jurídica.

Considerar:

* CPF/CNPJ;
* nome/razão social;
* nome fantasia;
* inscrição estadual quando aplicável;
* indicador da IE;
* e-mail;
* telefone;
* endereço;
* município;
* UF;
* CEP;
* observações.

Validar documentos e dados de maneira adequada.

Não inventar informações ausentes para emissão fiscal.

# 10. FORNECEDORES

Cadastrar fornecedores separadamente.

Considerar:

* CNPJ/CPF;
* razão social;
* nome fantasia;
* IE;
* contato;
* endereço;
* produtos relacionados;
* histórico.

Preparar arquitetura para futuramente permitir entrada de mercadoria através de documentos fiscais de compra, sem obrigatoriamente implementar isso na primeira versão.

# 11. PDV

Criar interface de PDV rápida e adequada para operação contínua.

Fluxo:

Abrir caixa
↓
Adicionar produtos
↓
Identificar cliente opcionalmente
↓
Aplicar desconto, se permitido
↓
Selecionar pagamento
↓
Concluir pagamento
↓
Escolher documento
↓
Fiscal ou não fiscal

IMPORTANTE:

O operador deverá poder perguntar ao cliente qual documento deseja quando isso for legalmente aplicável ao cenário da operação.

A interface deverá apresentar claramente as opções configuradas para aquela operação, por exemplo:

[ EMITIR DOCUMENTO FISCAL ]

[ IMPRIMIR COMPROVANTE NÃO FISCAL ]

Não confundir comprovante não fiscal com documento fiscal.

# 12. COMPROVANTE NÃO FISCAL

Quando for selecionada a impressão não fiscal, gerar um comprovante comercial.

No topo, de maneira claramente visível:

COMPROVANTE NÃO FISCAL

Não utilizar palavras ou aparência que façam o comprovante parecer NF-e/NFC-e.

O comprovante poderá apresentar:

COMPROVANTE NÃO FISCAL

Nome da loja
CNPJ

Data/hora

Itens:

2x Produto A     R$ XX,XX
1x Produto B     R$ XX,XX

Subtotal
Desconto
Total

Forma de pagamento

Operador
Número interno da venda

Rodapé configurável.

A venda deverá continuar registrada normalmente no sistema.

Registrar explicitamente:

document_type = NON_FISCAL_RECEIPT

Nunca criar chave de acesso, protocolo fiscal ou qualquer informação fictícia.

Nunca chamar esse comprovante de NF-e, NFC-e, DANFE ou nota fiscal.

IMPORTANTE:

A existência da opção "COMPROVANTE NÃO FISCAL" não deve ser usada pelo sistema para contornar obrigação legal de emissão de documento fiscal. As regras de obrigatoriedade deverão ser tratadas separadamente e configuradas conforme legislação/regime/operação aplicável.

# 13. PAGAMENTOS

Preparar suporte para:

* dinheiro;
* PIX;
* cartão de crédito;
* cartão de débito;
* outras formas;
* pagamento dividido/misto.

Exemplo:

Venda R$ 150

R$ 50 dinheiro
R$ 100 PIX

Modelar SalePayment separadamente.

Nunca armazenar dados sensíveis completos de cartão.

Preparar arquitetura para integração futura com adquirentes/TEF/POS.

# 14. CAIXA

Cada caixa deverá ser individual.

Fluxo:

CLOSED
↓
OPEN
↓
operações
↓
CLOSING
↓
CLOSED

Abertura:

* operador;
* loja;
* terminal;
* valor inicial;
* data/hora.

Durante operação registrar:

* vendas;
* dinheiro recebido;
* PIX;
* cartões;
* suprimentos;
* sangrias;
* estornos;
* cancelamentos.

Fechamento:

* saldo esperado;
* saldo informado;
* diferença;
* valores por forma de pagamento;
* operador;
* data/hora.

Não permitir apagar fechamento de caixa.

Correções deverão gerar eventos/auditoria.

# 15. SANGRIA E SUPRIMENTO

Criar operações específicas:

CASH_WITHDRAWAL
CASH_SUPPLY

Registrar:

* valor;
* motivo;
* usuário;
* caixa;
* data/hora.

Dependendo do valor/configuração, permitir exigir autorização de gerente/admin.

# 16. VENDAS

Separar venda comercial de documento fiscal.

Isso é extremamente importante.

Sale != FiscalDocument

Uma venda poderá existir antes da emissão fiscal.

Estrutura:

Sale
↓
SaleItems
↓
Payments
↓
FiscalDocument

ou

Sale
↓
NonFiscalReceipt

Isso evita misturar domínio comercial e fiscal.

# 17. STATUS DA VENDA

Criar estados claros.

Exemplo:

DRAFT
PENDING_PAYMENT
PAID
COMPLETED
CANCELLED
REFUNDED

Não usar apenas booleanos como:

paid = true
cancelled = false

quando um state machine for mais apropriado.

# 18. MÓDULO FISCAL

Criar módulo independente:

fiscal/

Responsabilidades:

* configurações fiscais;
* certificado;
* validações;
* cálculo/regras;
* NF-e;
* NFC-e;
* XML;
* assinatura;
* comunicação;
* autorização;
* rejeições;
* eventos;
* cancelamento;
* contingência;
* armazenamento;
* auditoria.

Arquitetura conceitual:

Venda
↓
FiscalService
↓
TaxEngine
↓
DocumentBuilder
↓
XML
↓
SchemaValidator
↓
Signer
↓
FiscalGateway
↓
SEFAZ
↓
ResponseProcessor

Não implementar lógica fiscal no frontend.

# 19. NF-e

Preparar suporte para NF-e modelo 55.

Tratar corretamente:

* emitente;
* destinatário;
* produtos;
* valores;
* tributação;
* pagamentos;
* transporte quando aplicável;
* informações adicionais;
* modelo;
* série;
* número;
* ambiente;
* chave;
* assinatura;
* protocolo.

Utilizar layouts oficiais vigentes.

Não inventar tags XML.

Não hardcodar schema fiscal de maneira impossível de atualizar.

# 20. NFC-e

Preparar suporte para NFC-e modelo 65.

Considerar suas particularidades:

* consumidor final;
* identificação do consumidor quando aplicável;
* pagamentos;
* QR Code;
* CSC/token quando aplicável;
* DANFE NFC-e;
* contingência;
* ambiente;
* série;
* numeração.

NF-e e NFC-e deverão compartilhar componentes comuns sem serem tratadas como exatamente o mesmo documento.

# 21. XML

O XML autorizado é parte fundamental do documento fiscal.

Nunca considerar PDF/DANFE como documento eletrônico original.

Guardar de forma segura:

* XML enviado;
* XML autorizado;
* protocolo;
* eventos;
* XML de cancelamento/eventos quando aplicável;
* respostas relevantes.

Implementar política adequada de retenção e backup.

Não permitir edição do XML autorizado.

# 22. DANFE

Gerar representação correspondente somente a partir dos dados fiscais válidos/autorizados, conforme aplicável.

Nunca gerar um DANFE falso para uma venda não fiscal.

Documento não fiscal utiliza exclusivamente o layout:

COMPROVANTE NÃO FISCAL

# 23. CERTIFICADO DIGITAL

Preparar suporte seguro para certificado A1.

Nunca:

* salvar senha em plaintext;
* enviar certificado ao frontend;
* expor certificado em logs;
* retornar certificado através da API;
* colocar certificado no repositório;
* colocar senha em variável pública;
* armazenar PFX sem proteção.

Criar serviço dedicado:

CertificateService

Responsável por:

* armazenamento criptografado;
* descriptografia somente durante utilização;
* validação;
* expiração;
* identificação do titular;
* alertas de vencimento.

Considerar KMS/secret manager em produção.

Registrar utilização administrativa sem registrar conteúdo secreto.

# 24. AMBIENTES FISCAIS

Diferenciar explicitamente:

HOMOLOGATION
PRODUCTION

Nunca inferir ambiente silenciosamente.

Exibir claramente no painel quando empresa estiver em homologação.

Adicionar proteções contra emissão acidental em produção durante desenvolvimento/testes.

# 25. NUMERAÇÃO FISCAL

Criar controle específico por:

tenant
estabelecimento
modelo
série
ambiente

Nunca usar:

sale.id

como número fiscal.

Proteger contra concorrência.

A reserva/obtenção do próximo número deverá ser transacional.

Considerar tratamento de inutilização quando aplicável.

# 26. STATUS DO DOCUMENTO FISCAL

Não utilizar apenas:

issued = true

Criar estados.

Exemplo:

PENDING
GENERATING
VALIDATING
SIGNING
SENDING
AUTHORIZED
REJECTED
DENIED
CANCEL_PENDING
CANCELLED
CONTINGENCY
ERROR

Os estados devem refletir corretamente o ciclo fiscal real.

# 27. REJEIÇÕES

Rejeição é parte normal da integração.

Registrar:

* código;
* mensagem;
* request relacionado;
* response;
* data;
* documento;
* tentativa.

Nunca transformar automaticamente rejeição em autorização.

Nunca gerar dados falsos para fazer a nota "passar".

Exibir mensagem compreensível ao usuário sem perder o código técnico original.

# 28. EVENTOS FISCAIS

Documento fiscal autorizado não deverá ser simplesmente deletado.

Criar FiscalEvent.

Exemplos:

AUTHORIZATION
CANCELLATION
NUMBER_VOID
CORRECTION
OUTROS_EVENTOS_SUPORTADOS

Guardar protocolo e respostas quando existentes.

# 29. CANCELAMENTO

Cancelamento fiscal e cancelamento comercial são conceitos relacionados, mas diferentes.

Fluxos precisam ser coordenados.

Não executar DELETE.

Registrar:

FiscalDocument
└── FiscalEvent(CANCELLATION)

Se cancelamento afetar estoque, caixa ou venda, executar as operações correspondentes de maneira controlada, transacional e auditável.

# 30. CONTINGÊNCIA

Projetar arquitetura para NFC-e em contingência.

Mesmo que a primeira versão não implemente todos os fluxos, evitar arquitetura que impossibilite isso.

Pensar em:

NORMAL
↓
falha de comunicação
↓
CONTINGENCY
↓
pendência
↓
reconciliação/transmissão

Nunca criar duplicidade de documento durante retry.

# 31. IDEMPOTÊNCIA

Operações críticas deverão suportar idempotência.

Principalmente:

* concluir venda;
* pagamento;
* emitir documento fiscal;
* cancelar;
* transferência;
* movimentação de estoque.

Exemplo:

usuário clica duas vezes em "Emitir".

Isso NÃO poderá gerar duas notas.

Implementar idempotency keys onde apropriado.

# 32. TRANSAÇÕES

Utilizar transações de banco para operações que precisam ser atômicas.

Exemplo:

Venda concluída:

* registrar venda;
* itens;
* pagamentos;
* movimentação de estoque.

Se uma etapa crítica falhar, não deixar banco em estado parcialmente atualizado.

O mesmo vale para transferência de estoque.

# 33. CONCORRÊNCIA

Considerar dois caixas vendendo simultaneamente o último produto.

Não confiar em:

frontend mostrou estoque = 1

Logo posso vender.

Revalidar estoque no backend.

Utilizar mecanismos apropriados de transação/locking/controle concorrente.

# 34. MOTOR FISCAL

Criar TaxEngine separado.

Não espalhar:

if (estado === ...)
if (simples === ...)
if (produto === ...)

pelo código.

O motor deverá receber contexto.

Exemplo conceitual:

TaxContext {
issuer
customer
products
operation
origin
destination
taxRegime
date
}

E retornar tratamento fiscal calculado/validado.

Nunca "adivinhar" classificação fiscal.

# 35. CFOP

Não armazenar CFOP simplesmente como propriedade universal e fixa do produto.

CFOP depende da operação.

Criar regras/perfis de operação fiscal.

Exemplo:

FiscalOperation

SALE
RETURN
TRANSFER
BONUS
OTHER

As regras deverão determinar o CFOP aplicável com base no contexto configurado.

# 36. NCM/CEST

Permitir cadastro e validação.

Não utilizar IA ou heurística para inventar classificação fiscal.

Se dado obrigatório estiver ausente:

bloquear emissão
+
explicar ao usuário.

# 37. REGIME TRIBUTÁRIO

Preparar configuração fiscal da empresa para regime tributário e códigos aplicáveis.

Não assumir que todas as empresas sejam Simples Nacional.

Arquitetura deve permitir evolução para diferentes regimes.

# 38. REFORMA TRIBUTÁRIA

Como o sistema está sendo desenvolvido em 2026, não construir arquitetura exclusivamente baseada no modelo tributário legado.

Preparar TaxEngine e modelos fiscais para evolução envolvendo:

* IBS;
* CBS;
* novos grupos tributários;
* novas versões de schema;
* novas regras de validação;
* períodos de transição.

Nunca hardcodar a legislação inteira dentro de controllers.

Criar versionamento das regras fiscais.

# 39. VERSIONAMENTO FISCAL

Criar conceito de:

FiscalSchemaVersion
TaxRuleVersion

O sistema deve conseguir identificar qual versão de layout/regra está utilizando.

Atualizações fiscais não devem exigir reescrever todo o PDV.

# 40. NFS-e — FUTURO

NÃO implementar NFS-e agora.

Porém deixar interface preparada.

Exemplo:

interface FiscalProvider {
issue()
cancel()
status()
}

Implementações:

NFeProvider
NFCeProvider

Futuramente:

NFSeProvider

Não colocar regras municipais/NFS-e dentro dos módulos NF-e/NFC-e.

# 41. PROCESSAMENTO ASSÍNCRONO

Operações fiscais externas podem demorar ou falhar.

Preparar arquitetura com filas/workers quando apropriado.

Exemplo:

API
↓
FiscalJob
↓
Queue
↓
FiscalWorker
↓
SEFAZ
↓
resultado

Considerar:

* retry;
* backoff;
* timeout;
* idempotência;
* dead-letter;
* observabilidade.

Nunca executar retries cegos que possam gerar duplicidades.

# 42. AUDITORIA

Criar AuditLog imutável para ações importantes.

Registrar:

* tenant;
* loja;
* usuário;
* ação;
* entidade;
* ID;
* data/hora;
* IP quando apropriado;
* informações anteriores;
* informações posteriores;
* correlation ID.

Auditar principalmente:

* login;
* alteração de permissões;
* alteração de preço;
* desconto;
* ajuste de estoque;
* transferência;
* cancelamento;
* sangria;
* suprimento;
* fechamento;
* configurações fiscais;
* certificado;
* emissão fiscal;
* cancelamento fiscal.

Não armazenar segredos nos logs.

# 43. ASSINATURA SAAS

Esta parte deve ser extremamente rigorosa.

Criar:

Subscription
Plan
PlanFeature
UsageLimit

Estados:

TRIAL
ACTIVE
PAST_DUE
SUSPENDED
CANCELLED
EXPIRED

Nunca confiar no frontend para decidir se plano está ativo.

Backend deve validar assinatura.

# 44. PLANOS

Preparar planos configuráveis.

Exemplo:

BASIC
PRO
ENTERPRISE

Limites possíveis:

* número de lojas;
* usuários;
* caixas;
* documentos fiscais/mês;
* armazenamento;
* funcionalidades;
* relatórios;
* integrações.

Não hardcodar regras de plano em dezenas de controllers.

Criar EntitlementService.

Exemplo:

entitlements.canUse(
tenant,
"FISCAL_NFCE"
)

# 45. INADIMPLÊNCIA

Definir política clara.

Nunca simplesmente apagar dados.

Possíveis estados:

ACTIVE
GRACE_PERIOD
RESTRICTED
SUSPENDED

Preservar documentos fiscais e históricos.

Nunca impedir acesso aos documentos que legalmente precisam permanecer disponíveis apenas como punição arbitrária sem analisar os requisitos legais aplicáveis.

# 46. SEGURANÇA

Implementar:

* autenticação segura;
* hash forte de senha;
* refresh token seguro;
* revogação;
* rate limiting;
* validação de payload;
* autorização no backend;
* proteção contra IDOR;
* SQL injection;
* XSS;
* CSRF quando aplicável;
* brute force;
* upload malicioso;
* path traversal;
* exposição de secrets.

Aplicar princípio do menor privilégio.

# 47. SESSÕES

Painel deverá permitir ao usuário visualizar sessões/dispositivos ativos e revogar sessões quando apropriado.

Registrar atividades suspeitas.

# 48. 2FA

Preparar suporte para autenticação em dois fatores, principalmente:

OWNER
ADMIN

Recomendável tornar obrigatório para operações extremamente sensíveis no futuro.

# 49. OPERAÇÕES CRÍTICAS

Considerar reautenticação/confirmação para:

* alterar certificado;
* mudar configurações fiscais;
* alterar CNPJ;
* excluir usuário administrativo;
* modificar assinatura;
* cancelar documento fiscal;
* realizar grandes ajustes de estoque.

# 50. RELATÓRIOS

Criar arquitetura para:

* vendas por período;
* vendas por loja;
* vendas por operador;
* vendas por produto;
* formas de pagamento;
* ticket médio;
* margem;
* produtos mais vendidos;
* estoque;
* estoque baixo;
* movimentações;
* transferências;
* caixa;
* sangrias;
* descontos;
* cancelamentos;
* documentos fiscais;
* rejeições fiscais.

Permitir visão consolidada das lojas para usuários autorizados.

# 51. DASHBOARD

Dashboard administrativo poderá apresentar:

Vendas hoje
Faturamento
Ticket médio
Vendas por loja
Produtos vendidos
Estoque crítico
Caixas abertos
Transferências pendentes
Notas rejeitadas
Certificados próximos do vencimento
Status da assinatura

Não realizar consultas extremamente pesadas diretamente a cada refresh.

Preparar agregações/cache quando necessário.

# 52. ALERTAS

Criar sistema de alertas para:

* estoque mínimo;
* certificado próximo do vencimento;
* documento fiscal rejeitado;
* falha de comunicação fiscal;
* transferência pendente;
* divergência de caixa;
* assinatura próxima do vencimento;
* pagamento SaaS pendente.

# 53. DESCONTOS

Permissões por limite.

Exemplo:

OPERADOR: até X%
GERENTE: até Y%
ADMIN: configurável

Desconto superior ao permitido deverá solicitar autorização.

Registrar quem concedeu e quem autorizou.

# 54. DEVOLUÇÕES E ESTORNOS

Preparar fluxo específico.

Não simplesmente excluir venda.

Registrar histórico e movimentações compensatórias.

Diferenciar:

* cancelamento;
* devolução;
* estorno financeiro;
* cancelamento fiscal;
* retorno ao estoque.

# 55. EXCLUSÃO DE REGISTROS

Evitar hard delete para registros financeiros, fiscais, estoque e auditoria.

Preferir:

ACTIVE
INACTIVE
CANCELLED
ARCHIVED

dependendo do domínio.

Documentos fiscais e eventos jamais deverão desaparecer silenciosamente.

# 56. OBSERVABILIDADE

Implementar:

* logs estruturados;
* correlation ID;
* métricas;
* monitoramento de erros;
* health checks.

Nunca registrar:

* senha;
* token completo;
* certificado;
* senha do certificado;
* dados sensíveis desnecessários.

# 57. BACKUP

Banco e documentos fiscais são críticos.

Projetar:

* backups automáticos;
* retenção;
* restauração testada;
* redundância apropriada;
* proteção dos XMLs.

Backup que nunca foi testado para restauração não deve ser considerado confiável.

# 58. LGPD

Aplicar princípios de:

* minimização;
* finalidade;
* controle de acesso;
* segurança;
* auditoria;
* retenção.

Separar dados pessoais dos dados que precisam ser mantidos por obrigação fiscal/contábil.

Não permitir que uma solicitação genérica de exclusão destrua documentos que possuam obrigação legal de conservação.

# 59. API

Utilizar padrão consistente.

Exemplo:

/api/v1/stores
/api/v1/products
/api/v1/inventory
/api/v1/transfers
/api/v1/customers
/api/v1/sales
/api/v1/cash-sessions
/api/v1/fiscal/documents
/api/v1/reports
/api/v1/users
/api/v1/subscription

Criar versionamento da API desde o início.

# 60. VALIDAÇÃO

Frontend melhora experiência.

Backend garante integridade.

Nunca considerar validação frontend como proteção suficiente.

Todo dado deverá ser novamente validado no servidor.

# 61. DATAS E HORÁRIOS

Persistir datas de maneira consistente.

Considerar timezone corretamente para:

* loja;
* emissão fiscal;
* caixa;
* relatórios;
* auditoria.

Não espalhar conversões arbitrárias pelo código.

# 62. VALORES MONETÁRIOS

Nunca utilizar float de maneira ingênua para dinheiro.

Utilizar Decimal ou representação monetária adequada.

Garantir arredondamentos consistentes.

Isso é especialmente importante para:

* preço;
* desconto;
* impostos;
* pagamentos;
* totais;
* fechamento.

# 63. BANCO DE DADOS

Estrutura inicial deverá considerar entidades como:

Tenant
Store
User
Role
Permission
UserStore

Customer
Supplier

Product
Category
ProductFiscalProfile

Inventory
StockMovement
StockTransfer
StockTransferItem

Sale
SaleItem
SalePayment

CashRegister
CashSession
CashMovement

FiscalConfiguration
FiscalDocument
FiscalDocumentItem
FiscalEvent
FiscalError
FiscalSequence
FiscalSchemaVersion
TaxRuleVersion

Certificate

Subscription
Plan
PlanFeature

AuditLog
Notification

Não crie tabelas apenas porque estão listadas.

Primeiro analise relacionamentos, normalização, constraints, índices e domínio.

# 64. CONSTRAINTS

Banco deverá ajudar a proteger integridade.

Considerar:

* unique constraints;
* foreign keys;
* check constraints;
* índices;
* isolamento por tenant;
* proteção de duplicidade;
* optimistic/pessimistic locking onde necessário.

# 65. TESTES

Criar:

* unit tests;
* integration tests;
* fiscal tests;
* permission tests;
* tenant isolation tests;
* stock concurrency tests;
* cash tests;
* subscription tests.

Testes obrigatórios deverão incluir:

Empresa A tentando acessar Empresa B.

Operador tentando transferir estoque.

Dois caixas vendendo último item.

Clique duplicado em emitir nota.

Retry fiscal.

Documento rejeitado.

Cancelamento.

Fechamento com divergência.

Assinatura expirada.

# 66. HOMOLOGAÇÃO FISCAL

Todo desenvolvimento inicial de emissão deverá ocorrer em ambiente de homologação.

Produção deverá exigir configuração explícita.

Nunca utilizar dados fiscais falsos em produção.

# 67. FONTES FISCAIS

Para qualquer implementação fiscal:

NÃO invente regras.

NÃO utilize conhecimento presumido quando existir possibilidade de alteração normativa.

Consultar documentação oficial vigente.

Priorizar:

* Portal Nacional da NF-e;
* documentação SEFAZ;
* Receita Federal;
* Portal Nacional NFS-e quando futuramente implementado;
* schemas XSD oficiais;
* Notas Técnicas vigentes.

Registrar no código/documentação qual versão técnica está sendo suportada.

# 68. NÃO INVENTAR DADOS

Regra geral do projeto:

Se uma informação obrigatória estiver ausente, não invente.

Exemplo:

NCM ausente.

ERRADO:

"Vou colocar um NCM provável."

CORRETO:

"Produto sem NCM configurado. Emissão bloqueada."

Aplicar o mesmo princípio a:

* CFOP;
* CST;
* CSOSN;
* CEST;
* endereço;
* inscrição;
* tributação;
* certificado;
* códigos fiscais.

# 69. EXPERIÊNCIA DO OPERADOR

Apesar da complexidade interna, o PDV deve permanecer simples.

O operador não deverá precisar entender XML, CST ou schema.

Exemplo:

Produto
Quantidade
Pagamento
Cliente

[ FINALIZAR ]

Depois:

Documento:

[ FISCAL ]

[ COMPROVANTE NÃO FISCAL ]

Erros fiscais deverão ser traduzidos para mensagens compreensíveis, mantendo detalhes técnicos disponíveis para administrador/suporte.

# 70. IDEIAS ADICIONAIS PARA O PRODUTO

Além dos requisitos originais, preparar arquitetura para futuramente adicionar:

* leitor de código de barras;
* impressão térmica;
* etiquetas;
* promoções;
* combos;
* tabela de preços;
* preços diferentes por loja;
* orçamento;
* pré-venda;
* contas a receber;
* contas a pagar;
* comissão de vendedores;
* metas;
* programa de fidelidade;
* cashback;
* histórico do cliente;
* catálogo;
* integração e-commerce;
* integração PIX;
* TEF;
* integração com balança;
* importação de produtos;
* entrada via XML de fornecedor;
* inventário;
* curva ABC;
* sugestão de reposição;
* dashboard consolidado;
* aplicativo administrativo;
* API pública;
* webhooks;
* integrações contábeis;
* exportações fiscais;
* NFS-e.

Não implementar tudo imediatamente.

Projetar extensibilidade.

# 71. ENTRADA POR XML — FUTURO

Uma funcionalidade futura extremamente interessante será permitir importar XML de NF-e de compra.

Fluxo futuro:

XML fornecedor
↓
Leitura
↓
Produtos
↓
Fornecedor
↓
Custos
↓
Entrada
↓
Estoque

Deixar arquitetura preparada, mas não implementar sem solicitação.

# 72. INVENTÁRIO

Preparar futuro módulo para contagem física.

Exemplo:

Inventário Loja A
↓
quantidade sistema
↓
quantidade contada
↓
diferença
↓
aprovação
↓
StockMovement

Nunca simplesmente sobrescrever estoque sem histórico.

# 73. PREÇO POR LOJA

Embora produtos possam ser compartilhados dentro da empresa, permitir futuramente:

Produto A

Loja 1: R$10
Loja 2: R$12

Portanto não assumir necessariamente que Product.price seja global e imutável.

Avaliar StoreProduct/PriceTable.

# 74. MODO DE OPERAÇÃO

Não tente implementar os 74 tópicos simultaneamente.

Primeiro:

1. Analise o projeto existente.
2. Não destrua funcionalidades existentes.
3. Identifique stack, estrutura, banco e arquitetura atuais.
4. Compare o que existe com esta especificação.
5. Liste gaps.
6. Proponha arquitetura final.
7. Proponha migrations.
8. Proponha etapas de implementação.
9. Identifique riscos.
10. Só depois comece a alterar código.

Sempre trabalhar incrementalmente.

# 75. ORDEM DE IMPLEMENTAÇÃO

Sugestão:

FASE 1
Fundação SaaS

* tenants;
* lojas;
* usuários;
* RBAC;
* assinatura;
* segurança;
* auditoria.

FASE 2
Catálogo/estoque

* produtos;
* categorias;
* estoque por loja;
* StockMovement;
* transferências.

FASE 3
PDV

* caixa;
* vendas;
* pagamentos;
* impressão não fiscal;
* fechamento.

FASE 4
Fundação fiscal

* FiscalConfiguration;
* CertificateService;
* TaxEngine;
* FiscalDocument;
* FiscalEvent;
* FiscalSequence;
* schemas;
* homologação.

FASE 5
NF-e

Primeiro objetivo fiscal:

1 empresa
1 estabelecimento
1 produto
homologação
NF-e 55
XML válido
assinatura válida
envio
autorização
protocolo
XML autorizado

FASE 6
Expandir NF-e

* vários produtos;
* clientes;
* rejeições;
* cancelamentos;
* inutilização;
* DANFE;
* tratamento completo de erros.

FASE 7
NFC-e

* modelo 65;
* consumidor;
* pagamentos;
* QR Code;
* DANFE NFC-e;
* CSC quando aplicável;
* contingência.

FASE 8
Escala

* workers;
* filas;
* retries;
* observabilidade;
* otimização;
* relatórios;
* dashboards.

FASE FUTURA
NFS-e.

# 76. REGRA FUNDAMENTAL SOBRE VENDA FISCAL E NÃO FISCAL

A aplicação deverá diferenciar claramente três conceitos:

VENDA
DOCUMENTO FISCAL
COMPROVANTE COMERCIAL

Venda é o evento comercial.

Documento fiscal é o documento eletrônico fiscal autorizado conforme regras aplicáveis.

Comprovante não fiscal é apenas representação comercial da venda.

Portanto:

Sale
│
├── FiscalDocument
│
└── NonFiscalReceipt

Não misturar esses conceitos.

Uma venda não fiscal jamais poderá receber artificialmente:

* chave fiscal;
* protocolo;
* QR Code fiscal;
* status "autorizada";
* DANFE;
* número de NF-e/NFC-e.

O comprovante deverá identificar claramente:

COMPROVANTE NÃO FISCAL

# 77. REGRA FUNDAMENTAL SOBRE LEGISLAÇÃO

A escolha apresentada ao operador entre documento fiscal e comprovante não fiscal não significa que o software deve permitir omissão de documento fiscal quando sua emissão for legalmente obrigatória.

Portanto criar arquitetura para:

FiscalRequirementService

Esse serviço poderá determinar futuramente:

OPTIONAL
REQUIRED
NOT_APPLICABLE
BLOCKED

com base no contexto configurado e nas regras aplicáveis.

O comprovante não fiscal nunca deverá ser utilizado como mecanismo para burlar obrigação fiscal.

# 78. PRIMEIRO TRABALHO QUE QUERO DE VOCÊ

Antes de escrever grandes quantidades de código:

Analise todo o projeto atual.

Depois me entregue:

1. arquitetura encontrada;
2. tecnologias utilizadas;
3. banco atual;
4. entidades existentes;
5. autenticação atual;
6. sistema atual de permissões;
7. fluxo atual de venda;
8. fluxo atual de estoque;
9. funcionalidades já implementadas;
10. problemas encontrados;
11. riscos de segurança;
12. riscos de arquitetura;
13. diferenças entre projeto atual e esta especificação;
14. estrutura de banco proposta;
15. arquitetura backend proposta;
16. arquitetura fiscal proposta;
17. arquitetura de assinatura proposta;
18. plano incremental de implementação.

Não faça uma reescrita completa desnecessária.

Aproveite tudo que estiver bem implementado.

Quando uma mudança estrutural for necessária, explique:

* o problema atual;
* por que precisa mudar;
* impacto;
* solução proposta.

Não faça alterações destrutivas sem necessidade.

# 79. REGRA DE QUALIDADE

Quero que este projeto seja tratado como software comercial real.

Não como protótipo.

Para toda funcionalidade considere:

SEGURANÇA
INTEGRIDADE
CONCORRÊNCIA
AUDITORIA
ESCALABILIDADE
MANUTENIBILIDADE
EXPERIÊNCIA DO USUÁRIO
OBRIGAÇÕES FISCAIS
OBSERVABILIDADE
BACKUP
RECUPERAÇÃO

Não faça código fake.

Não crie dados fiscais inventados.

Não simule autorização fiscal como se fosse real.

Mocks são permitidos exclusivamente em testes e devem ser claramente identificados.

Quando não souber uma regra fiscal, pare e consulte documentação oficial ou me informe que a regra precisa ser confirmada.

O objetivo é construir gradualmente um sistema de vendas realmente utilizável comercialmente, capaz de crescer de uma pequena loja para múltiplas lojas e múltiplos clientes SaaS sem precisar reconstruir toda a arquitetura.