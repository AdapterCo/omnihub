import assert from 'node:assert/strict';
import test from 'node:test';
import { createFakeD1 } from './helpers/fakeD1.ts';
import { registerAccount } from '../lib/auth/service.ts';
import { permissionsForRole } from '../lib/authz/roles.ts';
import { createStore } from '../lib/catalog/service.ts';
import { purgeOperationalData, EVENT_RETENTION_MS } from '../lib/maintenance.ts';

test('limpeza: remove só eventos resolvidos antigos e credenciais temporárias vencidas', async () => {
 const db = createFakeD1();
 const now = Date.UTC(2026, 8, 27);
 const old = now - EVENT_RETENTION_MS - 1000, recent = now - 1000;
 const reg = await registerAccount(db, { accountName: 'Loja', displayName: 'Dona', email: 'dona@empresa.com', password: 'senha-forte-123' }, now);
 const actor = { userId: reg.userId, displayName: 'Dona', role: 'admin', storeId: null, permissions: permissionsForRole('OWNER') };
 const store = await createStore(db, reg.accountId, { name: 'Loja A' } as never, actor);
 const sign = (id: string, status: string, at: number, attempts = 1) => db.prepare('INSERT INTO adapter_sign_events (id, tenant_id, store_id, event_id, event_type, status, attempts, received_at) VALUES (?,?,?,?,?,?,?,?)').bind(id, reg.accountId, store, id, 'envelope.completed', status, attempts, at).run();
 await sign('s-processado-antigo', 'PROCESSED', old);
 await sign('s-ignorado-antigo', 'IGNORED', old);
 await sign('s-falhou-esgotado', 'FAILED', old, 10);
 await sign('s-falhou-ainda-tenta', 'FAILED', old, 3);
 await sign('s-processado-recente', 'PROCESSED', recent);
 const asaas = (id: string, status: string, at: number) => db.prepare('INSERT INTO asaas_events (id, store_id, event_id, payment_id, status, attempts, received_at) VALUES (?,?,?,?,?,0,?)').bind(id, store, id, 'pay_' + id, status, at).run();
 await asaas('a-processado-antigo', 'PROCESSED', old);
 await asaas('a-sem-cobranca-antigo', 'RECEIVED', old);
 await asaas('a-recente', 'RECEIVED', recent);
 await db.prepare('INSERT INTO login_challenges (token_hash, user_id, expires_at, attempts, created_at) VALUES (?,?,?,0,?)').bind('vencido', reg.userId, now - 1, now - 10).run();
 await db.prepare('INSERT INTO login_challenges (token_hash, user_id, expires_at, attempts, created_at) VALUES (?,?,?,0,?)').bind('valido', reg.userId, now + 60_000, now).run();
 await db.prepare('INSERT INTO password_resets (token_hash, user_id, expires_at, used_at, created_at) VALUES (?,?,?,NULL,?)').bind('r-vencido', reg.userId, now - 1, now - 10).run();

 const removed = await purgeOperationalData(db, now);
 assert.deepEqual(removed, { adapterSignEvents: 3, asaasEvents: 2, loginChallenges: 1, passwordResets: 1 });
 const left = async (sql: string) => (await db.prepare(sql).bind().all<{ id: string }>()).results.map((r) => r.id).sort();
 assert.deepEqual(await left('SELECT id FROM adapter_sign_events'), ['s-falhou-ainda-tenta', 's-processado-recente']);
 assert.deepEqual(await left('SELECT id FROM asaas_events'), ['a-recente']);
 assert.deepEqual(await left('SELECT token_hash AS id FROM login_challenges'), ['valido']);
});
