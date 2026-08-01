import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Document, DocumentParser, ParserOptions, SourceFile } from '../types.js';
import { ensureContent, resolveSourceLanguage, sectionsFromHtml } from './content.js';

export class HtmlParser implements DocumentParser {
  readonly format = 'html' as const;

  async parse(file: SourceFile, opts: ParserOptions = {}): Promise<Document> {
    const html = file.bytes.toString('utf-8');
    const dom = new JSDOM(html, { url: file.uri.startsWith('http') ? file.uri : 'https://lectoria.local/' });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();

    const content = article?.content ?? dom.window.document.body.innerHTML;
    const sections = ensureContent(sectionsFromHtml(content), file.uri);
    const text = sections.flatMap((section) => [section.heading ?? '', ...section.paragraphs]).join('\n');
    const title = article?.title?.trim() || dom.window.document.title?.trim() || filenameOf(file.uri);

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
        byline: article?.byline ?? undefined,
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
