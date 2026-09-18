import assert from 'node:assert/strict';
import test from 'node:test';
import { PERMISSION_CODES, type PermissionCode } from '../lib/authz/permissions.ts';
import { SYSTEM_ROLES, ROLE_PERMISSIONS, permissionsForRole } from '../lib/authz/roles.ts';
import { loadPermissions } from '../lib/authz/service.ts';

// Fake mínimo do binding D1 usado por loadPermissions: ignora o texto do SQL e resolve
// pelo par (userId, tenantId), simulando o JOIN user_tenant_roles → role_permissions →
// permissions. Não substitui teste de integração contra D1 real (tests/api-smoke.mjs).
function fakeD1(grants: Map<string, string[]>) {
 return {
  prepare() {
   return {
    bind(userId: string, tenantId: string) {
     const codes = grants.get(`${userId}:${tenantId}`) ?? [];
     return { all: async () => ({ results: codes.map((code) => ({ code })) }) };
    },
   };
  },
 } as unknown as D1Database;
}

test('Todo código do catálogo de permissões (§4) é concedido a pelo menos um papel', () => {
 const granted = new Set(SYSTEM_ROLES.flatMap((role) => ROLE_PERMISSIONS[role]));
 for (const code of PERMISSION_CODES) assert.ok(granted.has(code), `permissão ${code} não é concedida a nenhum papel`);
});

test('OWNER e ADMIN têm acesso administrativo completo dentro do tenant', () => {
 assert.deepEqual([...permissionsForRole('OWNER')].sort(), [...PERMISSION_CODES].sort());
 assert.deepEqual([...permissionsForRole('ADMIN')].sort(), [...PERMISSION_CODES].sort());
});

test('CONSULTA é somente leitura', () => {
 for (const code of permissionsForRole('CONSULTA')) assert.ok(code.endsWith('_VIEW'), code);
});

test('OPERADOR_CAIXA vende e opera o próprio caixa, mas não administra loja/produto/estoque/fiscal/usuários', () => {
 const perms = permissionsForRole('OPERADOR_CAIXA');
 for (const code of ['SALE_CREATE', 'CASH_OPEN', 'CASH_CLOSE', 'CASH_SUPPLY', 'CASH_WITHDRAWAL'] satisfies PermissionCode[]) assert.ok(perms.has(code), code);
 for (const code of ['STORE_CREATE', 'STORE_EDIT', 'PRODUCT_CREATE', 'PRODUCT_EDIT', 'PRODUCT_DELETE', 'STOCK_ADJUST', 'STOCK_TRANSFER', 'FISCAL_ISSUE', 'FISCAL_CANCEL', 'USER_CREATE', 'USER_EDIT'] satisfies PermissionCode[]) assert.ok(!perms.has(code), code);
});

test('ESTOQUISTA movimenta estoque, mas não vende, não abre caixa e não administra loja', () => {
 const perms = permissionsForRole('ESTOQUISTA');
 for (const code of ['STOCK_VIEW', 'STOCK_ADJUST', 'STOCK_TRANSFER'] satisfies PermissionCode[]) assert.ok(perms.has(code), code);
 for (const code of ['SALE_CREATE', 'CASH_OPEN', 'STORE_CREATE', 'STORE_EDIT', 'FISCAL_ISSUE', 'USER_CREATE'] satisfies PermissionCode[]) assert.ok(!perms.has(code), code);
});

test('GERENTE opera catálogo e caixa, mas não emite/cancela documento fiscal nem cria/edita loja', () => {
 const perms = permissionsForRole('GERENTE');
 for (const code of ['PRODUCT_CREATE', 'PRODUCT_EDIT', 'STOCK_ADJUST', 'SALE_DISCOUNT', 'CASH_SUPPLY'] satisfies PermissionCode[]) assert.ok(perms.has(code), code);
 for (const code of ['STORE_CREATE', 'STORE_EDIT', 'PRODUCT_DELETE', 'FISCAL_ISSUE', 'FISCAL_CANCEL', 'USER_CREATE'] satisfies PermissionCode[]) assert.ok(!perms.has(code), code);
});

test('Isolamento entre tenants: vínculo de papel em um tenant não libera permissão em outro tenant do mesmo usuário', async () => {
 const db = fakeD1(new Map([['user-1:tenant-a', ['STORE_VIEW', 'SALE_CREATE']]]));
 const inTenantA = await loadPermissions(db, 'user-1', 'tenant-a', 'operator');
 const inTenantB = await loadPermissions(db, 'user-1', 'tenant-b', 'operator');
 assert.ok(inTenantA.has('SALE_CREATE'));
 // Sem vínculo migrado em tenant-b, cai no papel legado — nunca herda o vínculo de tenant-a.
 assert.deepEqual([...inTenantB].sort(), [...permissionsForRole('OPERADOR_CAIXA')].sort());
});

test('Sem vínculo migrado, cai no mapeamento do papel legado (admin -> OWNER, operator -> OPERADOR_CAIXA)', async () => {
 const db = fakeD1(new Map());
 assert.deepEqual([...(await loadPermissions(db, 'legacy-admin', 'tenant-a', 'admin'))].sort(), [...permissionsForRole('OWNER')].sort());
 assert.deepEqual([...(await loadPermissions(db, 'legacy-op', 'tenant-a', 'operator'))].sort(), [...permissionsForRole('OPERADOR_CAIXA')].sort());
});
