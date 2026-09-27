// Modelos de contrato versionados (instrucao-sistema-vendas.md §4–§7, §33).
//
// O texto de cada modelo é a transcrição fiel do PDF fornecido pelo responsável do negócio
// (docs/contratos/originais/). Só as áreas variáveis do modelo viram placeholders {{...}};
// cláusulas não são reescritas, resumidas nem corrigidas. Mudança de texto = nova versão
// (nunca editar uma versão já usada: contratos antigos guardam a versão com que foram gerados).
//
// Marcação dentro dos textos: **negrito**, __itálico__, {{placeholder}}.
//
// Ajustes nas áreas variáveis, todos pedidos/confirmados pelo usuário em 2026-09-26:
// - Locação: CNPJ da locadora "15.243.489/0001-08" (o PDF trazia "15.243.489.999/0001-08",
//   com dígitos a mais); título "MINUTA" mantido; o ano fixo "2026" da linha de data e o
//   "__/__/__" da moto passam a ser a data real de geração do contrato.
// - Moto: "[Contato]" é preenchido com telefone e e-mail do cadastro do cliente.

export type Block =
 | { kind: 'title'; text: string }
 | { kind: 'heading'; text: string }
 | { kind: 'p'; text: string }
 | { kind: 'bullet'; text: string }
 | { kind: 'space'; size?: number }
 | { kind: 'signature'; role: 'loja' | 'cliente'; label: string };

export type ContractTemplate = {
 key: 'contrato-moto' | 'contrato-locacao';
 version: number;
 orderType: 'VENDA' | 'LOCACAO';
 // O texto cita a empresa pelo nome: o modelo só pode ser gerado pela loja com este CNPJ.
 ownerCnpj: string;
 ownerName: string;
 title: string;
 style: { titleSize: number; titleAlign: 'center' | 'left'; titleBold: boolean; headingSize: number; headingBold: boolean; bodySize: number; justify: boolean; pageNumbers: boolean };
 // Regra de garantia centralizada por versão (moto: 90 dias corridos a partir da compra, cláusula 4.1).
 warrantyDays?: number;
 required: { key: string; label: string }[];
 blocks: Block[];
};

const MOTO_V1: ContractTemplate = {
 key: 'contrato-moto',
 version: 1,
 orderType: 'VENDA',
 ownerCnpj: '65715457000128',
 ownerName: 'D-MAX MOBILIDADE URBANA',
 title: 'Contrato de compra e venda e termo de garantia e qualidade',
 style: { titleSize: 22, titleAlign: 'center', titleBold: false, headingSize: 13, headingBold: false, bodySize: 10.5, justify: false, pageNumbers: false },
 warrantyDays: 90,
 required: [
  { key: 'cliente.nome', label: 'nome do cliente' },
  { key: 'cliente.documento', label: 'CPF/CNPJ do cliente' },
  { key: 'cliente.endereco_completo', label: 'endereço completo do cliente (logradouro, número, bairro, cidade e UF)' },
  { key: 'cliente.email', label: 'e-mail do cliente (necessário para o convite de assinatura)' },
  { key: 'produto.modelo', label: 'produto/modelo' },
  { key: 'produto.cor', label: 'cor' },
  { key: 'produto.chassi_serie', label: 'chassi/série' },
  { key: 'pedido.data_compra', label: 'data da compra' },
  { key: 'pedido.valor', label: 'valor' },
  { key: 'pedido.forma_pagamento', label: 'forma de pagamento' },
 ],
 blocks: [
  { kind: 'title', text: 'CONTRATO DE COMPRA E VENDA E TERMO DE GARANTIA E QUALIDADE' },
  { kind: 'p', text: '**VENDEDOR (CONTRATADA):** D-MAX MOBILIDADE URBANA' },
  { kind: 'p', text: 'CNPJ: 65.715.457/0001-28' },
  { kind: 'space' },
  { kind: 'p', text: 'Este documento formaliza a compra e a garantia do produto adquirido junto à D-Max Mobilidade Urbana, estabelecendo os direitos e deveres do consumidor em conformidade com a legislação brasileira vigente.' },
  { kind: 'heading', text: '1. IDENTIFICAÇÃO DO CLIENTE (COMPRADOR / CONTRATANTE)' },
  { kind: 'bullet', text: '**Cliente:** {{cliente.nome}}' },
  { kind: 'bullet', text: '**CPF/CNPJ:** {{cliente.documento}}' },
  { kind: 'bullet', text: '**Endereço:** {{cliente.endereco_completo}}' },
  { kind: 'p', text: '**Telefone / E-mail:** {{cliente.contato}}' },
  { kind: 'heading', text: '2. ESPECIFICAÇÕES DO PRODUTO E COMPRA' },
  { kind: 'bullet', text: '**Produto (Modelo):** {{produto.modelo}}' },
  { kind: 'bullet', text: '**Cor:** {{produto.cor}}' },
  { kind: 'bullet', text: '**Chassi/Série:** {{produto.chassi_serie}}' },
  { kind: 'bullet', text: '**Data da Compra:** {{pedido.data_compra}}' },
  { kind: 'bullet', text: '**Valor:** {{pedido.valor}}' },
  { kind: 'bullet', text: '**Forma de Pagamento:** {{pedido.forma_pagamento}}' },
  { kind: 'space' },
  { kind: 'p', text: 'O COMPRADOR declara estar ciente de todas as especificações do produto adquirido, incluindo suas características técnicas, modo de funcionamento e autonomia da bateria.' },
  { kind: 'heading', text: '3. DA ENTREGA E CHECKLIST TÉCNICO' },
  { kind: 'p', text: '**3.1. Retirada:** O produto será retirado diretamente nas dependências do VENDEDOR, que se compromete a realizar a entrega técnica, explicando o funcionamento geral (motor, módulo, fiação, bateria, carregamento, chaves, controles, alarmes e limpeza).' },
  { kind: 'p', text: '**3.2. Checklist:** No ato da entrega, são verificados e validados pelo COMPRADOR:' },
  { kind: 'bullet', text: '__Visualização externa:__ Carenagem, paralama, painel, farol, setas, parafusos, bateria, chaves e cabos;' },
  { kind: 'bullet', text: '__Itens inclusos:__ Carregador, jogos de chaves, controles, retrovisores;' },
  { kind: 'bullet', text: '__Teste de funcionamento:__ Liga/desliga, freios, guidão, botões, limitador de velocidade e manetes;' },
  { kind: 'p', text: '__Regras de uso:__ Velocidade limitada (conforme legislação vigente para dispensa de CNH e registro, quando aplicável).' },
  { kind: 'p', text: '3.3. O COMPRADOR declara estar ciente e de acordo com as informações prestadas durante a entrega técnica e no manual, eximindo o VENDEDOR de qualquer responsabilidade decorrente do mau uso do produto.' },
  { kind: 'heading', text: '4. PRAZOS E CONDIÇÕES DE GARANTIA' },
  { kind: 'p', text: '**4.1. Prazo:** O produto possui garantia de 90 (noventa) dias corridos a partir da data de compra, conforme artigo 26, inciso II do Código de Defesa do Consumidor (CDC).' },
  { kind: 'p', text: '**4.2. Cobertura:** Esta garantia cobre exclusivamente defeitos e vícios inerentes de fabricação observados durante o uso normal do equipamento (com foco no módulo, motor e bateria).' },
  { kind: 'p', text: '**4.3. Análise Técnica:** O acionamento da garantia dar-se-á mediante análise técnica realizada pela D-Max. O cliente deve apresentar o produto juntamente com este termo e a nota fiscal. Em cumprimento ao Art. 18 do CDC, o fornecedor possui o prazo máximo de 30 (trinta) dias para analisar o defeito, sanar o vício e entregar o produto em perfeitas condições de uso.' },
  { kind: 'heading', text: '5. EXCLUSÕES DA GARANTIA (PERDA DE COBERTURA)' },
  { kind: 'p', text: 'Ficam expressamente excluídos da garantia danos causados por mau uso, inatividade, manutenções inadequadas, quedas, acidentes, exposição indevida a intempéries ou modificações não autorizadas. Especificamente, **NÃO estão cobertos**:' },
  { kind: 'p', text: '**5.1. Motor e Módulo Eletrônico:** Danos por contato com água ou oxidação; falhas no chicote elétrico; derretimento/avarias em conectores; aro empenado; danos em rolamentos e eixo; superaquecimento; queima; abertura, modificação ou violação por terceiros.' },
  { kind: 'p', text: '**5.2. Bateria:** Danos por contato com água/oxidação; derretimento de conectores; superaquecimento; queima; redução da autonomia decorrente de uso prolongado ou desgaste natural; modificação/violação; utilização de carregadores genéricos ou incompatíveis.' },
  { kind: 'p', text: '**5.3. Desgaste Natural:** Peças sujeitas a desgaste natural (ex: pneus, pastilhas, freios, lâmpadas).' },
  { kind: 'p', text: '**5.4. Falta de Cuidados Básicos:** Danos resultantes de sobrecarga, impactos, falta de manutenção preventiva, armazenamento inadequado ou inatividade prolongada.' },
  { kind: 'heading', text: '6. LOGÍSTICA E TRANSPORTE (SERVIÇO NÃO INCLUSO)' },
  { kind: 'p', text: '**6.1. Obrigação:** Fica estabelecido que a D-MAX MOBILIDADE URBANA não possui qualquer obrigação legal ou contratual de realizar a busca, coleta, resgate, reboque ou entrega do veículo no endereço do contratante ou em qualquer outro local, não havendo prestação de serviço de "leva e traz" de forma gratuita.' },
  { kind: 'p', text: '**6.2. Finalidade:** O envio e retirada do veículo às dependências da loja da contratada para quaisquer finalidades (incluindo revisões, manutenções preventivas/corretivas e avaliações de garantia) são de responsabilidade exclusiva do contratante.' },
  { kind: 'p', text: '**6.3. Custos e Riscos:** Todos os custos financeiros (frete, guincho, transportadora, combustível), bem como os riscos associados ao translado do veículo (avarias, sinistros, furtos ou roubos em trajeto), deverão ser integralmente suportados pelo contratante, isentando a contratada de qualquer responsabilidade.' },
  { kind: 'heading', text: '7. SEGURANÇA E CONDIÇÕES DE USO' },
  { kind: 'p', text: '**7.1. Estabilizador de Energia (Obrigatório):** Recomenda-se fortemente o uso de um estabilizador de energia, filtro de linha com proteção contra surtos ou nobreak durante o carregamento. Isso protege o carregador e a bateria contra picos de energia. **A não utilização de proteção contra surtos elétricos acarreta a anulação da garantia em caso de queima por oscilação da rede.**' },
  { kind: 'p', text: '**7.2. Proteção e Clima:** É obrigatório o uso de equipamentos de proteção (capacete, etc.). Evite pilotar em chuvas intensas para prevenir acidentes e danos elétricos. Estacione em locais cobertos, protegidos da exposição direta ao sol e à chuva ou utilize uma capa.' },
  { kind: 'heading', text: '8. DESBLOQUEIO DE LIMITADOR DE VELOCIDADE' },
  { kind: 'p', text: '**8.1.** A D-MAX não autoriza nem se responsabiliza por qualquer tipo de desbloqueio do limitador de velocidade original.' },
  { kind: 'p', text: '**8.2.** Fica expressamente proibida a adulteração, modificação ou desbloqueio do sistema de limitação por terceiros ou pelo próprio comprador.' },
  { kind: 'p', text: '**8.3.** Qualquer intervenção técnica fora da assistência autorizada relacionada ao desbloqueio do limitador acarretará a **imediata perda da garantia**, independentemente do tempo restante.' },
  { kind: 'heading', text: '9. DISPOSIÇÕES GERAIS' },
  { kind: 'p', text: '**9.1.** O COMPRADOR declara estar ciente de todas as cláusulas deste contrato.' },
  { kind: 'p', text: '**9.2. Acessório de Assento:** O COMPRADOR declara estar ciente de que eventual acessório instalado na parte traseira trata-se de um "limitador de assento" e não de um encosto funcional/ergonômico para a coluna. O uso inadequado como encosto de força pode gerar quebras, não cabendo trocas ou reembolsos baseados em função que o item não possui.' },
  { kind: 'p', text: '**9.3.** Qualquer alteração neste contrato só será válida se formalizada por escrito e assinada por ambas as partes.' },
  { kind: 'heading', text: '10. VALIDADE' },
  { kind: 'p', text: 'A garantia é válida até o término do prazo de 90 dias, encerrando-se em: {{pedido.garantia_ate}}.' },
  { kind: 'space' },
  { kind: 'p', text: 'Por estarem justos e acordados, assinam o presente contrato em duas vias de igual teor e forma.' },
  { kind: 'space' },
  { kind: 'p', text: 'Volta Redonda - RJ, {{pedido.data_contrato}}' },
  { kind: 'space', size: 24 },
  { kind: 'signature', role: 'loja', label: '**D-MAX MOBILIDADE URBANA**' },
  { kind: 'signature', role: 'cliente', label: '**{{cliente.nome_assinatura}}**' },
 ],
};

const LOCACAO_V1: ContractTemplate = {
 key: 'contrato-locacao',
 version: 1,
 orderType: 'LOCACAO',
 ownerCnpj: '15243489000108',
 ownerName: 'F C Eletrônicos LTDA - ME (Grupo Cell)',
 title: 'Minuta de contrato: locação de equipamento eletrônico com opção de compra',
 style: { titleSize: 13, titleAlign: 'left', titleBold: true, headingSize: 10.5, headingBold: true, bodySize: 10.5, justify: true, pageNumbers: true },
 required: [
  { key: 'cliente.nome', label: 'nome do cliente' },
  { key: 'cliente.cpf', label: 'CPF do cliente (a locação exige CPF)' },
  { key: 'cliente.endereco_completo', label: 'endereço completo do cliente (logradouro, número, bairro, cidade e UF)' },
  { key: 'cliente.email', label: 'e-mail do cliente (necessário para o convite de assinatura)' },
  { key: 'produto.modelo', label: 'modelo do aparelho' },
  { key: 'produto.cor', label: 'cor' },
  { key: 'produto.memoria', label: 'memória' },
  { key: 'produto.imei', label: 'IMEI' },
  { key: 'produto.estado_aparelho', label: 'estado do aparelho' },
  { key: 'pedido.valor_adesao', label: 'valor da adesão' },
  { key: 'pedido.valor_mensalidade', label: 'valor da mensalidade' },
  { key: 'pedido.dia_vencimento', label: 'dia de vencimento' },
 ],
 blocks: [
  { kind: 'title', text: 'MINUTA DE CONTRATO: LOCAÇÃO DE EQUIPAMENTO ELETRÔNICO COM OPÇÃO DE COMPRA' },
  { kind: 'p', text: '**LOCADORA:** F C Eletrônicos LTDA - ME, 15.243.489/0001-08, de nome fantasia Grupo Cell, com sede em Avenida Paulo de Frontin, 213 no Bairro Aterrado, no município de Volta Redonda, estado do Rio de Janeiro.' },
  { kind: 'p', text: '**LOCATÁRIO:** {{cliente.nome}}, PORTADOR DO CPF DE NÚMERO {{cliente.cpf}}, RESIDE EM {{cliente.endereco_completo}}.' },
  { kind: 'heading', text: 'CLÁUSULA PRIMEIRA - DO OBJETO' },
  { kind: 'p', text: '**1.1.** O objeto deste contrato é a locação do equipamento {{produto.modelo}}, cor {{produto.cor}}, memória {{produto.memoria}}, IMEI {{produto.imei}} e estado do aparelho: {{produto.estado_aparelho}}.' },
  { kind: 'heading', text: 'CLÁUSULA SEGUNDA - DA ADESÃO E DO ALUGUEL' },
  { kind: 'p', text: '**2.1.** No ato da assinatura, o **LOCATÁRIO** pagará a quantia de {{pedido.valor_adesao}} a título de **Taxa de Adesão e Ativação**, valor este não reembolsável de forma alguma.' },
  { kind: 'p', text: '**2.2.** O **LOCATÁRIO** pagará 12 (doze) mensalidades de {{pedido.valor_mensalidade}}, com vencimento todo dia {{pedido.dia_vencimento}} de cada mês.' },
  { kind: 'p', text: '**2.3**. O atraso no pagamento ensejará multa de 2% e juros de 1% ao mês, além de autorizar a **LOCADORA** a proceder com o **bloqueio remoto do equipamento** após **7 dias de atraso,** podendo ser feita posterior à essa data mediante aviso que seguirá de mensagem via Whatsapp e Ligação via Wi-fi.' },
  { kind: 'heading', text: 'CLÁUSULA TERCEIRA - DA MANUTENÇÃO E SINISTROS' },
  { kind: 'p', text: '**3.1.** A responsabilidade pela guarda, conservação e da integridade física e funcional do equipamento recai exclusiva e integralmente sobre o **LOCATÁRIO** durante todo o período de vigência da locação.' },
  { kind: 'p', text: '**3.2.** Em caso de roubo, furto ou dano total, o **LOCATÁRIO** obriga-se a indenizar a **LOCADORA** pelo valor de mercado do aparelho à época do evento, não cessando a obrigação do pagamento das mensalidades vincendas.' },
  { kind: 'p', text: '**3.3. DA MANUTENÇÃO EXCLUSIVA E PERDA DE GARANTIA:** Fica expressamente proibida a realização de qualquer serviço de reparo, manutenção, abertura do aparelho, substituição de peças ou instalação de softwares não oficiais por terceiros ou assistências técnicas não autorizadas. Durante o período de garantia, todo e qualquer reparo ou análise técnica deverá ser realizado **exclusivamente no estabelecimento da Grupo Cell**.' },
  { kind: 'p', text: '**3.4. DA EXCLUSÃO DE COBERTURA E MANUTENÇÃO DA DÍVIDA:** A violação do item 3.3, caracterizada por qualquer intervenção não autorizada no equipamento, acarretará a **perda imediata, automática e irrevogável de qualquer garantia legal ou contratual**, bem como extinguir qualquer possibilidade de troca ou substituição do bem pela **LOCADORA**.' },
  { kind: 'p', text: '**3.5. DA OBRIGAÇÃO FINANCEIRA CONTÍNUA:** Na hipótese de o equipamento apresentar falhas, vícios ou parar de funcionar de forma definitiva em decorrência de intervenção de terceiros não autorizados (conforme item 3.3), **o LOCATÁRIO permanecerá integralmente obrigado ao pagamento de todas as mensalidades vincendas e em aberto deste contrato**. A inutilização do aparelho por quebra de garantia não cessa, suspende ou atenua a obrigação financeira assumida.' },
  { kind: 'heading', text: 'CLÁUSULA QUARTA - DA PROPRIEDADE E DA OPÇÃO DE COMPRA' },
  { kind: 'p', text: '**4.1.** A propriedade do bem permanece com a **LOCADORA** durante toda a vigência deste contrato.' },
  { kind: 'p', text: '**4.2. OPÇÃO DE COMPRA:** Ao término do pagamento das 12 (doze) mensalidades mensais, e estando o **LOCATÁRIO** em dia com todas as suas obrigações, este terá o direito de adquirir a propriedade definitiva do bem mediante o pagamento da taxa residual de **R$ 19,90 (dezenove reais e noventa centavos)**.' },
  { kind: 'p', text: '**4.3.** Caso o **LOCATÁRIO** não manifeste o interesse na compra ou não realize o pagamento da taxa residual em até 5 dias antes do término das 12 mensalidades, deverá restituir o bem à **LOCADORA** em 48 horas úteis.' },
  { kind: 'heading', text: 'CLÁUSULA QUINTA - DA PROTEÇÃO CONTRA FRAUDES E INADIMPLÊNCIA' },
  { kind: 'p', text: '**5.1.** O **LOCATÁRIO** autoriza expressamente a instalação do iCloud do Grupo Cell, que poderá rastrear a localização do dispositivo em caso de inadimplência e efetuar a formatação e bloqueio total das funções do aparelho, o que acarretará em perda de dados não alocados na nuvem.' },
  { kind: 'p', text: '**5.2. DA RETENÇÃO ILÍCITA E PENALIDADES CIVIS:** A não devolução do aparelho no prazo estipulado após o término do contrato, ou a recusa na devolução em caso de rescisão por inadimplência, configurará posse de má-fé e retenção ilícita do equipamento de propriedade da **LOCADORA**.' },
  { kind: 'p', text: '**5.2.1.** Uma vez configurada a retenção ilícita, a **LOCADORA** fica expressamente autorizada a adotar, de forma cumulativa, as seguintes medidas para a proteção do seu patrimônio:' },
  { kind: 'p', text: '**I. Bloqueio Tecnológico Definitivo:** Manutenção do bloqueio integral das funcionalidades do dispositivo via sistema de gestão (iCloud), inutilizando o aparelho até a sua efetiva recuperação. **II. Reintegração de Posse:** Ingresso imediato com a competente Ação de Reintegração de Posse.' },
  { kind: 'p', text: '**5.2.2.** Fica estabelecido que o **LOCATÁRIO** arcará integralmente com todas as despesas decorrentes da cobrança extrajudicial, custas processuais e honorários advocatícios, desde já fixados em 20% (vinte por cento) sobre o valor total da dívida atualizada, caso seja necessária a intervenção jurídica para a recuperação do bem.' },
  { kind: 'heading', text: 'CLÁUSULA SEXTA - DO FORO' },
  { kind: 'p', text: '**6.1.** Fica eleito o Foro da Comarca de Volta Redonda, Rio de Janeiro.' },
  { kind: 'heading', text: 'CLÁUSULA SÉTIMA - DA DEVOLUÇÃO ANTECIPADA E RESCISÃO A PEDIDO DO LOCATÁRIO' },
  { kind: 'p', text: '**7.1. DA FACULDADE DE DEVOLUÇÃO:** É facultado ao **LOCATÁRIO**, a qualquer momento durante a vigência deste instrumento, realizar a devolução do equipamento e solicitar a rescisão do contrato, o que acarretará o cancelamento imediato de todas as mensalidades futuras (vincendas).' },
  { kind: 'p', text: '**7.2. DA DEVOLUÇÃO POR CLIENTE ADIMPLENTE**: Estando o **LOCATÁRIO** com todas as mensalidades quitadas até a data da entrega do equipamento, a rescisão será efetivada sem a incidência de multas rescisórias ou cobranças adicionais, ressalvadas as disposições sobre avarias (Item 7.4).' },
  { kind: 'p', text: '**7.3. DA DEVOLUÇÃO POR CLIENTE INADIMPLENTE**: Caso o **LOCATÁRIO** possua mensalidades em atraso no ato da devolução, o contrato será rescindido no que tange às parcelas futuras. No entanto, o débito correspondente às parcelas já vencidas e não pagas até a data da entrega do aparelho permanecerá ativo e integralmente exigível.' },
  { kind: 'p', text: '**7.3.1.** O **LOCATÁRIO** reconhece que a devolução do aparelho não extingue a dívida pretérita, estando a **LOCADORA** autorizada a manter as medidas de cobrança extrajudicial, judicial e a manutenção do nome nos órgãos de proteção ao crédito (SPC/Serasa) até a quitação total do saldo vencido.' },
  { kind: 'p', text: '**7.4. DA AVALIAÇÃO TÉCNICA INTERNA E AVARIAS:** Independentemente de o **LOCATÁRIO** estar adimplente ou inadimplente, a aprovação da rescisão sem custos adicionais está condicionada a uma avaliação técnica presencial, realizada exclusivamente pela equipe da Grupo Cell no momento da recepção do aparelho.' },
  { kind: 'p', text: '**7.4.1.** A **LOCADORA** isenta o **LOCATÁRIO** de custos referentes ao desgaste natural decorrente do uso regular do equipamento.' },
  { kind: 'p', text: '**7.4.2.** Contudo, caso a análise técnica da **LOCADORA** constante danos consideráveis que depreciem o bem (tais como, mas não se limitando a: trincas na tela ou carcaça, oxidação, danos em componentes internos, quebra de lentes ou falhas por mau uso), o contrato principal será encerrado, mas o custo exato do reparo será integralmente repassado ao **LOCATÁRIO**.' },
  { kind: 'p', text: '**7.4.3.** O valor orçado para o reparo das avarias constituirá uma dívida autônoma, líquida e certa, devendo ser quitada pelo **LOCATÁRIO** através de boleto avulso ou PIX. O não pagamento do reparo sujeitará o cliente às sanções de cobrança e negativação.' },
  { kind: 'heading', text: 'CLÁUSULA OITAVA - DO RISCO DE CRÉDITO, INADIMPLÊNCIA E POLÍTICA DE RENEGOCIAÇÃO' },
  { kind: 'p', text: '**8.1. DO ALTO RISCO E AUSÊNCIA DE GARANTIAS:** O **LOCATÁRIO** reconhece que a presente locação e a entrega do equipamento são realizadas sem a exigência de garantias reais, caução ou fiadores, configurando uma operação de crédito de alto risco para a **LOCADORA**. Por essa razão, o cumprimento rigoroso dos prazos de pagamento é condição essencial para a manutenção da posse do aparelho.' },
  { kind: 'p', text: '**8.2. DA NEGATIVAÇÃO:** Fica o **LOCATÁRIO** expressamente ciente de que a gestão de recebíveis e a emissão das cobranças são operacionalizadas de forma automatizada através da instituição bancária. O atraso no pagamento de qualquer parcela ensejará a imediata e automática inclusão do CPF do **LOCATÁRIO** nos cadastros de inadimplentes e órgãos de proteção ao crédito (**SPC, SERASA**, Boa Vista, etc.), além do acionamento do bloqueio remoto do dispositivo, independentemente de notificação extrajudicial.' },
  { kind: 'p', text: '**8.3. DA COMUNICAÇÃO PRÉVIA E VONTADE DE NEGOCIAR:** A **Grupo Cell** atua com base na transparência e na flexibilidade. Caso o **LOCATÁRIO** preveja qualquer dificuldade financeira que impossibilite o pagamento na data acordada, este compromete-se a avisar a **LOCADORA** com **antecedência mínima de 3 dias** do vencimento pelo contato **(24) 99940-3331** pelo aplicativo de mensagens WhatsApp. Mediante o aviso prévio, a **LOCADORA** demonstra sua total e irrestrita disposição para analisar o caso, reorganizar o fluxo de pagamento e renegociar as mensalidades pendentes ou a vencer.' },
  { kind: 'p', text: '**8.4. DA POLÍTICA DE CONCILIAÇÃO E SUPORTE AO CLIENTE:** A política da Grupo Cell é de escuta ativa e auxílio mútuo. A empresa compromete-se a manter canais abertos para ouvir as pendências do **LOCATÁRIO** e fará todos os esforços comerciais possíveis para auxiliar na regularização da dívida, tendo como prioridade absoluta a conciliação para não permitir que o **LOCATÁRIO** fique sem o uso do seu aparelho, desde que haja comunicação e intenção clara de pagamento por parte do mesmo.' },
  { kind: 'heading', text: 'CLÁUSULA NONA - DA RETENÇÃO DOCUMENTAL, NOTA FISCAL E QUITAÇÃO ANTECIPADA' },
  { kind: 'p', text: '**9.1. DA RETENÇÃO DA NOTA FISCAL:** Considerando que a natureza jurídica deste contrato é de locação, o **LOCATÁRIO** declara ciência de que a Nota Fiscal original de compra do equipamento é o documento comprobatório da propriedade exclusiva da **Grupo Cell**, permanecendo sob a guarda e posse estrita da **LOCADORA** durante toda a vigência deste instrumento.' },
  { kind: 'p', text: '**9.2. DA PROIBIÇÃO DE REVENDA:** O **LOCATÁRIO** não possui autorização legal para vender, empenhar, sublocar, ceder ou transferir o equipamento a terceiros sob nenhuma hipótese, sendo a ausência da Nota Fiscal em seu nome um mecanismo de proteção ao patrimônio da **LOCADORA**.' },
  { kind: 'p', text: '**9.3. DA QUITAÇÃO ANTECIPADA E DESCONTOS:** É facultado ao **LOCATÁRIO**, a qualquer momento durante a vigência do contrato, manifestar o interesse em realizar a quitação antecipada de todas as mensalidades vincendas somadas ao valor residual de compra (R$ 19,90). Nesta hipótese, a **Grupo Cell** compromete-se a analisar o pedido e reserva-se o direito de conceder, a seu exclusivo critério comercial, um desconto especial e negociável para o pagamento à vista do saldo devedor.' },
  { kind: 'p', text: '**9.4. DA TRANSFERÊNCIA DE PROPRIEDADE E ENTREGA DA NOTA:** Apenas após a liquidação total e integral do contrato — seja pelo decurso do prazo de 12 (doze) meses e pagamento do valor residual, ou mediante acordo de quitação antecipada devidamente pago —, a propriedade do equipamento será transferida em definitivo ao **LOCATÁRIO**. Somente neste momento, a **LOCADORA** providenciará a entrega da Nota Fiscal (ou documento de transferência de titularidade/recibo de venda) ao **LOCATÁRIO**, consolidando a posse e a propriedade plenas em nome deste e realizará a remoção do iCloud Grupo Cell.' },
  { kind: 'heading', text: 'CLÁUSULA DÉCIMA - DA CONFIGURAÇÃO TÉCNICA E GESTÃO DO DISPOSITIVO' },
  { kind: 'p', text: '**10.1. DA CONTA ADMINISTRATIVA (ICLOUD GRUPO CELL):** O **LOCATÁRIO** declara estar ciente e concorda que o equipamento será entregue com uma conta iCloud de propriedade e posse exclusiva da **Grupo Cell** vinculada como conta principal do sistema. Esta conta tem finalidade estritamente administrativa, servindo como ferramenta de segurança, rastreamento de hardware e bloqueio remoto em caso de descumprimento contratual.' },
  { kind: 'p', text: '**10.1.1.** É expressamente proibida qualquer tentativa de alteração, remoção ou substituição da conta iCloud administrativa da **LOCADORA**, sob pena de rescisão imediata do contrato e aplicação de multa por infração contratual grave.' },
  { kind: 'p', text: '**10.2. DA CONTA DE USUÁRIO (APP STORE E SERVIÇOS):** Para garantir a personalização e privacidade, o **LOCATÁRIO** deverá utilizar sua própria conta pessoal para a instalação de aplicativos, compras na App Store e sincronização de dados via navegador (Safari) e outros serviços nativos. **10.2.1.** A **LOCADORA** não possui, em nenhuma hipótese, acesso às senhas, dados bancários, históricos de navegação ou informações privadas inseridas pelo **LOCATÁRIO** em sua conta secundária de uso pessoal.' },
  { kind: 'p', text: '**10.3. DO COMPROMISSO DE NÃO INTERFERÊNCIA:** A **Grupo Cell** compromete-se formalmente a não acessar as informações de uso do dispositivo, respeitando o sigilo de dados do **LOCATÁRIO**. O acesso administrativo via iCloud principal limitará sua atuação às funções de: **a)** Localização geográfica do hardware para fins de segurança; **b)** Bloqueio total do aparelho em caso de inadimplência ou sinistro; **c)** Emissão de alertas sonoros em caso de perda.' },
  { kind: 'p', text: '**10.4. DA RESPONSABILIDADE PELO CONTEÚDO:** O **LOCATÁRIO** é o único responsável civil e criminalmente por todo o conteúdo baixado, visualizado ou compartilhado através do dispositivo durante o período de locação, eximindo a **Grupo Cell** de qualquer responsabilidade sobre o uso ilícito do hardware ou de sua conexão com a internet.' },
  { kind: 'space', size: 36 },
  { kind: 'signature', role: 'loja', label: 'GRUPO CELL' },
  { kind: 'signature', role: 'cliente', label: '**{{cliente.nome_assinatura}} - CPF {{cliente.cpf}}**' },
  { kind: 'space' },
  { kind: 'p', text: 'Volta Redonda, {{pedido.data_contrato_extenso}}' },
 ],
};

export const TEMPLATES: ContractTemplate[] = [MOTO_V1, LOCACAO_V1];

/** Versão vigente do modelo para o tipo de pedido. */
export function currentTemplateFor(orderType: 'VENDA' | 'LOCACAO'): ContractTemplate {
 const list = TEMPLATES.filter((t) => t.orderType === orderType).sort((a, b) => b.version - a.version);
 return list[0];
}

export function templateByKey(key: string, version: number): ContractTemplate | undefined {
 return TEMPLATES.find((t) => t.key === key && t.version === version);
}

const PLACEHOLDER = /\{\{\s*([a-z_]+\.[a-z_]+)\s*\}\}/g;

export function placeholdersOf(template: ContractTemplate): string[] {
 const found = new Set<string>();
 for (const b of template.blocks) {
  const text = 'text' in b ? b.text : 'label' in b ? b.label : '';
  for (const m of text.matchAll(PLACEHOLDER)) found.add(m[1]);
 }
 return [...found];
}

/** Substitui os placeholders; placeholder sem valor é erro (nunca sai "[Nome do Cliente]" no PDF). */
export function fillText(text: string, values: Record<string, string>): string {
 return text.replace(PLACEHOLDER, (_, key: string) => {
  const value = values[key];
  if (value === undefined || value === '') throw new Error(`Placeholder sem valor: ${key}`);
  return value;
 });
}
