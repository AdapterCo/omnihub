# INSTRUÇÃO DE DESENVOLVIMENTO --- SISTEMA DE VENDAS + CONTRATOS + ADAPTER SIGN

## 1. OBJETIVO

Desenvolver uma aplicação web completa para gestão de clientes,
produtos, pedidos, documentos, observações, tarefas, notificações e
contratos.

O sistema deve seguir visualmente a referência fornecida pelo usuário e,
principalmente, automatizar a geração dos contratos a partir dos dados
já cadastrados no sistema.

Na criação/fechamento de um pedido:

1.  o usuário seleciona um cliente cadastrado;
2.  seleciona o produto;
3.  informa os dados comerciais e os dados específicos necessários ao
    contrato;
4.  o sistema identifica automaticamente qual modelo de contrato deve
    ser usado;
5.  gera um PDF final com os dados reais do cliente, produto e pedido;
6.  inclui no PDF os marcadores exigidos pelo Adapter Sign;
7.  envia o PDF ao Adapter Sign;
8.  registra no pedido o envelope, código de validação e status;
9.  disponibiliza o link de assinatura do cliente;
10. após a conclusão da assinatura, recebe o webhook;
11. baixa automaticamente o PDF final assinado e o relatório de
    evidências;
12. salva ambos na aba "Documentos" do pedido/cliente.

A integração com assinatura deve seguir rigorosamente o arquivo
`integracao-sistema-vendas.md`.

------------------------------------------------------------------------

## 2. REGRA FUNDAMENTAL: NÃO INVENTAR INFORMAÇÕES

Não criar campos, regras jurídicas, endpoints, comportamentos da API,
textos contratuais ou dados que não estejam definidos nos arquivos
fornecidos ou neste documento.

Quando uma informação obrigatória estiver ausente:

-   não preencher com dados fictícios;
-   não usar valores genéricos silenciosamente;
-   não enviar contrato incompleto para assinatura;
-   informar claramente ao usuário quais campos estão faltando.

Os textos jurídicos dos contratos fornecidos devem ser tratados como
modelos oficiais. O sistema pode substituir somente os campos variáveis
previstos. Não reescrever, resumir, corrigir ou alterar cláusulas
automaticamente.

------------------------------------------------------------------------

## 3. ARQUIVOS DE REFERÊNCIA OBRIGATÓRIOS

Usar como fonte de verdade:

-   `ContratoMoto.pdf`
-   `ContratoLocacao.pdf`
-   `integracao-sistema-vendas.md`
-   imagem de referência da interface enviada pelo usuário

Os PDFs originais devem permanecer preservados no projeto como
referência/versionamento do conteúdo contratual.

------------------------------------------------------------------------

## 4. TIPOS DE CONTRATO

O sistema terá inicialmente pelo menos dois tipos:

### 4.1. CONTRATO DE COMPRA E VENDA / MOTO

Modelo: `ContratoMoto.pdf`

Identificador recomendado no sistema:

`contrato-moto`

O contrato possui dados variáveis de cliente e da compra.

Campos identificados no modelo:

#### Cliente

-   nome completo;
-   CPF/CNPJ;
-   endereço completo;
-   telefone;
-   e-mail.

#### Produto/compra

-   produto/modelo;
-   cor;
-   chassi/série;
-   data da compra;
-   valor;
-   forma de pagamento.

#### Garantia

-   data final da garantia.

#### Fechamento

-   data da assinatura/contrato;
-   nome do cliente na área de assinatura.

A data final da garantia deve ser calculada conforme a regra definida no
próprio contrato/modelo vigente. O modelo fornecido atualmente declara
garantia de 90 dias corridos a partir da compra. A implementação deve
deixar essa regra centralizada/configurável por versão do modelo,
evitando datas digitadas manualmente quando puderem ser calculadas.

### 4.2. CONTRATO DE LOCAÇÃO

Modelo: `ContratoLocacao.pdf`

Identificador recomendado:

`contrato-locacao`

O sistema deve substituir as áreas variáveis explicitamente existentes
no documento.

#### Locatário

-   nome completo do cliente;
-   CPF;
-   endereço:
    -   rua;
    -   número;
    -   complemento, quando houver;
    -   bairro;
    -   cidade;
    -   estado;
    -   CEP, se estiver disponível no cadastro, ainda que sua exibição
        dependa do template.

#### Equipamento

-   modelo do iPhone/equipamento;
-   cor;
-   memória;
-   IMEI;
-   estado do aparelho.

#### Condições financeiras

-   valor da adesão;
-   valor do aluguel/mensalidade;
-   dia/data de vencimento.

#### Fechamento

-   nome do cliente;
-   CPF;
-   data do contrato.

Não modificar automaticamente as demais cláusulas do contrato.

------------------------------------------------------------------------

## 5. ARQUITETURA DOS MODELOS DE CONTRATO

Não implementar a geração por coordenadas fixas sobre o PDF como
mecanismo principal.

Criar templates próprios do sistema, preferencialmente HTML/CSS,
reproduzindo fielmente o conteúdo e a estrutura dos PDFs fornecidos.
Depois converter o HTML final para PDF.

Motivos:

-   textos de cliente podem ter comprimentos diferentes;
-   endereços podem ocupar mais espaço;
-   valores e modelos podem variar;
-   o Adapter Sign exige marcadores como texto real no PDF;
-   HTML → PDF facilita paginação, versionamento e manutenção.

Cada template deve possuir versão.

Exemplo:

-   `contrato-moto-v1`
-   `contrato-locacao-v1`

O pedido deve guardar qual versão foi usada. Alterar um template no
futuro nunca pode modificar contratos antigos.

------------------------------------------------------------------------

## 6. PLACEHOLDERS INTERNOS

Usar placeholders explícitos no template.

Exemplo para contrato de moto:

`{{cliente.nome}}` `{{cliente.documento}}`
`{{cliente.endereco_completo}}` `{{cliente.telefone}}`
`{{cliente.email}}` `{{produto.nome}}` `{{produto.cor}}`
`{{produto.chassi_serie}}` `{{pedido.data_compra}}` `{{pedido.valor}}`
`{{pedido.forma_pagamento}}` `{{pedido.garantia_ate}}`
`{{pedido.data_contrato}}`

Exemplo para locação:

`{{cliente.nome}}` `{{cliente.cpf}}` `{{cliente.endereco_completo}}`
`{{produto.modelo}}` `{{produto.cor}}` `{{produto.memoria}}`
`{{produto.imei}}` `{{produto.estado_aparelho}}`
`{{pedido.valor_adesao}}` `{{pedido.valor_mensalidade}}`
`{{pedido.dia_vencimento}}` `{{pedido.data_contrato}}`

Os nomes exatos podem ser adaptados ao padrão do projeto, desde que haja
um mapeamento centralizado e não exista substituição de texto espalhada
pelo código.

------------------------------------------------------------------------

## 7. VALIDAÇÃO ANTES DA GERAÇÃO

Antes de gerar qualquer contrato, executar validação de campos
obrigatórios.

### Moto

No mínimo:

-   cliente;
-   CPF/CNPJ;
-   endereço;
-   produto/modelo;
-   cor;
-   chassi/série;
-   data da compra;
-   valor;
-   forma de pagamento.

### Locação

No mínimo:

-   cliente;
-   CPF;
-   endereço;
-   modelo;
-   cor;
-   memória;
-   IMEI;
-   estado do aparelho;
-   valor da adesão;
-   valor da mensalidade;
-   vencimento.

Se faltar algo, bloquear a geração e mostrar uma mensagem objetiva, por
exemplo:

`Não foi possível gerar o contrato. Preencha: CPF do cliente, IMEI e valor da mensalidade.`

Nunca gerar PDF com textos como:

`[Nome do Cliente]` `CPF` `MODELO DO IPHONE` `VALOR DO ALUGUEL`

quando o documento estiver sendo criado para uso real.

------------------------------------------------------------------------

## 8. GERAÇÃO DO PDF

Fluxo:

`dados do pedido → validação → template versionado → HTML preenchido → marcadores Adapter Sign → PDF`

Requisitos:

-   formato A4;
-   fontes incorporadas ou seguras;
-   texto pesquisável/selecionável;
-   não rasterizar o contrato inteiro;
-   manter paginação estável;
-   evitar campos cortados;
-   evitar sobreposição;
-   preservar acentuação;
-   moeda no padrão brasileiro;
-   datas no padrão `dd/mm/aaaa`;
-   CPF/CNPJ formatados para apresentação;
-   gerar hash SHA-256 do PDF original;
-   armazenar data/hora da geração;
-   armazenar versão do template;
-   armazenar snapshot dos dados utilizados.

O snapshot é obrigatório para auditoria. Se o cadastro do cliente ou
produto for alterado depois, o contrato já criado não pode mudar.

------------------------------------------------------------------------

## 9. MARCADORES DO ADAPTER SIGN

O PDF enviado ao Adapter Sign precisa conter os marcadores exigidos pela
integração.

Obrigatórios:

`[[AS:assinatura:loja]]`

`[[AS:assinatura:cliente]]`

Opcionais quando aplicável:

`[[AS:rubrica:cliente]]`

`[[AS:nome:cliente]]`

`[[AS:data:cliente]]`

Os marcadores precisam existir como TEXTO no PDF.

Não podem:

-   ser imagem;
-   ser convertidos em curvas;
-   desaparecer durante a geração do PDF.

Podem ficar visualmente invisíveis usando fonte pequena e cor compatível
com o fundo, conforme a integração.

Posicionar cada marcador de assinatura logo acima da linha de assinatura
correspondente.

### Contrato Moto

Na área final:

-   assinatura da D-MAX/loja → marcador `loja`;
-   assinatura do comprador → marcador `cliente`.

### Contrato Locação

Na área final:

-   assinatura GRUPO CELL/locadora → marcador `loja`;
-   assinatura do cliente/locatário → marcador `cliente`.

A implementação deve permitir configurar rubricas por template sem
precisar alterar a lógica principal.

------------------------------------------------------------------------

## 10. INTEGRAÇÃO COM ADAPTER SIGN

Base da API definida no documento fornecido:

`https://sign.adapterco.com.br/api/v1`

A API key deve existir SOMENTE no backend.

Nunca:

-   colocar API key no JavaScript do navegador;
-   retornar a API key para o frontend;
-   salvar segredo de webhook sem proteção;
-   registrar segredo/API key em logs.

### Envio

Usar:

`POST /envelopes/from-template`

Formato:

`multipart/form-data`

Partes:

-   `file`: PDF gerado;
-   `data`: JSON da operação.

Exemplo lógico:

``` json
{
  "template": "contrato-moto",
  "externalRef": "pedido-123",
  "title": "Contrato de venda #123 — Nome do Cliente",
  "signers": [
    {
      "role": "loja",
      "name": "Nome do vendedor logado",
      "email": "email@loja.com",
      "externalId": "id-interno-vendedor"
    },
    {
      "role": "cliente",
      "name": "Nome do cliente",
      "email": "cliente@email.com",
      "cpf": "CPF",
      "phone": "+55..."
    }
  ]
}
```

Para locação, alterar o template para `contrato-locacao`.

### Vendedor logado

O signatário de papel `loja` deve representar o vendedor autenticado que
concluiu o pedido.

Guardar:

-   ID interno;
-   nome;
-   e-mail.

Enviar o ID interno em `externalId`.

### externalRef

Deve ser único por contrato.

Padrão recomendado:

`pedido-{pedidoId}`

ou, se houver múltiplos contratos no mesmo pedido:

`pedido-{pedidoId}-{tipo}-{versao}`

Exemplo:

`pedido-123-contrato-moto-v1`

Se um contrato cancelado precisar ser recriado como novo documento,
gerar nova revisão, por exemplo:

`pedido-123-contrato-moto-v2`

Não gerar `externalRef` aleatório a cada retry.

------------------------------------------------------------------------

## 11. IDEMPOTÊNCIA E RETENTATIVAS

O mesmo `externalRef` deve ser reutilizado em retentativas da mesma
operação.

Tratar:

-   `400 VALIDATION_ERROR`: mostrar erro de cadastro;
-   `404 TEMPLATE_NOT_FOUND`: configuração/template inválido;
-   `422 TEMPLATE_ANCHORS_MISMATCH`: PDF/marcadores incorretos;
-   `422 COMPANY_SIGNATURE_NOT_AUTHORIZED`: configuração da organização;
-   `402 PLAN_LIMIT_REACHED`: informar limite do plano;
-   `409 CONTRACT_IN_PROGRESS`: retentar após pequeno intervalo;
-   `429`, `5xx` e timeout: retentativa com backoff.

Nunca criar silenciosamente um novo contrato apenas porque ocorreu
timeout.

------------------------------------------------------------------------

## 12. DADOS RETORNADOS PELO ADAPTER SIGN

Após `201`, salvar no banco:

-   `envelope_id`;
-   `external_ref`;
-   `validation_code`;
-   status;
-   ID do documento;
-   SHA-256 retornado, quando aplicável;
-   ID do signatário loja;
-   ID do signatário cliente;
-   timestamps.

O `signingUrl` do cliente deve ser tratado como credencial temporária.

Não armazená-lo como link permanente.

Quando necessário, gerar um novo link usando:

`POST /envelopes/{id}/signers/{signerId}/link`

------------------------------------------------------------------------

## 13. WEBHOOK

Criar endpoint backend específico, por exemplo:

`POST /webhooks/adapter-sign`

Eventos recomendados:

-   `signer.signed`
-   `signer.declined`
-   `envelope.completed`
-   `envelope.expired`
-   `envelope.cancelled`

Requisitos obrigatórios:

1.  validar assinatura HMAC usando o corpo bruto da requisição;
2.  rejeitar assinatura inválida;
3.  deduplicar por `X-Adapter-Event-ID`;
4.  registrar evento recebido;
5.  responder `2xx` rapidamente;
6.  processar tarefas demoradas fora do ciclo principal da requisição.

Nunca confiar apenas no conteúdo JSON sem validar a assinatura.

------------------------------------------------------------------------

## 14. CONCLUSÃO DO CONTRATO

Ao receber:

`envelope.completed`

o backend deve:

1.  localizar o pedido por `external_ref`;
2.  confirmar o envelope correspondente;
3.  baixar o PDF final:
    `GET /envelopes/{id}/documents/{documentId}/final`
4.  baixar o relatório de evidências: `GET /envelopes/{id}/evidence`
5.  armazenar os dois arquivos;
6.  calcular hashes locais;
7.  criar registros na aba Documentos;
8.  atualizar o contrato para `COMPLETED`;
9.  registrar data/hora da conclusão;
10. manter `validationCode`.

O contrato assinado não pode sobrescrever o PDF original gerado. Guardar
os dois.

Sugestão de tipos:

-   `CONTRATO_ORIGINAL`
-   `CONTRATO_ASSINADO`
-   `EVIDENCIA_ASSINATURA`

------------------------------------------------------------------------

## 15. STATUS DO CONTRATO NO PEDIDO

Mapear visualmente:

-   criado localmente;
-   enviando;
-   aguardando assinatura do cliente;
-   cliente assinou / finalizando;
-   contrato assinado;
-   recusado;
-   expirado;
-   cancelado;
-   erro de integração.

O status técnico da API deve ser armazenado separadamente do texto
amigável mostrado ao usuário.

------------------------------------------------------------------------

## 16. TELA DE PEDIDOS

Seguir a estrutura visual da referência enviada.

Menu principal:

-   Home
-   Clientes
-   Pedidos
-   Produtos
-   Notificações
-   Tarefas

Na ficha do pedido, manter uma coluna/resumo com:

-   número do pedido;
-   chave/identificador;
-   cliente;
-   produto;
-   vendedor;
-   chassi/série ou identificador do equipamento;
-   garantia até, quando aplicável;
-   data de cadastro;
-   status do pedido;
-   status do contrato.

Área principal com abas:

-   Pedido
-   Observações
-   Documentos
-   Logs

Pode existir uma aba/área específica de contrato se isso melhorar a UX,
mas as informações finais também precisam aparecer em Documentos.

------------------------------------------------------------------------

## 17. ABA PEDIDO

Exibir todos os dados comerciais e permitir edição enquanto o pedido
ainda estiver em estado editável.

Deve conter uma seção "Contrato" com:

-   tipo de contrato;
-   versão do template;
-   status;
-   botão `Gerar contrato`;
-   botão `Visualizar PDF`;
-   botão `Enviar para assinatura`;
-   botão `Copiar link de assinatura`, quando disponível;
-   botão `Gerar novo link`, quando necessário;
-   botão `Cancelar`, se suportado pelo fluxo/API;
-   código de validação após envio/conclusão.

Evitar geração automática irreversível apenas ao selecionar produto. O
usuário deve conseguir revisar os dados antes do envio.

------------------------------------------------------------------------

## 18. ABA DOCUMENTOS

Reproduzir o comportamento da referência.

### Upload manual

Campos:

-   descrição;
-   arquivo.

Tipos inicialmente aceitos:

-   PDF;
-   JPG;
-   JPEG;
-   PNG.

A validação deve existir no frontend e backend.

### Lista

Cada documento deve mostrar:

-   descrição;
-   data/hora;
-   tipo/tag;
-   usuário responsável, quando aplicável;
-   botão visualizar;
-   botão baixar, se desejado;
-   botão excluir apenas quando permitido.

Documentos automáticos devem ser identificados claramente.

Exemplos:

`Contrato gerado automaticamente`

`Contrato assinado`

`Relatório de evidências Adapter Sign`

Para contratos assinados e evidências, a exclusão deve ser restrita por
permissão e preferencialmente usar exclusão lógica/auditoria, não
remoção física silenciosa.

------------------------------------------------------------------------

## 19. ABA OBSERVAÇÕES

Permitir:

-   criar observação;
-   mostrar autor;
-   data/hora;
-   histórico;
-   edição apenas conforme permissão;
-   registrar alterações relevantes.

Observações não devem ser misturadas com logs técnicos.

------------------------------------------------------------------------

## 20. ABA LOGS

Criar trilha de auditoria legível.

Registrar eventos como:

-   pedido criado;
-   pedido alterado;
-   contrato gerado;
-   falha de validação;
-   PDF criado;
-   contrato enviado ao Adapter Sign;
-   envelope criado;
-   link renovado;
-   webhook recebido;
-   cliente assinou;
-   contrato concluído;
-   PDF final baixado;
-   evidência baixada;
-   documento anexado/excluído;
-   usuário responsável.

Não registrar:

-   API keys;
-   segredo do webhook;
-   códigos temporários;
-   conteúdo sensível desnecessário.

------------------------------------------------------------------------

## 21. CLIENTES

Cadastro deve suportar os campos necessários aos contratos.

Campos recomendados pelo requisito atual:

-   ID;
-   nome completo/razão social;
-   CPF/CNPJ;
-   e-mail;
-   telefone/WhatsApp;
-   CEP;
-   logradouro;
-   número;
-   complemento;
-   bairro;
-   cidade;
-   UF;
-   data de cadastro;
-   status.

CPF/CNPJ deve ser normalizado no banco e formatado na interface.

O sistema deve permitir consultar os pedidos e documentos relacionados
ao cliente.

------------------------------------------------------------------------

## 22. PRODUTOS

O cadastro de produto precisa suportar diferentes categorias.

Campos comuns:

-   ID;
-   código/SKU;
-   nome/modelo;
-   categoria;
-   descrição;
-   status.

### Categoria moto/scooter

Campos adicionais:

-   cor;
-   chassi/série;
-   dados necessários à venda.

### Categoria celular/equipamento de locação

Campos adicionais:

-   modelo;
-   cor;
-   memória;
-   IMEI;
-   estado do aparelho.

IMPORTANTE: chassi e IMEI normalmente identificam uma unidade física. A
arquitetura deve separar, se necessário, o "modelo do produto" da
"unidade/serial em estoque", para não colocar um único IMEI/chassi no
cadastro genérico de um modelo compartilhado.

------------------------------------------------------------------------

## 23. PEDIDOS

Campos mínimos sugeridos:

-   `id`
-   `numero`
-   `chave`
-   `cliente_id`
-   `vendedor_id`
-   `tipo_operacao`
-   `produto_id`
-   `unidade_produto_id`, quando aplicável
-   `valor_total`
-   `forma_pagamento`
-   `data_compra`
-   `status`
-   `created_at`
-   `updated_at`

Campos específicos podem ser armazenados em tabelas próprias ou
estrutura bem tipada. Evitar um JSON genérico para tudo quando os campos
forem essenciais para consulta e validação.

Tipos iniciais:

-   venda;
-   locação.

O tipo de operação deve determinar qual contrato é elegível.

------------------------------------------------------------------------

## 24. ESTRUTURA DE BANCO PARA CONTRATOS

Criar uma entidade própria de contratos.

Exemplo conceitual:

``` text
contracts
- id
- order_id
- customer_id
- contract_type
- template_key
- template_version
- external_ref
- envelope_id
- validation_code
- adapter_status
- internal_status
- original_document_id
- signed_document_id
- evidence_document_id
- original_sha256
- signed_sha256
- payload_snapshot
- generated_by_user_id
- generated_at
- sent_at
- completed_at
- created_at
- updated_at
```

Criar também tabela de eventos/webhooks processados para deduplicação.

Exemplo:

``` text
adapter_sign_events
- id
- event_id UNIQUE
- event_type
- envelope_id
- external_ref
- received_at
- processed_at
- status
- error
```

------------------------------------------------------------------------

## 25. DOCUMENTOS

Exemplo conceitual:

``` text
documents
- id
- customer_id
- order_id
- contract_id
- type
- description
- original_filename
- storage_key
- mime_type
- size
- sha256
- source
- uploaded_by_user_id
- created_at
- deleted_at
```

`source` pode diferenciar:

-   `manual`
-   `system`
-   `adapter_sign`

Nunca confiar no nome do arquivo fornecido pelo usuário para criar
caminho de armazenamento.

------------------------------------------------------------------------

## 26. ARMAZENAMENTO DE ARQUIVOS

Criar uma abstração de storage.

O banco guarda metadados e a chave do objeto, não o PDF inteiro, salvo
decisão arquitetural justificada.

Estrutura lógica sugerida:

``` text
clientes/{clienteId}/pedidos/{pedidoId}/contratos/{contractId}/original.pdf
clientes/{clienteId}/pedidos/{pedidoId}/contratos/{contractId}/assinado.pdf
clientes/{clienteId}/pedidos/{pedidoId}/contratos/{contractId}/evidencias.pdf
clientes/{clienteId}/pedidos/{pedidoId}/documentos/{uuid}-{arquivo}
```

Não expor caminhos internos diretamente.

Downloads devem passar por autorização ou URL temporária segura.

------------------------------------------------------------------------

## 27. AUTENTICAÇÃO E PERFIS

O sistema deve ter autenticação.

Perfis mínimos sugeridos:

### Administrador

-   acesso completo;
-   configurações;
-   usuários;
-   integrações;
-   templates;
-   documentos;
-   auditoria.

### Vendedor

-   clientes;
-   produtos;
-   pedidos;
-   geração/envio de contrato;
-   documentos permitidos;
-   observações.

### Consulta/operacional

-   acesso limitado conforme necessidade.

Todas as ações sensíveis precisam ser validadas no backend. Ocultar
botão no frontend não é controle de segurança.

------------------------------------------------------------------------

## 28. CONFIGURAÇÕES DA LOJA

Criar área segura para:

-   organização/loja;
-   dados da empresa;
-   template Adapter Sign para contrato de moto;
-   template Adapter Sign para locação;
-   API key Adapter Sign;
-   segredo de webhook;
-   status da integração.

Segredos devem ser cifrados em repouso ou armazenados em secret
manager/variáveis seguras.

Nunca exibir novamente o valor integral do segredo após cadastro.

------------------------------------------------------------------------

## 29. FRONTEND

Interface:

-   desktop-first e responsiva;
-   visual limpo;
-   menu superior semelhante à referência;
-   cards;
-   abas;
-   feedback claro de loading;
-   confirmação para ações destrutivas;
-   mensagens de erro úteis;
-   sem mensagens técnicas cruas para usuário comum.

Na tela de geração:

1.  mostrar dados que entrarão no contrato;
2.  destacar campos ausentes;
3.  permitir pré-visualizar;
4.  somente depois permitir envio para assinatura.

------------------------------------------------------------------------

## 30. BACKEND

Separar responsabilidades:

``` text
controllers/routes
services
repositories
integrations/adapter-sign
contracts/templates
contracts/renderers
storage
webhooks
auth
audit
```

Serviços importantes:

-   `CustomerService`
-   `ProductService`
-   `OrderService`
-   `ContractService`
-   `PdfService`
-   `AdapterSignService`
-   `DocumentService`
-   `WebhookService`
-   `AuditService`

Evitar chamadas diretas ao Adapter Sign espalhadas pelo sistema.

------------------------------------------------------------------------

## 31. FLUXO COMPLETO --- VENDA DE MOTO

1.  vendedor autentica;
2.  seleciona/cria cliente;
3.  seleciona produto/unidade;
4.  informa chassi/série, cor, valor e pagamento;
5.  cria pedido;
6.  sistema identifica `contrato-moto`;
7.  usuário abre a seção Contrato;
8.  backend valida dados;
9.  gera snapshot;
10. renderiza PDF;
11. inclui marcadores Adapter Sign;
12. salva PDF original;
13. usuário visualiza;
14. envia para Adapter Sign;
15. Adapter Sign registra assinatura da loja em nome do vendedor logado;
16. cliente recebe link;
17. sistema mostra `Aguardando assinatura`;
18. webhook informa conclusão;
19. backend baixa PDF final e evidências;
20. salva em Documentos;
21. pedido mostra `Contrato assinado`.

------------------------------------------------------------------------

## 32. FLUXO COMPLETO --- LOCAÇÃO

1.  vendedor autentica;
2.  seleciona cliente;
3.  seleciona aparelho/unidade;
4.  informa/valida modelo, cor, memória, IMEI e estado;
5.  informa adesão, mensalidade e vencimento;
6.  cria pedido de locação;
7.  sistema escolhe `contrato-locacao`;
8.  valida os campos;
9.  cria snapshot;
10. substitui apenas as áreas variáveis do modelo;
11. gera PDF;
12. adiciona marcadores;
13. salva original;
14. envia ao Adapter Sign;
15. acompanha assinatura;
16. recebe webhook;
17. baixa contrato assinado e evidências;
18. anexa automaticamente à ficha.

------------------------------------------------------------------------

## 33. VERSIONAMENTO DE CONTRATOS

Obrigatório.

Cada contrato gerado precisa registrar:

-   tipo;
-   chave do template;
-   versão;
-   hash;
-   snapshot;
-   data.

Ao alterar cláusulas futuramente:

-   criar nova versão;
-   nunca modificar a versão histórica usada por contratos anteriores.

Exemplo:

``` text
contrato-moto/v1
contrato-moto/v2
contrato-locacao/v1
```

------------------------------------------------------------------------

## 34. TESTES OBRIGATÓRIOS

### PDF

Testar:

-   nome curto;
-   nome muito longo;
-   endereço longo;
-   CPF;
-   CNPJ no contrato que o aceitar;
-   valores pequenos/grandes;
-   caracteres acentuados;
-   produto com nome longo;
-   paginação;
-   marcadores presentes como texto.

### Contrato Moto

Verificar se todos os placeholders foram removidos e substituídos.

### Contrato Locação

Verificar especificamente todas as áreas variáveis destacadas no modelo.

### Adapter Sign

Testar:

-   envio válido;
-   template inexistente;
-   marcador ausente;
-   retry com mesmo `externalRef`;
-   link expirado/renovação;
-   webhook válido;
-   webhook com HMAC inválido;
-   webhook duplicado;
-   `envelope.completed`;
-   download final;
-   evidências.

### Segurança

Testar:

-   vendedor tentando acessar pedido sem permissão;
-   upload com MIME inválido;
-   arquivo executável renomeado;
-   path traversal;
-   segredo exposto;
-   webhook falso;
-   acesso direto a documento de outro cliente.

------------------------------------------------------------------------

## 35. CRITÉRIOS DE ACEITE

O projeto só deve ser considerado pronto quando:

-   cliente pode ser cadastrado;
-   produto/unidade pode ser cadastrado;
-   pedido pode ser criado;
-   venda e locação são diferenciadas;
-   contrato correto é escolhido automaticamente;
-   dados obrigatórios são validados;
-   ContratoMoto é gerado em PDF com dados reais;
-   ContratoLocacao é gerado em PDF com dados reais;
-   nenhuma variável/placeholder fica visível no PDF final;
-   marcadores Adapter Sign existem no PDF como texto;
-   PDF pode ser pré-visualizado antes do envio;
-   envio ao Adapter Sign funciona pelo backend;
-   vendedor logado é enviado como representante da loja;
-   `externalRef` é idempotente;
-   envelope e validation code ficam associados ao pedido;
-   status aparece na interface;
-   webhooks têm validação HMAC;
-   eventos duplicados não duplicam processamento;
-   contrato final é baixado automaticamente;
-   relatório de evidências é baixado;
-   documentos aparecem na aba Documentos;
-   logs/auditoria registram o fluxo;
-   contratos antigos permanecem imutáveis;
-   segredos não chegam ao frontend.

------------------------------------------------------------------------

## 36. ORDEM RECOMENDADA DE IMPLEMENTAÇÃO

### Fase 1 --- Base

-   autenticação;
-   usuários;
-   clientes;
-   produtos/unidades;
-   pedidos;
-   permissões;
-   layout.

### Fase 2 --- Documentos

-   storage;
-   upload;
-   visualização;
-   metadados;
-   aba Documentos.

### Fase 3 --- Motor de contratos

-   templates versionados;
-   mapeamento de dados;
-   validação;
-   HTML → PDF;
-   snapshot;
-   hashes;
-   pré-visualização.

### Fase 4 --- Adapter Sign

-   configuração segura;
-   envio;
-   externalRef;
-   persistência do envelope;
-   link;
-   status.

### Fase 5 --- Webhooks

-   HMAC;
-   deduplicação;
-   processamento;
-   download final;
-   evidências.

### Fase 6 --- Auditoria e acabamento

-   logs;
-   observações;
-   notificações;
-   tarefas;
-   tratamento de erros;
-   testes;
-   segurança;
-   backup.

------------------------------------------------------------------------

## 37. REGRAS PARA O AGENTE/CODEX QUE IMPLEMENTAR O PROJETO

1.  Ler integralmente os três arquivos de referência antes de alterar a
    geração de contratos ou a integração.
2.  Não inventar endpoints.
3.  Não inventar campos jurídicos.
4.  Não alterar cláusulas dos contratos sem solicitação explícita.
5.  Não remover requisitos para "simplificar".
6.  Não armazenar segredos no frontend.
7.  Não criar contratos duplicados em retry.
8.  Não gerar PDF incompleto.
9.  Não marcar contrato como assinado antes de confirmação real do
    Adapter Sign.
10. Não simular resposta da integração em produção.
11. Criar migrations versionadas.
12. Criar testes para regras críticas.
13. Manter código modular.
14. Documentar variáveis de ambiente.
15. Atualizar README conforme o projeto evoluir.
16. Antes de concluir cada fase, executar testes e corrigir erros
    encontrados.
17. Nunca substituir arquivos originais de contrato; usar templates
    derivados versionados.
18. Não remover logs de auditoria para resolver problemas de interface.
19. Não expor CPF, documentos ou PDFs em URLs públicas permanentes.
20. Qualquer decisão não definida neste arquivo e que afete regra de
    negócio deve ser implementada de forma configurável ou registrada
    como pendência, não inventada silenciosamente.

------------------------------------------------------------------------

## 38. VARIÁVEIS DE AMBIENTE

Estrutura conceitual:

``` env
DATABASE_URL=
APP_URL=
SESSION_SECRET=

STORAGE_PROVIDER=
STORAGE_BUCKET=
STORAGE_ENDPOINT=
STORAGE_ACCESS_KEY=
STORAGE_SECRET_KEY=

ADAPTER_SIGN_BASE_URL=https://sign.adapterco.com.br/api/v1
ADAPTER_SIGN_API_KEY=
ADAPTER_SIGN_WEBHOOK_SECRET=

CONTRACT_MOTO_TEMPLATE=contrato-moto
CONTRACT_LOCACAO_TEMPLATE=contrato-locacao
```

Em produção, preferir gerenciamento seguro de segredos.

------------------------------------------------------------------------

## 39. OBSERVAÇÃO SOBRE O CONTEÚDO JURÍDICO

O objetivo do desenvolvimento é reproduzir e automatizar os documentos
fornecidos, não revisar sua validade jurídica.

O sistema deve preservar o texto do modelo aprovado pelo responsável
pelo negócio.

Alterações jurídicas devem gerar uma nova versão do template após
aprovação externa do conteúdo.

------------------------------------------------------------------------

## 40. RESULTADO ESPERADO

Ao final, a aplicação deve transformar o processo atual em um fluxo
único:

`CLIENTE → PRODUTO → PEDIDO → CONTRATO → PDF → ADAPTER SIGN → ASSINATURA → PDF FINAL + EVIDÊNCIAS → DOCUMENTOS DO PEDIDO`

O operador não deve precisar digitar novamente no contrato informações
que já existem no cadastro.

A geração deve ser determinística, auditável, versionada e segura.

O Adapter Sign deve ser a fonte do estado de assinatura; o sistema de
vendas deve ser a fonte dos dados comerciais e do vínculo entre cliente,
produto, pedido e documentos.
