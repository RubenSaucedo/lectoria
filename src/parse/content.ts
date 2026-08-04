import { JSDOM } from 'jsdom';
import type { DocumentSection, LanguageCode } from '../types.js';

const SPANISH_WORDS = new Set([
  'de', 'la', 'el', 'en', 'que', 'los', 'las', 'para', 'con', 'una', 'por', 'del', 'como',
]);
const ENGLISH_WORDS = new Set([
  'the', 'of', 'and', 'to', 'in', 'is', 'for', 'that', 'with', 'as', 'this', 'from', 'by',
]);

export function resolveSourceLanguage(
  text: string,
  override: LanguageCode | undefined
): LanguageCode {
  if (override) return override;
  const words = text.toLowerCase().match(/\p{L}+/gu) ?? [];
  let spanish = 0;
  let english = 0;
  for (const word of words.slice(0, 2_000)) {
    if (SPANISH_WORDS.has(word)) spanish++;
    if (ENGLISH_WORDS.has(word)) english++;
  }
  if (/[¿¡ñáéíóúü]/i.test(text)) spanish += 3;
  if (spanish >= 3 && spanish >= english * 1.5) return 'es';
  if (english >= 3 && english >= spanish * 1.5) return 'en';
  return 'und';
}

export function ensureContent(
  sections: DocumentSection[],
  sourceLabel: string
): DocumentSection[] {
  const normalized = sections
    .map((section) => ({
      ...(section.heading?.trim() ? { heading: section.heading.trim() } : {}),
      paragraphs: section.paragraphs.map((paragraph) => paragraph.trim()).filter(Boolean),
    }))
    .filter((section) => section.heading || section.paragraphs.length > 0);
  const characters = normalized.reduce(
    (total, section) =>
      total +
      (section.heading?.length ?? 0) +
      section.paragraphs.reduce((sum, paragraph) => sum + paragraph.length, 0),
    0
  );
  if (characters === 0) {
    throw new Error(
      `No readable text was extracted from "${sourceLabel}". The document may be empty, scanned, encrypted, or unsupported.`
    );
  }
  return normalized;
}

export function sectionsFromPlainText(text: string): DocumentSection[] {
  const blocks = text
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);
  return [{ paragraphs: blocks.map((block) => block.replace(/[ \t]+/g, ' ')) }];
}

export function sectionsFromHtml(html: string): DocumentSection[] {
  const dom = new JSDOM(`<body>${html}</body>`);
  const body = dom.window.document.body;
  const sections: DocumentSection[] = [];
  let current: DocumentSection = { paragraphs: [] };

  const pushCurrent = () => {
    if (current.heading || current.paragraphs.length > 0) sections.push(current);
  };

  const addParagraph = (text: string) => {
    const cleaned = cleanText(text);
    if (cleaned) current.paragraphs.push(cleaned);
  };

  const walk = (node: Node) => {
    if (node.nodeType === dom.window.Node.TEXT_NODE) {
      addParagraph(node.textContent ?? '');
      return;
    }
    if (!(node instanceof dom.window.Element)) return;
    const element = node;
    const tag = element.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag)) {
      pushCurrent();
      current = { heading: elementText(element), paragraphs: [] };
      return;
    }
    if (tag === 'img') {
      const alt = element.getAttribute('alt')?.trim();
      if (alt) current.paragraphs.push(`Image: ${alt}`);
      return;
    }
    if (tag === 'table') {
      const rows = [...element.querySelectorAll('tr')]
        .map((row) =>
          [...row.querySelectorAll('th,td')]
            .map((cell) => elementText(cell))
            .filter(Boolean)
            .join(' | ')
        )
        .filter(Boolean);
      if (rows.length > 0) current.paragraphs.push(`Table:\n${rows.join('\n')}`);
      return;
    }
    const text = elementText(element);
    if (tag === 'li') {
      if (text) current.paragraphs.push(`- ${text}`);
      return;
    }
    if (tag === 'pre') {
      if (text) current.paragraphs.push(`Code:\n${element.textContent?.trim() ?? ''}`);
      return;
    }
    if (tag === 'p') {
      addParagraph(text);
      return;
    }
    for (const child of [...element.childNodes]) walk(child);
  };

  for (const child of [...body.childNodes]) walk(child);
  pushCurrent();
  return sections;
}

function cleanText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function elementText(element: Element): string {
  const clone = element.cloneNode(true) as Element;
  for (const image of [...clone.querySelectorAll('img')]) {
    const alt = image.getAttribute('alt')?.trim();
    image.replaceWith(clone.ownerDocument.createTextNode(alt ? ` Image: ${alt} ` : ''));
  }
  return cleanText(clone.textContent ?? '');
}
