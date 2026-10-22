// Campos que o lojista pode marcar no modelo de contrato (editor de modelos) e que o motor de
// contratos preenche a partir do pedido. Sem dependência de servidor: a tela também usa.
// Cada campo só vale para os tipos de pedido em que o dado existe; o valor sempre vem do
// cadastro/pedido — campo sem dado bloqueia a geração (nunca um valor "razoável").

export type OrderType = 'VENDA' | 'LOCACAO';
export type ContractField = { key: string; label: string; group: 'Cliente' | 'Produto' | 'Pedido' | 'Loja' | 'Condições'; types: OrderType[]; example: string };

const BOTH: OrderType[] = ['VENDA', 'LOCACAO'];

export const CONTRACT_FIELDS: ContractField[] = [
 { key: 'cliente.nome', label: 'Nome do cliente', group: 'Cliente', types: BOTH, example: 'Maria da Silva' },
 { key: 'cliente.nome_assinatura', label: 'Nome do cliente em maiúsculas', group: 'Cliente', types: BOTH, example: 'MARIA DA SILVA' },
 { key: 'cliente.documento', label: 'CPF/CNPJ do cliente', group: 'Cliente', types: BOTH, example: '000.000.000-00' },
 { key: 'cliente.cpf', label: 'CPF do cliente (só pessoa física)', group: 'Cliente', types: BOTH, example: '000.000.000-00' },
 { key: 'cliente.endereco_completo', label: 'Endereço completo do cliente', group: 'Cliente', types: BOTH, example: 'Rua Exemplo, 100, Centro, Cidade - UF, CEP 00000-000' },
 { key: 'cliente.telefone', label: 'Telefone do cliente', group: 'Cliente', types: BOTH, example: '(00) 00000-0000' },
 { key: 'cliente.email', label: 'E-mail do cliente', group: 'Cliente', types: BOTH, example: 'cliente@exemplo.com' },
 { key: 'cliente.contato', label: 'Telefone e e-mail do cliente', group: 'Cliente', types: BOTH, example: '(00) 00000-0000 / cliente@exemplo.com' },
 { key: 'produto.modelo', label: 'Modelo do produto', group: 'Produto', types: BOTH, example: 'Modelo do produto' },
 { key: 'produto.cor', label: 'Cor', group: 'Produto', types: BOTH, example: 'Preta' },
 { key: 'produto.chassi_serie', label: 'Chassi/série', group: 'Produto', types: ['VENDA'], example: 'CHASSI0000000000' },
 { key: 'produto.imei', label: 'IMEI', group: 'Produto', types: ['LOCACAO'], example: '000000000000000' },
 { key: 'produto.memoria', label: 'Memória', group: 'Produto', types: ['LOCACAO'], example: '128 GB' },
 { key: 'produto.estado_aparelho', label: 'Estado do aparelho', group: 'Produto', types: ['LOCACAO'], example: 'Seminovo' },
 { key: 'pedido.numero', label: 'Número do pedido', group: 'Pedido', types: BOTH, example: '123' },
 { key: 'pedido.data_contrato', label: 'Data do contrato (dd/mm/aaaa)', group: 'Pedido', types: BOTH, example: '01/01/2026' },
 { key: 'pedido.data_contrato_extenso', label: 'Data do contrato por extenso', group: 'Pedido', types: BOTH, example: '1 de janeiro de 2026' },
 { key: 'pedido.data_hora_geracao', label: 'Data e hora em que o contrato foi gerado', group: 'Pedido', types: BOTH, example: '01/01/2026 10:00' },
 { key: 'pedido.data_compra', label: 'Data da compra', group: 'Pedido', types: ['VENDA'], example: '01/01/2026' },
 { key: 'pedido.valor', label: 'Valor da venda', group: 'Pedido', types: ['VENDA'], example: 'R$ 0,00' },
 { key: 'pedido.forma_pagamento', label: 'Forma de pagamento', group: 'Pedido', types: ['VENDA'], example: 'À vista (Pix)' },
 { key: 'pedido.valor_adesao', label: 'Valor da adesão', group: 'Pedido', types: ['LOCACAO'], example: 'R$ 0,00' },
 { key: 'pedido.valor_mensalidade', label: 'Valor da mensalidade', group: 'Pedido', types: ['LOCACAO'], example: 'R$ 0,00' },
 { key: 'pedido.dia_vencimento', label: 'Dia do vencimento das mensalidades', group: 'Pedido', types: ['LOCACAO'], example: '10' },
 { key: 'pedido.garantia_ate', label: 'Garantia até (data)', group: 'Pedido', types: BOTH, example: '01/04/2026' },
 { key: 'loja.razao_social', label: 'Razão social da loja', group: 'Loja', types: BOTH, example: 'Empresa Exemplo Ltda' },
 { key: 'loja.cnpj', label: 'CNPJ da loja', group: 'Loja', types: BOTH, example: '00.000.000/0000-00' },
 { key: 'contrato.garantia_dias', label: 'Prazo de garantia (dias)', group: 'Condições', types: BOTH, example: '90' },
 { key: 'contrato.multa', label: 'Multa por atraso (%)', group: 'Condições', types: ['LOCACAO'], example: '2%' },
 { key: 'contrato.juros', label: 'Juros por atraso (% ao mês)', group: 'Condições', types: ['LOCACAO'], example: '1%' },
 { key: 'contrato.residual', label: 'Valor residual da compra', group: 'Condições', types: ['LOCACAO'], example: 'R$ 0,00' },
];

export const FIELD_BY_KEY = new Map(CONTRACT_FIELDS.map((f) => [f.key, f]));
export const PLACEHOLDER_PATTERN = /\{\{\s*([a-z_]+\.[a-z_]+)\s*\}\}/g;

export function placeholdersIn(text: string): string[] {
 return [...new Set([...String(text ?? '').matchAll(PLACEHOLDER_PATTERN)].map((m) => m[1]))];
}

/**
 * Dados que parecem pessoais/identificadores deixados no texto do modelo (fora dos campos):
 * vindos do contrato de exemplo usado na importação. A empresa pode ter os próprios dados fixos
 * (CNPJ, telefone, e-mail da loja) — por isso a publicação pede confirmação, não bloqueia.
 */
export function suspiciousFixedData(text: string): string[] {
 const plain = String(text ?? '').replace(PLACEHOLDER_PATTERN, ' ').replace(/\*\*|__/g, '');
 const found = new Set<string>();
 const patterns: [RegExp, string][] = [
  [/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, 'e-mail'],
  [/\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g, 'CPF'],
  [/\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b/g, 'CNPJ'],
  [/\b\d{15}\b/g, 'IMEI'],
  [/\b\d{14}\b/g, 'CNPJ'],
  [/\b\d{11}\b/g, 'CPF ou telefone'],
  [/\(?\b\d{2}\)?\s?9?\d{4}-?\d{4}\b/g, 'telefone'],
  [/\b\d{5}-\d{3}\b/g, 'CEP'],
  [/\b\d{4}-\d{2}-\d{2}\b/g, 'data'],
  [/\b\d{2}\/\d{2}\/\d{4}\b/g, 'data'],
  [/R\$\s?\d{1,3}(\.\d{3})*,\d{2}/g, 'valor em reais'],
 ];
 for (const [re, label] of patterns) for (const m of plain.matchAll(re)) found.add(`${m[0].trim()} (${label})`);
 return [...found].slice(0, 30);
}
