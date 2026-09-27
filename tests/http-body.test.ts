import assert from 'node:assert/strict';
import test from 'node:test';
import { readTextLimited, readJsonLimited, BodyTooLargeError } from '../lib/http/body.ts';

test('readTextLimited: lê corpo dentro do teto e recusa o que passa, declarado ou não', async () => {
 assert.equal(await readTextLimited(new Request('http://x', { method: 'POST', body: 'olá' }), 10), 'olá');
 await assert.rejects(() => readTextLimited(new Request('http://x', { method: 'POST', body: 'x'.repeat(11) }), 10), BodyTooLargeError);
 // Envio em partes, sem content-length: a leitura para ao passar do teto.
 let pulled = 0;
 const stream = new ReadableStream<Uint8Array>({ pull(c) { pulled++; c.enqueue(new Uint8Array(1024)); } });
 await assert.rejects(() => readTextLimited(new Request('http://x', { method: 'POST', body: stream, duplex: 'half' } as RequestInit), 4096), BodyTooLargeError);
 assert.ok(pulled < 10, 'não continua lendo depois do teto');
});

test('readJsonLimited: JSON inválido ou vazio vira null', async () => {
 assert.deepEqual(await readJsonLimited(new Request('http://x', { method: 'POST', body: '{"a":1}' }), 100), { a: 1 });
 assert.equal(await readJsonLimited(new Request('http://x', { method: 'POST', body: '{' }), 100), null);
 assert.equal(await readJsonLimited(new Request('http://x', { method: 'POST' }), 100), null);
});
