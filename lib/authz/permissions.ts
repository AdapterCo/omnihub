// Catálogo central de permissões (instrucoes.md §4). Nenhum código deve verificar
// papéis (`role === 'admin'`) fora de lib/authz; toda checagem de autorização deve
// referenciar um destes códigos.
export const PERMISSION_CODES = [
 'STORE_VIEW','STORE_CREATE','STORE_EDIT',
 'PRODUCT_VIEW','PRODUCT_CREATE','PRODUCT_EDIT','PRODUCT_DELETE',
 'STOCK_VIEW','STOCK_ADJUST','STOCK_TRANSFER',
 'SALE_CREATE','SALE_CANCEL','SALE_DISCOUNT',
 'CASH_OPEN','CASH_CLOSE','CASH_SUPPLY','CASH_WITHDRAWAL',
 'CUSTOMER_VIEW','CUSTOMER_CREATE','CUSTOMER_EDIT',
 'SUPPLIER_VIEW','SUPPLIER_CREATE','SUPPLIER_EDIT',
 'FISCAL_VIEW','FISCAL_CONFIG','FISCAL_ISSUE','FISCAL_CANCEL',
 'USER_VIEW','USER_CREATE','USER_EDIT',
 'REPORT_VIEW',
 'AUDIT_VIEW',
] as const;
export type PermissionCode = typeof PERMISSION_CODES[number];
export const isPermissionCode = (value: string): value is PermissionCode => (PERMISSION_CODES as readonly string[]).includes(value);
