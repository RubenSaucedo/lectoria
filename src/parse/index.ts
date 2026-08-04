import type { Document, DocumentParser, SourceFile } from '../types.js';
import { PdfParser } from './pdf.js';
import { DocxParser } from './docx.js';
import { MarkdownParser } from './markdown.js';
import { HtmlParser } from './html.js';
import { TextParser } from './text.js';
import type { ParserOptions } from '../types.js';

export const defaultParsers: readonly DocumentParser[] = [
  new PdfParser(),
  new DocxParser(),
  new MarkdownParser(),
  new HtmlParser(),
  new TextParser(),
];

export interface ParseOptions extends ParserOptions {
  parsers?: readonly DocumentParser[];
}

export async function parse(file: SourceFile, opts: ParseOptions = {}): Promise<Document> {
  const parser = (opts.parsers ?? defaultParsers).find((candidate) => candidate.format === file.format);
  if (!parser) throw new Error(`No parser registered for format "${file.format}".`);
  return parser.parse(file, { sourceLanguage: opts.sourceLanguage });
}

export { PdfParser, DocxParser, MarkdownParser, HtmlParser, TextParser };
