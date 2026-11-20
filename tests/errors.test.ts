import assert from 'node:assert/strict';
import test from 'node:test';
import { RuleError, toRuleError } from '../lib/errors.ts';
import { customerInputSchema } from '../lib/customers/service.ts';
import { createFakeD1 } from './helpers/fakeD1.ts';

// Antes: estes erros caíam no genérico "Não foi possível salvar… tente novamente" (503) e o usuário
// nunca sabia o que corrigir.

test('validação do cadastro (zod) vira 400 com o campo e a mensagem em português', () => {
 const invalid = customerInputSchema.safeParse({ name: 'Maria', email: 'maria-sem-arroba', zip: '123' });
 assert.equal(invalid.success, false);
 const converted = toRuleError(invalid.error);
 assert.ok(converted instanceof RuleError);
 assert.equal(converted.status, 400);
 assert.match(converted.message, /^Confira os campos: /);
 assert.match(converted.message, /E-mail: E-mail inválido\./);
 assert.match(converted.message, /CEP: CEP deve ter 8 dígitos/);
 const unknown = customerInputSchema.safeParse({ name: 'Maria', apelido: 'Mari' });
 assert.match(toRuleError(unknown.error)!.message, /campo não reconhecido \(apelido\)/);
 const missing = customerInputSchema.safeParse({});
 assert.match(toRuleError(missing.error)!.message, /Nome: obrigatório/);
});

test('dado repetido barrado pelo banco vira 409 com o que já existe (SQLite e PostgreSQL)', async () => {
 // Erro real do banco de teste: SKU repetido na mesma conta (índice único idx_products_tenant_sku).
 const db = createFakeD1();
 await db.prepare("INSERT INTO accounts (id,name,state,revision,subscription_status,access_until,max_stores,created_at) VALUES ('t1','T','{}',0,'active',9999999999999,3,0)").bind().run();
 const insert = (id: string) => db.prepare("INSERT INTO products (id, tenant_id, sku, barcode, name, unit, cost_price, sale_price, min_stock, active, created_at, kind) VALUES (?, 't1', 'SKU-1', '', 'Produto', 'UN', 0, 0, 0, 1, 0, 'COMUM')").bind(id).run();
 await insert('p1');
 const duplicate = await insert('p2').then(() => null, (error: unknown) => error);
 assert.ok(duplicate, 'o banco recusa o SKU repetido');
 const converted = toRuleError(duplicate);
 assert.equal(converted?.status, 409);
 assert.match(converted!.message, /produto com este SKU/);
 // Formato do erro do PostgreSQL (driver pg): código 23505 e nome do índice.
 assert.match(toRuleError({ code: '23505', constraint: 'idx_product_units_serial', message: 'duplicate key value' })!.message, /chassi\/IMEI já está cadastrado/);
 assert.match(toRuleError({ code: '23505', constraint: 'idx_users_email', message: 'duplicate key value' })!.message, /e-mail já está em uso/);
 assert.equal(toRuleError({ code: '23505', constraint: 'outro_indice', message: 'duplicate key value' })!.message, 'Já existe um registro com estes dados.');
 assert.equal(toRuleError({ code: '22001', message: 'value too long' })!.status, 400);
});

test('erro desconhecido continua desconhecido (a rota mantém o 503 com código para o log)', () => {
 assert.equal(toRuleError(new Error('conexão recusada')), null);
 assert.equal(toRuleError(null), null);
 assert.equal(toRuleError('texto'), null);
 const rule = new RuleError('Regra', 409);
 assert.equal(toRuleError(rule), rule);
});
