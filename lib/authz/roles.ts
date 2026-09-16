import type { PermissionCode } from './permissions.ts';

// Papéis-base sugeridos em instrucoes.md §4. São papéis de sistema (não específicos de
// um tenant) nesta fase; customização de papel por tenant fica para uma fase futura.
export const SYSTEM_ROLES = ['OWNER', 'ADMIN', 'GERENTE', 'OPERADOR_CAIXA', 'ESTOQUISTA', 'CONSULTA'] as const;
export type SystemRole = typeof SYSTEM_ROLES[number];

/**
 * PROPOSTA TÉCNICA (não é regra comercial nem fiscal): matriz padrão de permissões por
 * papel, seguindo os exemplos de §4. O usuário pode pedir ajuste desta matriz a
 * qualquer momento; nenhum valor aqui foi inferido de legislação ou de política
 * comercial do cliente SaaS.
 *
 * - OWNER/ADMIN: acesso administrativo completo dentro do próprio tenant (§4).
 * - GERENTE: operação de loja e catálogo, sem criar/editar lojas, sem excluir produtos,
 *   sem emitir/cancelar documento fiscal (operações críticas ficam com ADMIN/OWNER, §49).
 * - OPERADOR_CAIXA: vender e operar o próprio caixa; sem cancelar venda ou dar desconto
 *   até que exista um mecanismo de limite/autorização (§53), ainda não implementado.
 * - ESTOQUISTA: consultar e movimentar estoque, incluindo transferências.
 * - CONSULTA: somente leitura (inclui auditoria e relatórios).
 */
export const ROLE_PERMISSIONS: Record<SystemRole, readonly PermissionCode[]> = {
 OWNER: ['STORE_VIEW','STORE_CREATE','STORE_EDIT','PRODUCT_VIEW','PRODUCT_CREATE','PRODUCT_EDIT','PRODUCT_DELETE','STOCK_VIEW','STOCK_ADJUST','STOCK_TRANSFER','SALE_CREATE','SALE_CANCEL','SALE_DISCOUNT','CASH_OPEN','CASH_CLOSE','CASH_SUPPLY','CASH_WITHDRAWAL','FISCAL_ISSUE','FISCAL_CANCEL','USER_VIEW','USER_CREATE','USER_EDIT','REPORT_VIEW','AUDIT_VIEW'],
 ADMIN: ['STORE_VIEW','STORE_CREATE','STORE_EDIT','PRODUCT_VIEW','PRODUCT_CREATE','PRODUCT_EDIT','PRODUCT_DELETE','STOCK_VIEW','STOCK_ADJUST','STOCK_TRANSFER','SALE_CREATE','SALE_CANCEL','SALE_DISCOUNT','CASH_OPEN','CASH_CLOSE','CASH_SUPPLY','CASH_WITHDRAWAL','FISCAL_ISSUE','FISCAL_CANCEL','USER_VIEW','USER_CREATE','USER_EDIT','REPORT_VIEW','AUDIT_VIEW'],
 GERENTE: ['STORE_VIEW','PRODUCT_VIEW','PRODUCT_CREATE','PRODUCT_EDIT','STOCK_VIEW','STOCK_ADJUST','STOCK_TRANSFER','SALE_CREATE','SALE_CANCEL','SALE_DISCOUNT','CASH_OPEN','CASH_CLOSE','CASH_SUPPLY','CASH_WITHDRAWAL','USER_VIEW','REPORT_VIEW','AUDIT_VIEW'],
 OPERADOR_CAIXA: ['STORE_VIEW','PRODUCT_VIEW','STOCK_VIEW','SALE_CREATE','CASH_OPEN','CASH_CLOSE','CASH_SUPPLY','CASH_WITHDRAWAL'],
 ESTOQUISTA: ['STORE_VIEW','PRODUCT_VIEW','STOCK_VIEW','STOCK_ADJUST','STOCK_TRANSFER'],
 CONSULTA: ['STORE_VIEW','PRODUCT_VIEW','STOCK_VIEW','REPORT_VIEW','AUDIT_VIEW'],
};

export function permissionsForRole(role: SystemRole): Set<PermissionCode> {
 return new Set(ROLE_PERMISSIONS[role]);
}

// Mapeamento de compatibilidade: os únicos valores de `memberships.role` já gravados em
// produção são 'admin' e 'operator' (ver docs/analise-inicial.md §4). Usado apenas para
// a migração de dados existentes; não deve ser usado para novos vínculos.
export const LEGACY_ROLE_TO_SYSTEM_ROLE: Record<string, SystemRole> = {
 admin: 'OWNER',
 operator: 'OPERADOR_CAIXA',
};
