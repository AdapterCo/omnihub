import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// TOTP (RFC 6238 sobre HOTP, RFC 4226): HMAC-SHA1, passo de 30 s, 6 dígitos — o formato que
// Google Authenticator, Authy, Microsoft Authenticator etc. usam por padrão. Implementado com o
// crypto nativo do Node (sem biblioteca externa).
const STEP_SECONDS = 30;
const DIGITS = 6;
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
 let bits = 0, value = 0, out = '';
 for (const byte of buf) {
  value = (value << 8) | byte;
  bits += 8;
  while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
 }
 if (bits > 0) out += B32[(value << (5 - bits)) & 31];
 return out;
}

export function base32Decode(text: string): Buffer {
 const clean = text.replace(/[\s=-]/g, '').toUpperCase();
 let bits = 0, value = 0;
 const out: number[] = [];
 for (const ch of clean) {
  const idx = B32.indexOf(ch);
  if (idx < 0) throw new Error('Segredo base32 inválido.');
  value = (value << 5) | idx;
  bits += 5;
  if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
 }
 return Buffer.from(out);
}

/** Segredo novo de 160 bits (tamanho recomendado para HMAC-SHA1), em base32. */
export function newTotpSecret(): string {
 return base32Encode(randomBytes(20));
}

export function hotp(secret: Buffer, counter: number): string {
 const msg = Buffer.alloc(8);
 msg.writeBigUInt64BE(BigInt(counter));
 const mac = createHmac('sha1', secret).update(msg).digest();
 const offset = mac[mac.length - 1] & 15;
 const code = ((mac[offset] & 127) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
 return String(code % 10 ** DIGITS).padStart(DIGITS, '0');
}

export function totpStep(nowMs: number): number {
 return Math.floor(nowMs / 1000 / STEP_SECONDS);
}

/**
 * Confere o código aceitando um passo de tolerância para cada lado (relógio do celular adiantado
 * ou atrasado até 30 s). Devolve o passo usado — o chamador grava e recusa passos repetidos
 * (o mesmo código não serve duas vezes) — ou null.
 */
export function verifyTotp(secretBase32: string, code: string, nowMs: number, lastUsedStep: number | null = null): number | null {
 const digits = String(code ?? '').replace(/\s/g, '');
 if (!/^\d{6}$/.test(digits)) return null;
 const secret = base32Decode(secretBase32);
 const current = totpStep(nowMs);
 for (const step of [current - 1, current, current + 1]) {
  if (lastUsedStep !== null && step <= lastUsedStep) continue;
  const expected = hotp(secret, step);
  if (timingSafeEqual(Buffer.from(expected), Buffer.from(digits))) return step;
 }
 return null;
}

/** URI lida pelos apps autenticadores (vira QR Code na tela). */
export function otpauthUri(secretBase32: string, account: string, issuer: string): string {
 const label = encodeURIComponent(`${issuer}:${account}`);
 return `otpauth://totp/${label}?secret=${secretBase32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
}
