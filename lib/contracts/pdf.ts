import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { RuleError } from '../errors.ts';
import { fillText, type ContractTemplate } from './templates.ts';

// Renderização do contrato em PDF (instrucao-sistema-vendas.md §8–§9): A4, texto real
// (pesquisável/selecionável, nada rasterizado), fontes padrão do PDF (Helvetica — "fontes
// seguras", suportam a acentuação do português pela codificação WinAnsi), paginação estável e
// marcadores do Adapter Sign como TEXTO logo acima de cada linha de assinatura, em fonte
// pequena e branca (a integração aceita marcador invisível, desde que seja texto).
//
// A marcação (**negrito**, __itálico__) é interpretada só no texto do MODELO; os valores dos
// placeholders entram como texto literal depois — dado do cliente não altera a formatação.

const PAGE = { width: 595.28, height: 841.89 };
const MARGIN = { left: 64, right: 64, top: 64, bottom: 64 };
const CONTENT_WIDTH = PAGE.width - MARGIN.left - MARGIN.right;
const BLACK = rgb(0, 0, 0);
const WHITE = rgb(1, 1, 1);
const MARKER_SIZE = 5;

type Style = { bold: boolean; italic: boolean };
type Segment = { text: string; style: Style };
type Word = Segment[];
type Fonts = Record<'regular' | 'bold' | 'italic' | 'boldItalic', PDFFont>;

export const signatureMarker = (role: string) => `[[AS:assinatura:${role}]]`;

/** Quebra o texto do modelo em trechos com estilo e substitui os placeholders por valores literais. */
export function toSegments(templateText: string, values: Record<string, string>): Segment[] {
 const segments: Segment[] = [];
 let bold = false;
 let italic = false;
 for (const part of templateText.split(/(\*\*|__)/)) {
  if (part === '**') { bold = !bold; continue; }
  if (part === '__') { italic = !italic; continue; }
  if (part) segments.push({ text: fillText(part, values), style: { bold, italic } });
 }
 return segments;
}

function fontFor(fonts: Fonts, style: Style): PDFFont {
 return style.bold && style.italic ? fonts.boldItalic : style.bold ? fonts.bold : style.italic ? fonts.italic : fonts.regular;
}

function toWords(segments: Segment[]): Word[] {
 const words: Word[] = [];
 let current: Word = [];
 for (const seg of segments) {
  const pieces = seg.text.split(/(\s+)/);
  for (const piece of pieces) {
   if (!piece) continue;
   if (/^\s+$/.test(piece)) {
    if (current.length) words.push(current);
    current = [];
   } else current.push({ text: piece, style: seg.style });
  }
 }
 if (current.length) words.push(current);
 return words;
}

class Writer {
 page!: PDFPage;
 y = 0;
 pages: PDFPage[] = [];
 private readonly doc: PDFDocument;
 readonly fonts: Fonts;
 constructor(doc: PDFDocument, fonts: Fonts) {
  this.doc = doc;
  this.fonts = fonts;
  this.newPage();
 }
 newPage() {
  this.page = this.doc.addPage([PAGE.width, PAGE.height]);
  this.pages.push(this.page);
  this.y = PAGE.height - MARGIN.top;
 }
 ensure(height: number) { if (this.y - height < MARGIN.bottom) this.newPage(); }
 wordWidth(word: Word, size: number) { return word.reduce((a, s) => a + fontFor(this.fonts, s.style).widthOfTextAtSize(s.text, size), 0); }

 /** Parágrafo com quebra de linha; justify distribui o espaço nas linhas que não são a última. */
 paragraph(segments: Segment[], opts: { size: number; x?: number; width?: number; justify?: boolean; align?: 'left' | 'center'; after?: number }) {
  const size = opts.size;
  const x0 = opts.x ?? MARGIN.left;
  const maxWidth = opts.width ?? CONTENT_WIDTH;
  const lineHeight = size * 1.45;
  const space = this.fonts.regular.widthOfTextAtSize(' ', size);
  const words = toWords(segments).flatMap((w) => this.splitLong(w, size, maxWidth));
  const lines: Word[][] = [];
  let line: Word[] = [];
  let width = 0;
  for (const word of words) {
   const w = this.wordWidth(word, size);
   if (line.length && width + space + w > maxWidth) { lines.push(line); line = []; width = 0; }
   width += (line.length ? space : 0) + w;
   line.push(word);
  }
  if (line.length) lines.push(line);
  lines.forEach((ln, index) => {
   this.ensure(lineHeight);
   this.y -= lineHeight;
   const widths = ln.map((w) => this.wordWidth(w, size));
   const natural = widths.reduce((a, b) => a + b, 0) + space * (ln.length - 1);
   const isLast = index === lines.length - 1;
   let gap = space;
   let x = x0;
   if (opts.justify && !isLast && ln.length > 1) gap = (maxWidth - widths.reduce((a, b) => a + b, 0)) / (ln.length - 1);
   else if (opts.align === 'center') x = x0 + (maxWidth - natural) / 2;
   ln.forEach((word, i) => {
    let cx = x;
    word.forEach((seg, j) => {
     const font = fontFor(this.fonts, seg.style);
     // Espaço real no fim da palavra (exceto a última da linha): leitores de PDF e a busca de
     // texto reconhecem a separação mesmo com cada palavra posicionada individualmente.
     const text = j === word.length - 1 && i < ln.length - 1 ? `${seg.text} ` : seg.text;
     this.page.drawText(text, { x: cx, y: this.y, size, font, color: BLACK });
     cx += font.widthOfTextAtSize(seg.text, size);
    });
    x += widths[i] + gap;
   });
  });
  this.y -= opts.after ?? 0;
 }

 /** Palavra maior que a linha (ex.: e-mail longo) é quebrada por caractere. */
 private splitLong(word: Word, size: number, maxWidth: number): Word[] {
  if (this.wordWidth(word, size) <= maxWidth) return [word];
  const out: Word[] = [];
  let current: Word = [];
  let width = 0;
  for (const seg of word) {
   const font = fontFor(this.fonts, seg.style);
   for (const ch of seg.text) {
    const w = font.widthOfTextAtSize(ch, size);
    if (width + w > maxWidth && current.length) { out.push(current); current = []; width = 0; }
    const last = current[current.length - 1];
    if (last && last.style === seg.style) last.text += ch;
    else current.push({ text: ch, style: seg.style });
    width += w;
   }
  }
  if (current.length) out.push(current);
  return out;
 }

 signature(role: string, label: Segment[], size: number) {
  this.ensure(80);
  this.y -= 36;
  const lineWidth = 300;
  const x = MARGIN.left + (CONTENT_WIDTH - lineWidth) / 2;
  // Marcador do Adapter Sign: texto real, logo acima da linha, pequeno e branco.
  this.page.drawText(signatureMarker(role), { x, y: this.y + 3, size: MARKER_SIZE, font: this.fonts.regular, color: WHITE });
  this.page.drawLine({ start: { x, y: this.y }, end: { x: x + lineWidth, y: this.y }, thickness: 0.8, color: BLACK });
  this.y -= 2;
  this.paragraph(label, { size, x: MARGIN.left, width: CONTENT_WIDTH, align: 'center', after: 10 });
 }
}

/** Confere se todo o texto cabe na codificação da fonte (caracteres fora dela bloqueiam, sem trocar por "?"). */
function assertEncodable(fonts: Fonts, values: Record<string, string>, labels: Record<string, string>) {
 const bad: string[] = [];
 for (const [key, value] of Object.entries(values)) {
  try {
   fonts.regular.encodeText(value);
  } catch {
   bad.push(labels[key] ?? key);
  }
 }
 if (bad.length) throw new RuleError(`Não foi possível gerar o contrato: há caracteres não suportados em ${bad.join(', ')}. Corrija o cadastro (emojis e símbolos especiais não são aceitos).`, 400);
}

/** Texto do MODELO da loja (importado de PDF) com caractere fora da fonte: explica qual, para corrigir no editor. */
function assertTemplateEncodable(fonts: Fonts, template: ContractTemplate) {
 const texts = [...template.blocks.map((b) => ('text' in b ? b.text : 'label' in b ? b.label : '')), template.page?.headerText ?? '', template.page?.footerText ?? ''];
 const bad = new Set<string>();
 for (const ch of new Set(texts.join(''))) {
  if (ch === '\n') continue;
  try { fonts.regular.encodeText(ch); } catch { bad.add(ch); }
 }
 if (bad.size) throw new RuleError(`O texto do modelo tem caracteres que o PDF não suporta: ${[...bad].map((c) => `"${c}"`).join(' ')}. Troque por letras comuns no editor do modelo.`, 400);
}

const FOOTER_SIZE = 7.5;
const HEADER_SIZE = 8.5;

/** Logo e cabeçalho da empresa no topo da 1ª página; devolve a altura usada. */
async function drawHeader(doc: PDFDocument, w: Writer, page: NonNullable<ContractTemplate['page']>, values: Record<string, string>) {
 const top = PAGE.height - 40;
 let x = MARGIN.left;
 let bottom = top;
 if (page.logo) {
  const image = page.logo.mime === 'image/png' ? await doc.embedPng(page.logo.bytes) : await doc.embedJpg(page.logo.bytes);
  const scale = Math.min(150 / image.width, 56 / image.height, 1);
  const lw = image.width * scale, lh = image.height * scale;
  w.page.drawImage(image, { x, y: top - lh, width: lw, height: lh });
  x += lw + 14;
  bottom = Math.min(bottom, top - lh);
 }
 const lines = page.headerText.split('\n').map((l) => l.trim()).filter(Boolean);
 let y = top - HEADER_SIZE;
 lines.forEach((line, i) => {
  // 1ª linha do cabeçalho (nome da empresa) em negrito, como nos contratos de origem.
  const segments = i === 0 && !line.includes('**') ? [{ text: fillText(line, values), style: { bold: true, italic: false } }] : toSegments(line, values);
  let cx = x;
  for (const seg of segments) {
   const font = fontFor(w.fonts, seg.style);
   w.page.drawText(seg.text, { x: cx, y, size: HEADER_SIZE, font, color: BLACK });
   cx += font.widthOfTextAtSize(seg.text, HEADER_SIZE);
  }
  y -= HEADER_SIZE * 1.4;
 });
 bottom = Math.min(bottom, y + HEADER_SIZE * 0.4);
 w.y = Math.min(w.y, bottom - 18);
}

export async function renderContractPdf(template: ContractTemplate, values: Record<string, string>, meta: { title: string; now: number; clientInitials?: boolean }): Promise<Uint8Array> {
 const doc = await PDFDocument.create();
 const fonts: Fonts = {
  regular: await doc.embedFont(StandardFonts.Helvetica),
  bold: await doc.embedFont(StandardFonts.HelveticaBold),
  italic: await doc.embedFont(StandardFonts.HelveticaOblique),
  boldItalic: await doc.embedFont(StandardFonts.HelveticaBoldOblique),
 };
 assertEncodable(fonts, values, Object.fromEntries(template.required.map((r) => [r.key, r.label])));
 if (template.page) assertTemplateEncodable(fonts, template);
 const roles = template.signatureRoles ?? { company: 'loja', client: 'cliente' };
 doc.setTitle(meta.title);
 doc.setProducer('OmniHub');
 doc.setCreator('OmniHub');
 doc.setCreationDate(new Date(meta.now));
 doc.setModificationDate(new Date(meta.now));
 const s = template.style;
 const w = new Writer(doc, fonts);
 if (template.page) await drawHeader(doc, w, template.page, values);
 for (const block of template.blocks) {
  if (block.kind === 'title') {
   w.paragraph([{ text: fillText(block.text, values), style: { bold: s.titleBold, italic: false } }], { size: s.titleSize, align: s.titleAlign, after: 14 });
  } else if (block.kind === 'heading') {
   w.ensure(s.headingSize * 4);
   w.y -= 10;
   w.paragraph([{ text: fillText(block.text, values), style: { bold: s.headingBold, italic: false } }], { size: s.headingSize, justify: false, after: 4 });
  } else if (block.kind === 'p') {
   w.paragraph(toSegments(block.text, values), { size: s.bodySize, justify: s.justify, after: 5 });
  } else if (block.kind === 'bullet') {
   const size = s.bodySize;
   w.ensure(size * 1.45);
   const bulletY = w.y - size * 1.45;
   w.page.drawText('•', { x: MARGIN.left + 8, y: bulletY, size, font: fonts.regular, color: BLACK });
   w.paragraph(toSegments(block.text, values), { size, x: MARGIN.left + 22, width: CONTENT_WIDTH - 22, justify: false, after: 1 });
  } else if (block.kind === 'item') {
   // Item numerado de lista ("1. Calibragem do pneu;"): recuado, o número faz parte do texto.
   w.paragraph(toSegments(block.text, values), { size: s.bodySize, x: MARGIN.left + 18, width: CONTENT_WIDTH - 18, justify: s.justify, after: 2 });
  } else if (block.kind === 'space') {
   w.y -= block.size ?? 8;
  } else if (block.kind === 'signature') {
   w.signature(block.role === 'loja' ? roles.company : roles.client, toSegments(block.label, values), s.bodySize);
  }
 }
 if (template.page) {
  // Rodapé da loja + "Página 01" em todas as páginas (como nos contratos de origem).
  const footer = template.page.footerText.trim() ? toSegments(template.page.footerText.trim(), values).map((x) => x.text).join('') : '';
  w.pages.forEach((page, i) => {
   const label = `Página ${String(i + 1).padStart(2, '0')}`;
   if (footer) page.drawText(footer.slice(0, 160), { x: MARGIN.left, y: 30, size: FOOTER_SIZE, font: fonts.regular, color: BLACK });
   page.drawText(label, { x: PAGE.width - MARGIN.right - fonts.regular.widthOfTextAtSize(label, FOOTER_SIZE), y: 30, size: FOOTER_SIZE, font: fonts.regular, color: BLACK });
  });
 } else if (s.pageNumbers) {
  w.pages.forEach((page, i) => {
   const label = String(i + 1);
   page.drawText(label, { x: PAGE.width - MARGIN.right - fonts.regular.widthOfTextAtSize(label, 9), y: MARGIN.bottom / 2, size: 9, font: fonts.regular, color: BLACK });
  });
 }
 if(meta.clientInitials) {
  for(const page of w.pages) {
   // Área reservada do rodapé, fora do texto e da numeração. Âncora real por página.
   page.drawText(`[[AS:rubrica:${roles.client}]]`,{x:MARGIN.left,y:40,size:MARKER_SIZE,font:fonts.regular,color:WHITE});
  }
 }
 return doc.save({ useObjectStreams: false });
}
