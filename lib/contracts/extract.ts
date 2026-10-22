import { join } from 'node:path';
import { RuleError } from '../errors.ts';
import { logger } from '../log.ts';

// Importação do contrato que o lojista já usa (PDF com texto): extrai o texto com o pdfjs e
// sugere título, cabeçalho, corpo e rodapé para o editor de modelos. É só uma SUGESTÃO — o
// lojista revisa tudo e marca os campos antes de publicar. Nada aqui inventa conteúdo: só
// reorganiza o texto que já está no PDF.
//
// Heurísticas (conferidas com os contratos reais que motivaram a função):
// - linha que se repete em várias páginas (ex.: "Documento gerado dia ... / Página 03") é
//   cabeçalho/rodapé de página, não cláusula;
// - antes do título (primeira linha em maiúsculas com CONTRATO/TERMO/...) vem o cabeçalho da empresa;
// - o bloco de assinaturas depois da linha de data ("Cidade, 3 de setembro de 2026") é removido:
//   o sistema monta o próprio bloco com as marcas do Adapter Sign;
// - trechos em negrito no PDF viram **negrito** no modelo.

export type ExtractedContract = { title: string; headerText: string; body: string; footerText: string; pages: number; warnings: string[] };

type Item = { str: string; x: number; y: number; width: number; bold: boolean };
type Line = { page: number; y: number; text: string; plain: string };

const MAX_PAGES = 60;
const TITLE_WORDS = /\b(CONTRATO|TERMO|INSTRUMENTO|DOCUMENTO|DECLARA[ÇC][ÃA]O|RECIBO)\b/;
const DATE_LINE = /^[\p{L} .'/-]{2,60},\s*\d{1,2}\s+de\s+[\p{L}ç]+\s+de\s+\d{4}\.?$/iu;
// Número de cláusula/item sempre termina em ponto ("1.", "1.1.", "a)", "IV -"): número solto
// no começo da linha (telefone quebrado, por exemplo) não abre parágrafo.
const CLAUSE_START = /^(\*\*)?(\d{1,3}(\.\d{1,3})*\.|[a-z]\)|[IVX]+\s?[-–.])(\*\*)?\s/;
const PAGE_NUMBER = /^(p[áa]gina|pag\.?|p\.)\s*\d+(\s*(de|\/)\s*\d+)?$/i;

const normalizeRepeat = (s: string) => s.replace(/\*\*/g, '').replace(/\d/g, '#').replace(/\s+/g, ' ').trim().toLowerCase();
const isUpperTitle = (s: string) => { const letters = s.replace(/[^\p{L}]/gu, ''); return letters.length >= 10 && letters === letters.toUpperCase(); };

/** Junta os pedaços da linha, com espaço onde há distância visual e **negrito** nos trechos em negrito. */
function buildLine(items: Item[]): { text: string; plain: string } {
 let text = '';
 let plain = '';
 let boldOpen = false;
 let prevEnd: number | null = null;
 for (const it of items) {
  if (!it.str) continue;
  const gap = prevEnd === null ? 0 : it.x - prevEnd;
  // Troca de negrito para normal (ou o contrário) entre palavras é um espaço que o gerador do PDF
  // às vezes nem desenha (há PDFs em que o negrito começa sobreposto à palavra anterior:
  // "número58313454000100", "1.1.O objeto"): restaura o espaço, exceto junto de pontuação.
  const styleChange = prevEnd !== null && it.bold !== boldOpen && !!it.str.trim();
  const nearPunct = /[(\[/"'“]$/.test(plain) || /^[)\].,;:!?"'”]/.test(it.str);
  const needsSpace = prevEnd !== null && !/\s$/.test(plain) && !/^\s/.test(it.str) && (gap > 1 || (styleChange && !nearPunct));
  const chunk = (needsSpace ? ' ' : '') + it.str;
  if (it.bold && !boldOpen && it.str.trim()) { text += (needsSpace ? ' ' : '') + '**' + it.str; boldOpen = true; }
  else if (!it.bold && boldOpen && it.str.trim()) {
   // Fecha o negrito antes do espaço que já estava no texto ("**1.1.** O", não "**1.1.**O").
   const trail = /\s$/.test(text) ? ' ' : '';
   text = text.replace(/\s+$/, '') + '**' + trail + chunk;
   boldOpen = false;
  }
  else text += chunk;
  plain += chunk;
  prevEnd = it.x + it.width;
 }
 if (boldOpen) text = text.replace(/\s+$/, '') + '**';
 return { text: text.replace(/\*\*\s*\*\*/g, ' ').replace(/\s+/g, ' ').trim(), plain: plain.replace(/\s+/g, ' ').trim() };
}

export async function extractContractText(bytes: Uint8Array): Promise<ExtractedContract> {
 const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
 let doc;
 try {
  doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), disableFontFace: true, standardFontDataUrl: join(process.cwd(), 'node_modules', 'pdfjs-dist', 'standard_fonts') + '/' }).promise;
 } catch (error) {
  // PDF protegido/corrompido é erro do arquivo; o motivo técnico fica no log (sem o conteúdo).
  logger.warn('contract-models.pdf_ilegivel', { error });
  throw new RuleError('Não foi possível abrir o PDF. Confira se o arquivo não está protegido por senha ou corrompido.', 400);
 }
 if (doc.numPages > MAX_PAGES) throw new RuleError(`O PDF tem ${doc.numPages} páginas; o limite para importar um modelo é ${MAX_PAGES}.`, 400);
 const lines: Line[] = [];
 for (let p = 1; p <= doc.numPages; p++) {
  const page = await doc.getPage(p);
  await page.getOperatorList(); // carrega as fontes: o nome real indica negrito
  const content = await page.getTextContent();
  const items: Item[] = [];
  for (const raw of content.items as { str?: string; transform?: number[]; width?: number; fontName?: string }[]) {
   if (typeof raw.str !== 'string' || !raw.transform) continue;
   let fontName = '';
   try { fontName = String((page.commonObjs.get(raw.fontName ?? '') as { name?: string } | undefined)?.name ?? ''); } catch { fontName = ''; }
   items.push({ str: raw.str, x: raw.transform[4], y: raw.transform[5], width: raw.width ?? 0, bold: /bold|black|heavy|semibold/i.test(fontName) });
  }
  // Agrupa por linha (mesma altura), de cima para baixo e da esquerda para a direita.
  items.sort((a, b) => (Math.abs(b.y - a.y) > 2 ? b.y - a.y : a.x - b.x));
  let current: Item[] = [];
  let y: number | null = null;
  const flush = () => { if (current.length) { const l = buildLine(current); if (l.plain) lines.push({ page: p, y: y ?? 0, ...l }); } current = []; };
  for (const it of items) {
   if (y !== null && Math.abs(it.y - y) > 2) flush();
   if (!current.length) y = it.y;
   current.push(it);
  }
  flush();
 }
 const warnings: string[] = [];
 if (!lines.length) throw new RuleError('Este PDF não tem texto selecionável (parece digitalizado/imagem). Envie o PDF gerado pelo sistema ou editor de texto, não uma foto ou digitalização.', 400);

 // Linhas repetidas em várias páginas: cabeçalho/rodapé de página.
 const pagesOf = new Map<string, Set<number>>();
 for (const l of lines) { const k = normalizeRepeat(l.plain); if (!pagesOf.has(k)) pagesOf.set(k, new Set()); pagesOf.get(k)!.add(l.page); }
 // Cabeçalho/rodapé de página aparece em (quase) todas as páginas; o nome da empresa no topo e
 // no bloco de assinaturas aparece em duas e não conta.
 const minPages = doc.numPages <= 2 ? 2 : doc.numPages - 1;
 // Também conta como rodapé o que fica na faixa de baixo da página (contrato de uma página só).
 const repeated = (l: Line) => l.y < 56 || (doc.numPages > 1 && (pagesOf.get(normalizeRepeat(l.plain))?.size ?? 0) >= minPages);
 const footerLine = lines.filter((l) => repeated(l) && !PAGE_NUMBER.test(l.plain)).sort((a, b) => a.y - b.y)[0];
 let footerText = footerLine ? footerLine.plain.replace(/\s*(p[áa]gina|pag\.?)\s*\d+(\s*(de|\/)\s*\d+)?\s*$/i, '') : '';
 // Data/hora de geração no rodapé vira o campo correspondente (é a data em que o contrato é gerado).
 footerText = footerText.replace(/\d{2}\/\d{2}\/\d{4}(\s+\d{2}:\d{2}(:\d{2})?)?/, '{{pedido.data_hora_geracao}}');
 const content = lines.filter((l) => !repeated(l) && !PAGE_NUMBER.test(l.plain));
 if (footerLine) warnings.push('O rodapé repetido em todas as páginas foi separado no campo "Rodapé". A numeração das páginas é feita pelo sistema.');

 // Título e cabeçalho da empresa (antes do título, só na 1ª página).
 let titleIndex = content.findIndex((l) => l.page === 1 && isUpperTitle(l.plain) && TITLE_WORDS.test(l.plain.toUpperCase()));
 if (titleIndex < 0) titleIndex = content.findIndex((l) => l.page === 1 && isUpperTitle(l.plain));
 const title = titleIndex >= 0 ? content[titleIndex].plain : '';
 const headerText = titleIndex > 0 && titleIndex <= 12 ? content.slice(0, titleIndex).map((l) => l.plain).join('\n') : '';
 let bodyLines = titleIndex >= 0 && titleIndex <= 12 ? content.slice(titleIndex + 1) : content;
 if (!title) warnings.push('Não encontrei o título do contrato. Preencha o campo "Título".');

 // Bloco de assinaturas: tudo depois da última linha de data/local é descartado.
 let dateIndex = -1;
 bodyLines.forEach((l, i) => { if (DATE_LINE.test(l.plain)) dateIndex = i; });
 if (dateIndex >= 0 && dateIndex < bodyLines.length - 1) {
  bodyLines = bodyLines.slice(0, dateIndex + 1);
  warnings.push('O bloco de assinaturas do PDF foi removido: o sistema monta o próprio, com as marcas do Adapter Sign.');
 } else if (bodyLines.some((l) => /_{5,}/.test(l.plain))) {
  warnings.push('Há linhas de assinatura ("_____") no texto. Apague o bloco de assinaturas: o sistema monta o próprio.');
 }

 // Parágrafos: quebra onde começa cláusula/item, onde a linha anterior termina em ":" ou é curta e termina em pontuação.
 const maxLen = bodyLines.reduce((m, l) => Math.max(m, l.plain.length), 0) || 1;
 const paragraphs: string[] = [];
 let par = '';
 let prev: Line | null = null;
 for (const l of bodyLines) {
  const startsNew = !prev || CLAUSE_START.test(l.text) || DATE_LINE.test(l.plain) || /:\s*(\*\*)?$/.test(prev.plain) || (prev.plain.length < maxLen * 0.72 && /[.;!?]\s*(\*\*)?$/.test(prev.plain));
  if (startsNew && par) { paragraphs.push(par); par = ''; }
  par = par ? `${par} ${l.text}` : l.text;
  prev = l;
 }
 if (par) paragraphs.push(par);
 // Trechos em negrito vizinhos (quebra de linha no meio do negrito) viram um só.
 const body = paragraphs.map((p) => p.replace(/\*\* \*\*/g, ' ').replace(/\*\* ([,.;:)])/g, '**$1').trim()).filter(Boolean).join('\n\n');
 warnings.push('Revise o texto: confira as quebras de parágrafo e troque cada dado do cliente de exemplo pelo campo correspondente antes de publicar.');
 return { title, headerText, body, footerText, pages: doc.numPages, warnings };
}
