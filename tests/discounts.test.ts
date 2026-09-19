import assert from 'node:assert/strict';
import test from 'node:test';
import { createFakeD1 } from './helpers/fakeD1.ts';
import { registerAccount, hashPassword } from '../lib/auth/service.ts';
import { loadPermissions } from '../lib/authz/service.ts';
import { createStore, createProduct } from '../lib/catalog/service.ts';
import { openSession, closeSession } from '../lib/cash/service.ts';
import { receiveStock } from '../lib/inventory/service.ts';
import { createSale } from '../lib/sales/service.ts';
import { dispatchCommand } from '../lib/relationalCommands.ts';
import { allocateDiscount, computeDiscountCents, listDiscountLimits, maxDiscountCents, percentToBasisPoints, saveDiscountLimits } from '../lib/sales/discount.ts';
import { buildNFeXml } from '../lib/fiscal/builder.ts';
import { validateNFeXmlSchema } from '../lib/fiscal/validator.ts';
import type { Actor } from '../lib/domain.ts';

// §53 — descontos com limite por papel, autorização de supervisor e registro de quem
// concedeu/autorizou. Nenhum percentual é presumido: sem limite configurado o limite é 0.

const PASSWORD = 'senha-forte-123';
const plan = { status: 'active', accessUntil: 9_999_999_999_999, maxStores: 3 };

async function addMember(db: D1Database, tenantId: string, opts: { email: string; roleId: string; legacyRole: string; name: string }) {
 const userId = crypto.randomUUID();
 await db.prepare('INSERT INTO users (id, display_name, email, password_hash, created_at) VALUES (?,?,?,?,?)').bind(userId, opts.name, opts.email, await hashPassword(PASSWORD), 1).run();
 await db.prepare('INSERT INTO memberships (user_id, account_id, role, store_id, display_name) VALUES (?,?,?,NULL,?)').bind(userId, tenantId, opts.legacyRole, opts.name).run();
 await db.prepare('INSERT INTO user_tenant_roles (id, user_id, tenant_id, role_id) VALUES (?,?,?,?)').bind(crypto.randomUUID(), userId, tenantId, opts.roleId).run();
 return userId;
}
async function actorFor(db: D1Database, tenantId: string, userId: string, legacyRole: string, name: string, storeId: string | null = null): Promise<Actor> {
 return { userId, displayName: name, role: legacyRole, storeId, permissions: await loadPermissions(db, userId, tenantId, legacyRole) };
}

async function fixture() {
 const db = createFakeD1();
 const owner = await registerAccount(db, { accountName: 'Grupo Teste', displayName: 'Dona Ana', email: 'ana@teste.com', password: PASSWORD });
 const tenantId = owner.accountId;
 const ownerActor = await actorFor(db, tenantId, owner.userId, 'admin', 'Dona Ana');
 const storeId = await createStore(db, tenantId, { name: 'Loja Centro', legalName: 'LOJA CENTRO LTDA', cnpj: '12345678000190', ie: '123456789110', uf: 'SP', city: 'São Paulo', municipalityCode: '3550308', address: 'Av Paulista', number: '1000', district: 'Bela Vista', zip: '01310100' } as never, ownerActor);
 const productA = await createProduct(db, tenantId, { name: 'Camiseta', sku: 'CAM-1', price: 5000, cost: 2000, minimum: 1, unit: 'UN' } as never, ownerActor);
 const productB = await createProduct(db, tenantId, { name: 'Boné', sku: 'BON-1', price: 3333, cost: 1000, minimum: 1, unit: 'UN' } as never, ownerActor);
 await receiveStock(db, { tenantId, storeId, productId: productA, quantity: 100, userId: owner.userId, reason: 'Estoque inicial' }, ownerActor);
 await receiveStock(db, { tenantId, storeId, productId: productB, quantity: 100, userId: owner.userId, reason: 'Estoque inicial' }, ownerActor);
 const operatorId = await addMember(db, tenantId, { email: 'op@teste.com', roleId: 'ROLE_OPERADOR_CAIXA', legacyRole: 'operator', name: 'Operador Beto' });
 const managerId = await addMember(db, tenantId, { email: 'gerente@teste.com', roleId: 'ROLE_GERENTE', legacyRole: 'operator', name: 'Gerente Carla' });
 const operator = await actorFor(db, tenantId, operatorId, 'operator', 'Operador Beto', storeId);
 const manager = await actorFor(db, tenantId, managerId, 'operator', 'Gerente Carla', storeId);
 await openSession(db, tenantId, storeId, 10000, operator);
 return { db, tenantId, storeId, productA, productB, owner: ownerActor, operator, manager, ownerId: owner.userId, operatorId, managerId };
}

const sale = (f: Awaited<ReturnType<typeof fixture>>, extra: Record<string, unknown> = {}) => ({
 storeId: f.storeId, items: [{ productId: f.productA, qty: 2 }], customer: '', document: '', ...extra,
});

test('computeDiscountCents: percentual em pontos-base, valor em centavos, nunca zera nem passa do total, exige motivo', () => {
 assert.equal(percentToBasisPoints(5), 500);
 assert.equal(percentToBasisPoints(12.34), 1234);
 assert.throws(() => percentToBasisPoints(1.234), /2 casas/);
 assert.throws(() => percentToBasisPoints(101), /inválido/);
 assert.equal(computeDiscountCents(10000, { percent: 10, reason: 'Cliente antigo' }), 1000);
 assert.equal(computeDiscountCents(10001, { percent: 10, reason: 'Cliente antigo' }), 1000); // arredonda para baixo
 assert.equal(computeDiscountCents(10000, { amount: 250, reason: 'Arredondamento' }), 250);
 assert.throws(() => computeDiscountCents(10000, { percent: 10, amount: 100, reason: 'Motivo' }), /OU em valor/);
 assert.throws(() => computeDiscountCents(10000, { reason: 'Motivo' }), /OU em valor/);
 assert.throws(() => computeDiscountCents(10000, { amount: 10000, reason: 'Motivo' }), /igualar ou superar/);
 assert.throws(() => computeDiscountCents(10000, { amount: 20000, reason: 'Motivo' }), /igualar ou superar/);
 assert.throws(() => computeDiscountCents(100, { percent: 0.5, reason: 'Motivo' }), /zero ou inválido/);
 assert.throws(() => computeDiscountCents(10000, { amount: 100, reason: 'ab' }), /motivo/);
 assert.equal(maxDiscountCents(10000, 500), 500);
 assert.equal(maxDiscountCents(10000, 0), 0);
});

test('allocateDiscount: soma exata, maior resto, nenhuma linha acima do próprio valor', () => {
 const lines = [{ price: 5000, qty: 2 }, { price: 3333, qty: 1 }, { price: 1, qty: 1 }];
 for (const discount of [1, 7, 333, 999, 5000, 13333]) {
  const parts = allocateDiscount(lines, discount);
  assert.equal(parts.reduce((a, b) => a + b, 0), discount, `soma para ${discount}`);
  parts.forEach((p, i) => assert.ok(p >= 0 && p <= lines[i].price * lines[i].qty));
 }
 assert.deepEqual(allocateDiscount(lines, 0), [0, 0, 0]);
 // divisão exata proporcional
 assert.deepEqual(allocateDiscount([{ price: 1000, qty: 1 }, { price: 3000, qty: 1 }], 400), [100, 300]);
});

test('sem limite configurado o operador NÃO tem desconto: pede supervisor (428) e nada é gravado', async () => {
 const f = await fixture();
 await assert.rejects(
  () => createSale(f.db, f.tenantId, sale(f, { payment: 'Dinheiro', discount: { percent: 5, reason: 'Cliente antigo' } }) as never, f.operator),
  (e: { status?: number; message?: string }) => e.status === 428 && /limite \(0,00%\)/.test(e.message ?? ''),
 );
 const rows = await f.db.prepare('SELECT COUNT(*) AS n FROM sales').bind().first<{ n: number }>();
 assert.equal(Number(rows?.n), 0);
});

test('operador dentro do limite configurado vende com desconto: total líquido, desconto rateado, sem autorizador', async () => {
 const f = await fixture();
 await saveDiscountLimits(f.db, f.tenantId, [{ role: 'OPERADOR_CAIXA', percent: 10 }], f.owner);
 // bruto 10000; 10% = 1000; líquido 9000
 const id = await createSale(f.db, f.tenantId, sale(f, { payment: 'Dinheiro', discount: { percent: 10, reason: 'Cliente antigo' } }) as never, f.operator);
 const row = await f.db.prepare('SELECT total, discount, discount_reason AS reason, discount_granted_by AS grantedBy, discount_authorized_by AS authorizedBy FROM sales WHERE id = ?').bind(id).first<{ total: number; discount: number; reason: string; grantedBy: string; authorizedBy: string | null }>();
 assert.equal(Number(row?.total), 9000);
 assert.equal(Number(row?.discount), 1000);
 assert.equal(row?.reason, 'Cliente antigo');
 assert.equal(row?.grantedBy, f.operatorId);
 assert.equal(row?.authorizedBy, null);
 const item = await f.db.prepare('SELECT discount FROM sale_items WHERE sale_id = ?').bind(id).first<{ discount: number }>();
 assert.equal(Number(item?.discount), 1000);
 const pay = await f.db.prepare('SELECT amount FROM sale_payments WHERE sale_id = ?').bind(id).first<{ amount: number }>();
 assert.equal(Number(pay?.amount), 9000);
 // um centavo acima do limite já exige supervisor
 await assert.rejects(() => createSale(f.db, f.tenantId, sale(f, { payment: 'Dinheiro', discount: { amount: 1001, reason: 'Passou' } }) as never, f.operator), (e: { status?: number }) => e.status === 428);
});

test('pagamento tem que fechar com o valor LÍQUIDO (com o bruto, é recusado)', async () => {
 const f = await fixture();
 await saveDiscountLimits(f.db, f.tenantId, [{ role: 'OPERADOR_CAIXA', percent: 10 }], f.owner);
 await assert.rejects(() => createSale(f.db, f.tenantId, sale(f, { payments: [{ method: 'Pix', amount: 10000 }], discount: { percent: 10, reason: 'Cliente antigo' } }) as never, f.operator), /soma dos pagamentos/);
 const id = await createSale(f.db, f.tenantId, sale(f, { payments: [{ method: 'Pix', amount: 4000 }, { method: 'Dinheiro', amount: 5000 }], discount: { percent: 10, reason: 'Cliente antigo' } }) as never, f.operator);
 assert.ok(id);
});

test('supervisor: OWNER autoriza acima do limite e fica registrado quem concedeu e quem autorizou', async () => {
 const f = await fixture();
 const id = await createSale(f.db, f.tenantId, sale(f, { payment: 'Dinheiro', discount: { percent: 20, reason: 'Produto com defeito' }, authorization: { email: 'ana@teste.com', password: PASSWORD } }) as never, f.operator);
 const row = await f.db.prepare('SELECT discount, discount_granted_by AS grantedBy, discount_authorized_by AS authorizedBy, discount_authorized_by_name AS authorizedByName FROM sales WHERE id = ?').bind(id).first<{ discount: number; grantedBy: string; authorizedBy: string; authorizedByName: string }>();
 assert.equal(Number(row?.discount), 2000);
 assert.equal(row?.grantedBy, f.operatorId);
 assert.equal(row?.authorizedBy, f.ownerId);
 assert.equal(row?.authorizedByName, 'Dona Ana');
});

test('supervisor recusado: senha errada, autoaprovação, sem SALE_DISCOUNT, sem alçada e usuário de outra conta', async () => {
 const f = await fixture();
 const base = (auth: { email: string; password: string }, now: number) => createSale(f.db, f.tenantId, sale(f, { payment: 'Dinheiro', discount: { percent: 20, reason: 'Produto com defeito' }, authorization: auth }) as never, f.operator, now);
 const denied = (e: { status?: number; message?: string }) => e.status === 403 && /Credenciais de supervisor/.test(e.message ?? '');
 // 4 tentativas (abaixo do limite de 5 do bloqueio), cada uma com um motivo diferente de recusa
 await assert.rejects(() => base({ email: 'ana@teste.com', password: 'senha-errada-1' }, 1), denied);
 await assert.rejects(() => base({ email: 'naoexiste@teste.com', password: PASSWORD }, 2), denied);
 await assert.rejects(() => base({ email: 'op@teste.com', password: PASSWORD }, 3), denied); // operador não se autoriza
 // gerente tem SALE_DISCOUNT, mas sem limite configurado o limite dele é 0 -> sem alçada
 await assert.rejects(() => base({ email: 'gerente@teste.com', password: PASSWORD }, 4), denied);
 // usuário válido de OUTRA conta não autoriza (janela nova, depois do bloqueio expirar)
 await registerAccount(f.db, { accountName: 'Outra', displayName: 'Estranho', email: 'estranho@teste.com', password: PASSWORD });
 await assert.rejects(() => base({ email: 'estranho@teste.com', password: PASSWORD }, 5), denied);
});

test('5 credenciais de supervisor erradas travam o operador por 15 min (429), mesmo com a senha certa depois', async () => {
 const f = await fixture();
 const t0 = 5_000_000;
 const attempt = (password: string, now: number) => createSale(f.db, f.tenantId, sale(f, { payment: 'Dinheiro', discount: { percent: 20, reason: 'Produto com defeito' }, authorization: { email: 'ana@teste.com', password } }) as never, f.operator, now);
 for (let i = 0; i < 5; i++) await assert.rejects(() => attempt('errada-errada-1', t0 + i), (e: { status?: number }) => e.status === 403);
 await assert.rejects(() => attempt(PASSWORD, t0 + 10), (e: { status?: number }) => e.status === 429);
 const id = await attempt(PASSWORD, t0 + 16 * 60 * 1000);
 assert.ok(id);
});

test('gerente com limite configurado autoriza dentro do limite dele e não acima', async () => {
 const f = await fixture();
 await saveDiscountLimits(f.db, f.tenantId, [{ role: 'GERENTE', percent: 15 }], f.owner);
 const auth = { email: 'gerente@teste.com', password: PASSWORD };
 const ok = await createSale(f.db, f.tenantId, sale(f, { payment: 'Dinheiro', discount: { percent: 15, reason: 'Fidelidade' }, authorization: auth }) as never, f.operator);
 assert.ok(ok);
 await assert.rejects(() => createSale(f.db, f.tenantId, sale(f, { payment: 'Dinheiro', discount: { percent: 16, reason: 'Fidelidade' }, authorization: auth }) as never, f.operator), /sem alçada/);
});

test('autorização sem desconto na venda é recusada; venda sem desconto não é afetada', async () => {
 const f = await fixture();
 await assert.rejects(() => createSale(f.db, f.tenantId, sale(f, { payment: 'Dinheiro', authorization: { email: 'ana@teste.com', password: PASSWORD } }) as never, f.operator), /sem desconto/);
 const id = await createSale(f.db, f.tenantId, sale(f, { payment: 'Dinheiro' }) as never, f.operator);
 const row = await f.db.prepare('SELECT total, discount FROM sales WHERE id = ?').bind(id).first<{ total: number; discount: number }>();
 assert.equal(Number(row?.total), 10000);
 assert.equal(Number(row?.discount), 0);
});

test('limites: só quem tem SALE_DISCOUNT_CONFIG configura; papel inválido, repetido e percentual fora da faixa são recusados', async () => {
 const f = await fixture();
 await assert.rejects(() => saveDiscountLimits(f.db, f.tenantId, [{ role: 'GERENTE', percent: 10 }], f.operator), /permissão/);
 await assert.rejects(() => saveDiscountLimits(f.db, f.tenantId, [{ role: 'GERENTE', percent: 10 }], f.manager), /permissão/);
 await assert.rejects(() => saveDiscountLimits(f.db, f.tenantId, [{ role: 'OWNER', percent: 10 }], f.owner), /não é configurável/);
 await assert.rejects(() => saveDiscountLimits(f.db, f.tenantId, [{ role: 'GERENTE', percent: 10 }, { role: 'GERENTE', percent: 20 }], f.owner), /repetido/);
 await assert.rejects(() => saveDiscountLimits(f.db, f.tenantId, [{ role: 'GERENTE', percent: 100.5 }], f.owner), /inválido/);
 await assert.rejects(() => saveDiscountLimits(f.db, f.tenantId, [{ role: 'GERENTE', percent: 1.234 }], f.owner), /2 casas/);
 const before = await listDiscountLimits(f.db, f.tenantId, f.owner);
 assert.ok(before.every((l) => l.maxBp === 0 && l.configured === false), 'nenhum valor padrão inventado');
 const after = await saveDiscountLimits(f.db, f.tenantId, [{ role: 'GERENTE', percent: 12.5 }, { role: 'OPERADOR_CAIXA', percent: 3 }], f.owner);
 assert.deepEqual(after.map((l) => [l.role, l.maxBp, l.configured]), [['ADMIN', 0, false], ['GERENTE', 1250, true], ['OPERADOR_CAIXA', 300, true]]);
});

test('OWNER não tem teto (até quase 100%) e o desconto nunca zera a venda', async () => {
 const f = await fixture();
 const owner = await actorFor(f.db, f.tenantId, f.ownerId, 'admin', 'Dona Ana', f.storeId);
 await openSession(f.db, f.tenantId, f.storeId, 0, owner);
 const id = await createSale(f.db, f.tenantId, sale(f, { payment: 'Dinheiro', discount: { percent: 99, reason: 'Bonificação parcial' } }) as never, owner);
 const row = await f.db.prepare('SELECT total FROM sales WHERE id = ?').bind(id).first<{ total: number }>();
 assert.equal(Number(row?.total), 100);
 await assert.rejects(() => createSale(f.db, f.tenantId, sale(f, { payment: 'Dinheiro', discount: { percent: 100, reason: 'Tudo' } }) as never, owner), /igualar ou superar|inválido/);
});

test('caixa: o esperado em dinheiro usa o valor LÍQUIDO da venda com desconto', async () => {
 const f = await fixture();
 await saveDiscountLimits(f.db, f.tenantId, [{ role: 'OPERADOR_CAIXA', percent: 10 }], f.owner);
 await createSale(f.db, f.tenantId, sale(f, { payment: 'Dinheiro', discount: { percent: 10, reason: 'Cliente antigo' } }) as never, f.operator);
 const session = await f.db.prepare('SELECT id FROM cash_sessions WHERE user_id = ?').bind(f.operatorId).first<{ id: string }>();
 await closeSession(f.db, f.tenantId, session!.id, 19000, f.operator);
 const closed = await f.db.prepare('SELECT expected_amount AS expected, difference FROM cash_sessions WHERE id = ?').bind(session!.id).first<{ expected: number; difference: number }>();
 assert.equal(Number(closed?.expected), 10000 + 9000); // abertura + venda líquida
 assert.equal(Number(closed?.difference), 0);
});

test('auditoria: grava desconto, quem concedeu e quem autorizou — nunca a senha nem o e-mail do supervisor', async () => {
 const f = await fixture();
 const id = await dispatchCommand(f.db, f.tenantId, f.operator, plan, {
  type: 'sale.create', storeId: f.storeId, items: [{ productId: f.productA, qty: 2 }], customer: '', document: '', payment: 'Dinheiro',
  discount: { percent: 20, reason: 'Produto com defeito' }, authorization: { email: 'ana@teste.com', password: PASSWORD },
 } as never, Date.now(), { ip: '203.0.113.9', correlationId: 'corr-1' });
 assert.ok(id);
 const rows = await f.db.prepare('SELECT description, after_data AS afterData FROM audit_logs WHERE tenant_id = ?').bind(f.tenantId).all<{ description: string; afterData: string }>();
 const dump = JSON.stringify(rows.results);
 assert.ok(dump.includes('autorizado por Dona Ana'));
 assert.ok(dump.includes('Produto com defeito'));
 assert.ok(!dump.includes(PASSWORD), 'a senha do supervisor vazou para a auditoria');
 assert.ok(!dump.includes('ana@teste.com'), 'o e-mail do supervisor vazou para a auditoria');
});

test('comando discount.limits.save é auditado com antes/depois e exige a permissão', async () => {
 const f = await fixture();
 await assert.rejects(() => dispatchCommand(f.db, f.tenantId, f.manager, plan, { type: 'discount.limits.save', limits: [{ role: 'GERENTE', percent: 10 }] } as never), /permissão/);
 await dispatchCommand(f.db, f.tenantId, f.owner, plan, { type: 'discount.limits.save', limits: [{ role: 'GERENTE', percent: 10 }] } as never);
 const row = await f.db.prepare("SELECT before_data AS beforeData, after_data AS afterData FROM audit_logs WHERE action = 'discount.limits.save'").bind().first<{ beforeData: string; afterData: string }>();
 assert.ok(row?.beforeData && row?.afterData);
 assert.ok(JSON.parse(row.afterData).some((l: { role: string; maxBp: number }) => l.role === 'GERENTE' && l.maxBp === 1000));
});

const ISSUER = { cnpj: '12345678000190', legalName: 'LOJA CENTRO LTDA', ie: '123456789110', crt: '1_SIMPLES_NACIONAL' as const, uf: 'SP', city: 'São Paulo', municipalityCode: '3550308', address: 'Av Paulista', number: '1000', district: 'Bela Vista', zip: '01310100' };

test('NF-e com desconto: vDesc por item, vDesc e vNF corretos no total, e o validador de schema aceita', () => {
 const items = [
  { code: 'A', description: 'Camiseta', ncm: '61091000', cfop: '5102', unit: 'UN', qty: 2, unitPrice: 5000, totalPrice: 10000, discount: 1000, origin: '0', taxCode: '102' },
  { code: 'B', description: 'Boné', ncm: '65050090', cfop: '5102', unit: 'UN', qty: 1, unitPrice: 3333, totalPrice: 3333, discount: 0, origin: '0', taxCode: '102' },
 ];
 const { xml } = buildNFeXml({ environment: 'homologacao', series: 1, number: 1, emissionDate: new Date(Date.UTC(2026, 0, 16, 15, 0, 0)), issuer: ISSUER, items, payments: [{ method: 'Pix', amount: 12333 }], numericCode: '12345678' });
 assert.ok(xml.includes('<vDesc>10.00</vDesc>'), 'vDesc do item e do total');
 assert.equal((xml.match(/<vDesc>/g) ?? []).length, 2, 'um vDesc no item com desconto + o do total');
 assert.ok(xml.includes('<vNF>123.33</vNF>'));
 assert.ok(xml.includes('<vProd>133.33</vProd>'));
 const validation = validateNFeXmlSchema(xml);
 assert.equal(validation.valid, true, validation.errors.map((e) => e.message).join('; '));
 // pagamento que não fecha com o líquido bloqueia a montagem
 assert.throws(() => buildNFeXml({ environment: 'homologacao', series: 1, number: 1, emissionDate: new Date(), issuer: ISSUER, items, payments: [{ method: 'Pix', amount: 13333 }] }), /não confere/);
 // desconto maior que o item bloqueia
 assert.throws(() => buildNFeXml({ environment: 'homologacao', series: 1, number: 1, emissionDate: new Date(), issuer: ISSUER, items: [{ ...items[0], discount: 20000 }], payments: [{ method: 'Pix', amount: 1 }] }), /desconto inválido/);
});

test('validador de schema recusa vNF que ignora o desconto (nota adulterada)', () => {
 const items = [{ code: 'A', description: 'Camiseta', ncm: '61091000', cfop: '5102', unit: 'UN', qty: 2, unitPrice: 5000, totalPrice: 10000, discount: 1000, origin: '0', taxCode: '102' }];
 const { xml } = buildNFeXml({ environment: 'homologacao', series: 1, number: 1, emissionDate: new Date(Date.UTC(2026, 0, 16, 15, 0, 0)), issuer: ISSUER, items, payments: [{ method: 'Pix', amount: 9000 }], numericCode: '12345678' });
 const tampered = xml.replace('<vNF>90.00</vNF>', '<vNF>100.00</vNF>');
 const result = validateNFeXmlSchema(tampered);
 assert.equal(result.valid, false);
 assert.ok(result.errors.some((e) => /vNF/.test(e.message)));
});
