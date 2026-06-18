import mammoth from 'mammoth';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Document, DocumentParser, SourceFile } from '../types.js';

export class DocxParser implements DocumentParser {
  readonly format = 'docx' as const;

  async parse(file: SourceFile): Promise<Document> {
    const { value } = await mammoth.extractRawText({ buffer: file.bytes });
    const lines = value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const paragraphs = lines;
    // TODO: switch to mammoth.convertToHtml + heading detection for proper section splits.

    return {
      id: file.id,
      title: filenameOf(file.uri),
      language: 'en',
      sections: [{ paragraphs }],
      sourcePath: file.sourcePath,
      metadata: {
        sourceUri: file.uri,
        sourceFormat: file.format,
        fetchedAt: file.fetchedAt,
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
