import type { Document, DocumentParser, SourceFile } from '../types.js';
import { PdfParser } from './pdf.js';
import { DocxParser } from './docx.js';
import { MarkdownParser } from './markdown.js';
import { HtmlParser } from './html.js';

const parsers: DocumentParser[] = [
  new PdfParser(),
  new DocxParser(),
  new MarkdownParser(),
  new HtmlParser(),
];

export async function parse(file: SourceFile): Promise<Document> {
  const parser = parsers.find((p) => p.format === file.format);
  if (!parser) throw new Error(`No parser registered for format "${file.format}".`);
  return parser.parse(file);
}

export { PdfParser, DocxParser, MarkdownParser, HtmlParser };
