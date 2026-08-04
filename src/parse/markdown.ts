import { unified } from 'unified';
import remarkParse from 'remark-parse';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  Document,
  DocumentParser,
  DocumentSection,
  ParserOptions,
  SourceFile,
} from '../types.js';
import { ensureContent, resolveSourceLanguage } from './content.js';

interface MdNode {
  type: string;
  depth?: number;
  value?: string;
  alt?: string;
  lang?: string;
  children?: MdNode[];
}

export class MarkdownParser implements DocumentParser {
  readonly format = 'md' as const;

  async parse(file: SourceFile, opts: ParserOptions = {}): Promise<Document> {
    const text = file.bytes.toString('utf-8');
    const tree = unified().use(remarkParse).parse(text) as unknown as MdNode;

    const sections: DocumentSection[] = [];
    let current: DocumentSection = { paragraphs: [] };
    let detectedTitle: string | undefined;

    for (const node of tree.children ?? []) {
      if (node.type === 'heading') {
        const heading = nodeText(node);
        if (!detectedTitle && node.depth === 1) {
          detectedTitle = heading;
          continue;
        }
        if (current.paragraphs.length || current.heading) sections.push(current);
        current = { heading, paragraphs: [] };
        continue;
      }
      const block = markdownBlockText(node);
      if (block) current.paragraphs.push(block);
    }
    if (current.paragraphs.length || current.heading) sections.push(current);
    const normalized = ensureContent(sections, file.uri);

    return {
      id: file.id,
      contentHash: file.contentHash,
      title: detectedTitle ?? filenameOf(file.uri),
      language: resolveSourceLanguage(text, opts.sourceLanguage),
      sections: normalized,
      sourcePath: file.sourcePath,
      metadata: {
        sourceUri: file.uri,
        sourceFormat: file.format,
        fetchedAt: file.fetchedAt,
      },
    };
  }
}

function nodeText(node: MdNode): string {
  if (typeof node.value === 'string') return node.value;
  if (node.type === 'image' && node.alt) return node.alt;
  if (!node.children) return '';
  return node.children.map(nodeText).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

function markdownBlockText(node: MdNode): string {
  if (node.type === 'code') {
    const language = node.lang ? ` (${node.lang})` : '';
    return `Code${language}:\n${node.value?.trim() ?? ''}`;
  }
  if (node.type === 'list') {
    return (node.children ?? [])
      .map((item) => `- ${nodeText(item)}`)
      .filter((item) => item !== '- ')
      .join('\n');
  }
  if (node.type === 'blockquote') return `Quote: ${nodeText(node)}`;
  if (node.type === 'html') return node.value?.trim() ?? '';
  return nodeText(node);
}

function filenameOf(uri: string): string {
  if (uri.startsWith('file://')) {
    try {
      return basename(fileURLToPath(uri));
    } catch {
      // Malformed file URI (e.g. not absolute) — fall through to the raw
      // basename so parsing keeps working with a best-effort title.
    }
  }
  return basename(uri);
}
