import pdfParse from 'pdf-parse';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Document, DocumentParser, SourceFile } from '../types.js';

export class PdfParser implements DocumentParser {
  readonly format = 'pdf' as const;

  async parse(file: SourceFile): Promise<Document> {
    const result = await pdfParse(file.bytes);
    const text: string = result.text ?? '';
    const sections = splitIntoSections(text);
    const title = (result.info?.Title as string | undefined)?.trim() || filenameOf(file.uri);

    return {
      id: file.id,
      title,
      language: 'en',
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

function splitIntoSections(text: string) {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  // TODO: detect headings (font size, ALL CAPS, numbered) to build real sections.
  return [{ paragraphs }];
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
