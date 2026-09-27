import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { RuleError } from '../errors.ts';

// Armazenamento de arquivos (instrucao-sistema-vendas.md §26). O banco guarda só metadados e a
// chave do objeto; o arquivo fica em disco, no diretório STORAGE_DIR (na VPS, um volume Docker
// — ver docker-compose.yml). Não há diretório padrão presumido: sem STORAGE_DIR, qualquer
// gravação bloqueia com explicação. A chave é sempre montada pelo servidor (segmentos com
// letras, números, hífen e ponto), nunca a partir do nome do arquivo enviado pelo usuário, e o
// caminho final é conferido para não escapar do diretório base.

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;

export interface ObjectStorage {
 put(key: string, bytes: Uint8Array): Promise<void>;
 get(key: string): Promise<Uint8Array>;
}

export function assertSafeKey(key: string): void {
 const parts = key.split('/');
 if (!parts.length || parts.some((p) => !SEGMENT.test(p) || p.includes('..'))) throw new Error(`Chave de armazenamento inválida: ${key}`);
}

export function createLocalStorage(baseDir: string): ObjectStorage {
 const base = resolve(baseDir);
 const pathFor = (key: string) => {
  assertSafeKey(key);
  const full = resolve(join(base, ...key.split('/')));
  if (!full.startsWith(base + sep)) throw new Error('Caminho de armazenamento fora do diretório base.');
  return full;
 };
 return {
  async put(key, bytes) {
   const full = pathFor(key);
   await mkdir(dirname(full), { recursive: true });
   // Grava num temporário e renomeia: um arquivo nunca fica pela metade se o processo cair.
   const tmp = `${full}.${crypto.randomUUID()}.tmp`;
   await writeFile(tmp, bytes, { flag: 'wx' });
   await rename(tmp, full);
  },
  async get(key) {
   try {
    return new Uint8Array(await readFile(pathFor(key)));
   } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new RuleError('Arquivo não encontrado no armazenamento.', 404);
    throw error;
   }
  },
 };
}

let cached: { dir: string; storage: ObjectStorage } | null = null;

/** Armazenamento configurado pelo ambiente. Bloqueia (409) quando STORAGE_DIR não está definido. */
export function storageFromEnv(env: Record<string, string | undefined> = process.env): ObjectStorage {
 const dir = (env.STORAGE_DIR ?? '').trim();
 if (!dir) throw new RuleError('Armazenamento de arquivos não configurado no servidor (variável STORAGE_DIR). Peça ao administrador para configurá-lo.', 409);
 if (cached?.dir !== dir) cached = { dir, storage: createLocalStorage(dir) };
 return cached.storage;
}
