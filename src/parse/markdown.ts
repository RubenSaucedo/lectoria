import { unified } from 'unified';
import remarkParse from 'remark-parse';
import { visit } from 'unist-util-visit';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Document, DocumentParser, DocumentSection, SourceFile } from '../types.js';

interface MdNode {
  type: string;
  depth?: number;
  value?: string;
  children?: MdNode[];
}

export class MarkdownParser implements DocumentParser {
  readonly format = 'md' as const;

  async parse(file: SourceFile): Promise<Document> {
    const text = file.bytes.toString('utf-8');
    const tree = unified().use(remarkParse).parse(text) as unknown as MdNode;

    const sections: DocumentSection[] = [];
    let current: DocumentSection = { paragraphs: [] };
    let detectedTitle: string | undefined;

    visit(tree as never, (node: MdNode) => {
      if (node.type === 'heading') {
        const heading = nodeText(node);
        if (!detectedTitle && node.depth === 1) {
          detectedTitle = heading;
          return;
        }
        if (current.paragraphs.length || current.heading) sections.push(current);
        current = { heading, paragraphs: [] };
      } else if (node.type === 'paragraph') {
        const para = nodeText(node);
        if (para) current.paragraphs.push(para);
      }
    });
    if (current.paragraphs.length || current.heading) sections.push(current);

    return {
      id: file.id,
      title: detectedTitle ?? filenameOf(file.uri),
      language: 'en',
      sections: sections.length ? sections : [{ paragraphs: [text.trim()] }],
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
  if (!node.children) return '';
  return node.children.map(nodeText).join('').trim();
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
