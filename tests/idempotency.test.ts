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
