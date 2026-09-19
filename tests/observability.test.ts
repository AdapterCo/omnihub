import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { createFakeD1 } from './helpers/fakeD1.ts';
import { log, redact, serializeError, pseudonym } from '../lib/log.ts';
import { checkHealth } from '../lib/health.ts';

test('redact mascara senha, token, cookie, csc e certificado em qualquer profundidade', () => {
 const out = redact({ user: 'ana', password: 'x', nested: { sessionToken: 'abc', omnihub_cookie: 'c', csc: '123', pfxBase64: 'zzz', list: [{ passphrase: 'p', ok: 1 }] } }) as Record<string, unknown>;
 const text = JSON.stringify(out);
 assert.equal((out as { user: string }).user, 'ana');
 for (const secret of ['"x"', 'abc', '"c"', '"123"', 'zzz', '"p"']) assert.ok(!text.includes(secret), `vazou ${secret}`);
 assert.equal(text.split('[REDACTED]').length - 1, 6);
 assert.ok(text.includes('"ok":1'));
});

test('redact corta strings enormes e limita profundidade', () => {
 const long = redact({ v: 'a'.repeat(2000) }) as { v: string };
 assert.ok(long.v.length < 600);
 let deep: Record<string, unknown> = { fim: 1 };
 for (let i = 0; i < 20; i++) deep = { n: deep };
 assert.ok(JSON.stringify(redact(deep)).includes('profundidade'));
});

test('serializeError guarda nome/mensagem/código, mas nunca o detail do PostgreSQL (pode conter e-mails)', () => {
 const pgError = Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505', detail: 'Key (email)=(maria@empresa.com) already exists.' });
 const out = JSON.stringify(serializeError(pgError));
 assert.ok(out.includes('23505'));
 assert.ok(!out.includes('maria@empresa.com'));
 assert.ok(!out.includes('detail'));
});

test('pseudonym é estável, não reversível e ignora caixa/espaços', () => {
 assert.equal(pseudonym('Maria@Empresa.com '), pseudonym('maria@empresa.com'));
 assert.notEqual(pseudonym('a@b.co'), pseudonym('c@d.co'));
 assert.ok(!pseudonym('maria@empresa.com').includes('maria'));
 assert.equal(pseudonym('a@b.co').length, 12);
});

test('log emite uma linha JSON, respeita LOG_LEVEL e manda warn/error para stderr', () => {
 const out = mock.method(console, 'log', () => undefined);
 const err = mock.method(console, 'error', () => undefined);
 try {
  log('info', 'evento.teste', { password: 'segredo', n: 1 }, {});
  log('debug', 'evento.debug', {}, {});
  log('debug', 'evento.debug2', {}, { LOG_LEVEL: 'debug' });
  log('warn', 'evento.aviso', {}, {});
  assert.equal(out.mock.callCount(), 2);
  const first = JSON.parse(out.mock.calls[0].arguments[0] as string);
  assert.equal(first.event, 'evento.teste');
  assert.equal(first.level, 'info');
  assert.equal(first.password, '[REDACTED]');
  assert.ok(!Number.isNaN(Date.parse(first.ts)));
  assert.equal(err.mock.callCount(), 1);
  assert.equal(JSON.parse(err.mock.calls[0].arguments[0] as string).event, 'evento.aviso');
 } finally {
  out.mock.restore();
  err.mock.restore();
 }
});

test('checkHealth: ok com banco saudável; erro se a consulta falha ou trava (sem detalhes internos)', async () => {
 const ok = await checkHealth(createFakeD1());
 assert.equal(ok.ok, true);
 assert.equal(ok.checks.database, 'ok');

 // MOCKS de banco (só em teste): um que lança erro com dado sensível e um que nunca responde.
 const broken = { prepare: () => ({ bind: () => ({ first: async () => { throw new Error('senha=xyz host=interno'); } }) }) } as unknown as D1Database;
 const failed = await checkHealth(broken);
 assert.equal(failed.ok, false);
 assert.equal(failed.status, 'error');
 assert.ok(!JSON.stringify(failed).includes('xyz'));

 const hanging = { prepare: () => ({ bind: () => ({ first: () => new Promise(() => undefined) }) }) } as unknown as D1Database;
 const started = Date.now();
 const timedOut = await checkHealth(hanging, 50);
 assert.equal(timedOut.ok, false);
 assert.ok(Date.now() - started < 1500);
});
