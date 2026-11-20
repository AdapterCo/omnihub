// Erro de domínio compartilhado entre lib/domain.ts e lib/authz (evita import circular).
export class RuleError extends Error {
 status: number;
 constructor(message: string, status = 400) {
  super(message);
  this.status = status;
 }
}

// Nomes dos campos nas mensagens de validação (o restante aparece com o nome técnico).
const FIELD_LABELS: Record<string, string> = {
 name: 'Nome', legalName: 'Razão social', tradeName: 'Nome fantasia', document: 'CPF/CNPJ', cnpj: 'CNPJ', docType: 'Tipo de documento',
 email: 'E-mail', phone: 'Telefone', zip: 'CEP', address: 'Endereço', number: 'Número', complement: 'Complemento', district: 'Bairro',
 city: 'Cidade', state: 'UF', uf: 'UF', ie: 'Inscrição estadual', municipalityCode: 'Código IBGE', contactName: 'Contato',
 sku: 'SKU', barcode: 'Código de barras', price: 'Preço', cost: 'Custo', minimum: 'Estoque mínimo', unit: 'Unidade', kind: 'Tipo do produto',
 modalities: 'Modalidades', regime: 'Regime tributário',
};

type ZodLikeIssue = { code?: string; path?: (string | number)[]; message?: string; keys?: string[] };

function zodMessage(issues: ZodLikeIssue[]): string {
 const parts = issues.slice(0, 5).map((issue) => {
  const key = String(issue.path?.[issue.path.length - 1] ?? '');
  const label = FIELD_LABELS[key] ?? key;
  let message = issue.message ?? 'valor inválido';
  // Mensagens padrão do zod (em inglês) viram texto claro; as próprias do sistema já estão em português.
  if (issue.code === 'unrecognized_keys') message = `campo não reconhecido (${(issue.keys ?? []).join(', ')})`;
  else if (message === 'Required') message = 'obrigatório';
  else if (/^(Expected|Invalid|String must|Number must|Too (small|big))/.test(message)) message = 'valor inválido';
  return label ? `${label}: ${message}` : message;
 });
 return `Confira os campos: ${parts.join('; ')}`;
}

const UNIQUE_MESSAGES: [RegExp, string][] = [
 [/products.*sku|idx_products_tenant_sku/i, 'Já existe um produto com este SKU. Use outro código.'],
 [/product_units.*serial|idx_product_units_serial/i, 'Este chassi/IMEI já está cadastrado.'],
 [/users.*email|idx_users_email/i, 'Este e-mail já está em uso por outro usuário.'],
 [/orders.*number|idx_orders_number/i, 'Outro pedido foi criado ao mesmo tempo. Salve de novo.'],
];

/**
 * Converte erros conhecidos que não são de regra (validação do zod, dado repetido barrado pelo banco,
 * texto longo demais) em RuleError com mensagem clara. Sem isso, a rota respondia o genérico "tente
 * novamente" (503) e o usuário nunca sabia qual campo corrigir. Devolve null para erros desconhecidos.
 */
export function toRuleError(error: unknown): RuleError | null {
 if (error instanceof RuleError) return error;
 if (!error || typeof error !== 'object') return null;
 const e = error as { name?: string; issues?: ZodLikeIssue[]; code?: string; constraint?: string; message?: string };
 if (e.name === 'ZodError' && Array.isArray(e.issues)) return new RuleError(zodMessage(e.issues), 400);
 const message = String(e.message ?? '');
 // PostgreSQL 23505 / SQLite "UNIQUE constraint failed".
 if (e.code === '23505' || /UNIQUE constraint failed/i.test(message)) {
  const where = `${e.constraint ?? ''} ${message}`;
  const known = UNIQUE_MESSAGES.find(([pattern]) => pattern.test(where));
  return new RuleError(known?.[1] ?? 'Já existe um registro com estes dados.', 409);
 }
 // PostgreSQL 22001 (texto maior que a coluna) e 22P02/22003 (valor fora do formato/limite).
 if (e.code === '22001') return new RuleError('Algum campo passou do tamanho permitido. Encurte o texto e salve de novo.', 400);
 if (e.code === '22P02' || e.code === '22003') return new RuleError('Algum campo tem um valor inválido. Confira os números e datas.', 400);
 return null;
}
