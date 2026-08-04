import { PDFParse } from 'pdf-parse';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Document, DocumentParser, ParserOptions, SourceFile } from '../types.js';
import { ensureContent, resolveSourceLanguage, sectionsFromPlainText } from './content.js';

export class PdfParser implements DocumentParser {
  readonly format = 'pdf' as const;

  async parse(file: SourceFile, opts: ParserOptions = {}): Promise<Document> {
    // pdf-parse v2 wraps pdf.js and holds a worker plus the decoded document
    // until destroy() runs, so every exit path has to release it or a batch
    // run leaks one document per PDF.
    const parser = new PDFParse({ data: new Uint8Array(file.bytes) });
    let text: string;
    let pageCount: number;
    let pdfTitle: string | undefined;
    try {
      // v2 defaults to inserting "-- N of M --" between pages. That text would
      // flow into the script and get narrated aloud, so suppress it; an empty
      // joiner disables the marker entirely.
      const result = await parser.getText({ pageJoiner: '' });
      text = result.text ?? '';
      pageCount = result.total;
      const info = await parser.getInfo();
      const rawTitle: unknown = info.info?.Title;
      pdfTitle = typeof rawTitle === 'string' ? rawTitle : undefined;
    } finally {
      await parser.destroy();
    }

    const sections = ensureContent(sectionsFromPlainText(text), file.uri);
    const title = pdfTitle?.trim() || filenameOf(file.uri);

    return {
      id: file.id,
      contentHash: file.contentHash,
      title,
      language: resolveSourceLanguage(text, opts.sourceLanguage),
      sections,
      sourcePath: file.sourcePath,
      metadata: {
        sourceUri: file.uri,
        sourceFormat: file.format,
        fetchedAt: file.fetchedAt,
        pageCount,
      },
    };
  }
}

function filenameOf(uri: string): string {
  if (uri.startsWith('file://')) {
    try {
      return basename(fileURLToPath(uri));
    } catch {
      // Malformed file URI — fall through to the raw basename.
    }
  }
  return basename(uri);
}
