// Leitura do corpo da requisição com teto de tamanho. `request.text()`/`json()` leem tudo para a
// memória antes de qualquer conferência (e o Next não limita o corpo nas rotas de API): um envio
// gigante ou sem fim derrubaria o processo. Aqui a leitura para assim que o teto é ultrapassado.
export class BodyTooLargeError extends Error {
 constructor() {
  super('Solicitação muito grande.');
  this.name = 'BodyTooLargeError';
 }
}

export async function readTextLimited(request: Request, maxBytes: number): Promise<string> {
 const declared = Number(request.headers.get('content-length') ?? '');
 if (Number.isFinite(declared) && declared > maxBytes) throw new BodyTooLargeError();
 if (!request.body) return '';
 const reader = request.body.getReader();
 const chunks: Uint8Array[] = [];
 let total = 0;
 for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  total += value.byteLength;
  if (total > maxBytes) {
   await reader.cancel().catch(() => undefined);
   throw new BodyTooLargeError();
  }
  chunks.push(value);
 }
 return new TextDecoder().decode(Buffer.concat(chunks));
}

/** JSON com teto de tamanho; corpo vazio ou inválido vira `null` (a rota decide a resposta). */
export async function readJsonLimited<T = unknown>(request: Request, maxBytes: number): Promise<T | null> {
 const text = await readTextLimited(request, maxBytes);
 try {
  return text ? (JSON.parse(text) as T) : null;
 } catch {
  return null;
 }
}
