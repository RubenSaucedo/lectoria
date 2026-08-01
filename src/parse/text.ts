import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Document, DocumentParser, ParserOptions, SourceFile } from '../types.js';
import { ensureContent, resolveSourceLanguage, sectionsFromPlainText } from './content.js';

export class TextParser implements DocumentParser {
  readonly format = 'txt' as const;

  async parse(file: SourceFile, opts: ParserOptions = {}): Promise<Document> {
    const text = file.bytes.toString('utf-8');
    const sections = ensureContent(sectionsFromPlainText(text), file.uri);
    return {
      id: file.id,
      contentHash: file.contentHash,
      title: filenameOf(file.uri),
      language: resolveSourceLanguage(text, opts.sourceLanguage),
      sections,
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
      // Fall through to a best-effort basename.
    }
  }
  return basename(uri);
}
