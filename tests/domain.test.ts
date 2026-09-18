import assert from 'node:assert/strict';
import test from 'node:test';
import { money, date, requireActive, storeFields, productFields, type Entitlement } from '../lib/domain.ts';

// Fase 3 cortada (cutover): `execute()`/`State`/`visibleState` de lib/domain.ts foram
// removidos porque cash/sale (últimas duas entidades que ainda viviam no JSON) viraram
// relacionais (lib/cash, lib/sales). O que resta em lib/domain.ts são helpers puros e os
// schemas comerciais reaproveitados por lib/catalog — testados aqui.

test('money formata centavos como moeda brasileira', () => {
 assert.match(money(199000), /R\$\s?1\.990,00/);
 assert.match(money(0), /R\$\s?0,00/);
});

test('date formata no fuso de São Paulo', () => {
 assert.match(date(1700000000000), /\d{2}\/\d{2}\/\d{4}/);
});

test('requireActive bloqueia quando o acesso expirou ou está suspenso', () => {
 const now = 1000000;
 const plan: Entitlement = { status: 'trial', accessUntil: now + 10000, maxStores: 3 };
 for (const entitlement of [{ ...plan, accessUntil: now }, { ...plan, status: 'unpaid' }, { ...plan, status: 'canceled' }]) assert.throws(() => requireActive(entitlement, now), /acesso terminou/);
 requireActive(plan, now);
});

test('storeFields exige nome com pelo menos 2 caracteres e valida formatos', () => {
 assert.throws(() => storeFields.parse({ name: 'A' }));
 assert.doesNotThrow(() => storeFields.parse({ name: 'Loja Centro' }));
 assert.throws(() => storeFields.parse({ name: 'Loja', cnpj: '123' }));
 assert.doesNotThrow(() => storeFields.parse({ name: 'Loja', cnpj: '12345678000199' }));
});

test('productFields separa campos comerciais de fiscais e valida NCM/CEST/CFOP', () => {
 const parsed = productFields.parse({ name: 'Produto A', sku: 'SKU-1', price: 1990, cost: 1000, minimum: 2, unit: 'UN', ncm: '12345678' });
 assert.equal(parsed.price, 1990);
 assert.equal(parsed.ncm, '12345678');
 assert.throws(() => productFields.parse({ name: 'Produto A', sku: 'SKU-1', price: 1990, cost: 1000, minimum: 2, unit: 'UN', ncm: '123' }));
});
