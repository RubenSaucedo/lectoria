import pdfParse from 'pdf-parse';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Document, DocumentParser, ParserOptions, SourceFile } from '../types.js';
import { ensureContent, resolveSourceLanguage, sectionsFromPlainText } from './content.js';

export class PdfParser implements DocumentParser {
  readonly format = 'pdf' as const;

  async parse(file: SourceFile, opts: ParserOptions = {}): Promise<Document> {
    const result = await pdfParse(file.bytes);
    const text: string = result.text ?? '';
    const sections = ensureContent(sectionsFromPlainText(text), file.uri);
    const title = (result.info?.Title as string | undefined)?.trim() || filenameOf(file.uri);

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
        pageCount: result.numpages,
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
