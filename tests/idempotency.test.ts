import assert from 'node:assert/strict';
import test from 'node:test';
import { createFakeD1 } from './helpers/fakeD1.ts';
import { withIdempotency } from '../lib/idempotency.ts';

async function tenant(db: D1Database, id: string) {
 await db.prepare('INSERT INTO accounts (id,name,state,revision,subscription_status,access_until,max_stores,created_at) VALUES (?,?,?,0,?,?,3,?)').bind(id, id, '{}', 'trial', 9999999999999, 0).run();
}

test('Mesma chave e mesmo comando devolve o resultado anterior sem executar de novo', async () => {
 const db = createFakeD1();
 await tenant(db, 't1');
 let calls = 0;
 const run = () => withIdempotency(db, 't1', 'key-1', 'fingerprint-a', async () => { calls++; return 'result-1' });
 const first = await run();
 const second = await run();
 assert.equal(first.resultId, 'result-1');
 assert.equal(second.resultId, 'result-1');
 assert.equal(second.replayed, true);
 assert.equal(calls, 1);
});

test('Mesma chave com comando diferente é rejeitada', async () => {
 const db = createFakeD1();
 await tenant(db, 't1');
 await withIdempotency(db, 't1', 'key-1', 'fingerprint-a', async () => 'result-1');
 await assert.rejects(() => withIdempotency(db, 't1', 'key-1', 'fingerprint-b', async () => 'result-2'), /já utilizado/);
});

test('A mesma chave em tenants diferentes não interfere', async () => {
 const db = createFakeD1();
 await tenant(db, 't1');
 await tenant(db, 't2');
 const a = await withIdempotency(db, 't1', 'key-1', 'fingerprint-a', async () => 'result-a');
 const b = await withIdempotency(db, 't2', 'key-1', 'fingerprint-b', async () => 'result-b');
 assert.equal(a.resultId, 'result-a');
 assert.equal(b.resultId, 'result-b');
});

test('Duas requisições simultâneas com a mesma chave executam o comando uma única vez', async () => {
 const db = createFakeD1();
 await tenant(db, 't1');
 let calls = 0;
 let release!: () => void;
 const gate = new Promise<void>((r) => { release = r; });
 const slow = withIdempotency(db, 't1', 'key-1', 'fp', async () => { calls++; await gate; return 'result-1'; });
 await assert.rejects(() => withIdempotency(db, 't1', 'key-1', 'fp', async () => { calls++; return 'result-2'; }), /sendo processada/);
 release();
 assert.equal((await slow).resultId, 'result-1');
 assert.equal((await withIdempotency(db, 't1', 'key-1', 'fp', async () => 'x')).replayed, true);
 assert.equal(calls, 1);
});

test('Comando que falha libera a chave para nova tentativa', async () => {
 const db = createFakeD1();
 await tenant(db, 't1');
 await assert.rejects(() => withIdempotency(db, 't1', 'key-1', 'fp', async () => { throw new Error('falhou'); }), /falhou/);
 const ok = await withIdempotency(db, 't1', 'key-1', 'fp', async () => 'result-1');
 assert.equal(ok.replayed, false);
 assert.equal(ok.resultId, 'result-1');
});

test('Chaves concluídas com mais de 30 dias são removidas', async () => {
 const db = createFakeD1();
 await tenant(db, 't1');
 const day = 24 * 60 * 60 * 1000;
 await withIdempotency(db, 't1', 'old', 'fp', async () => 'r', 1000);
 await withIdempotency(db, 't1', 'new', 'fp', async () => 'r', 1000 + 31 * day + 2 * 60 * 60 * 1000);
 const rows = await db.prepare('SELECT key FROM command_idempotency ORDER BY key').bind().all<{ key: string }>();
 assert.deepEqual(rows.results.map((r) => r.key), ['new']);
});
