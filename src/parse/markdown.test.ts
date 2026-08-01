import { describe, it, expect } from 'vitest';
import { MarkdownParser } from './markdown.js';
import type { SourceFile } from '../types.js';

function sourceFile(text: string, overrides: Partial<SourceFile> = {}): SourceFile {
  return {
    id: 'fixture',
    uri: 'file:///fixture.md',
    format: 'md',
    bytes: Buffer.from(text, 'utf-8'),
    fetchedAt: '2026-06-18T00:00:00.000Z',
    sourcePath: 'fixture',
    ...overrides,
    contentHash: overrides.contentHash ?? '0'.repeat(64),
  };
}

describe('MarkdownParser', () => {
  it('lifts the first H1 into Document.title and excludes it from sections', async () => {
    const doc = await new MarkdownParser().parse(
      sourceFile('# Big Title\n\n## First section\n\nFirst paragraph.')
    );
    expect(doc.title).toBe('Big Title');
    expect(doc.sections).toHaveLength(1);
    expect(doc.sections[0]!.heading).toBe('First section');
    expect(doc.sections[0]!.paragraphs).toEqual(['First paragraph.']);
  });

  it('groups paragraphs under the heading that precedes them', async () => {
    const doc = await new MarkdownParser().parse(
      sourceFile(
        '# Doc\n\n## A\n\npara A1.\n\npara A2.\n\n## B\n\npara B1.'
      )
    );
    expect(doc.sections).toHaveLength(2);
    expect(doc.sections[0]).toEqual({
      heading: 'A',
      paragraphs: ['para A1.', 'para A2.'],
    });
    expect(doc.sections[1]).toEqual({
      heading: 'B',
      paragraphs: ['para B1.'],
    });
  });

  it('forwards sourcePath from the SourceFile to the Document', async () => {
    const doc = await new MarkdownParser().parse(
      sourceFile('# X\n\nContent.', { sourcePath: 'python/lesson-1' })
    );
    expect(doc.sourcePath).toBe('python/lesson-1');
  });

  it('falls back to a single whole-text section when the doc has no headings', async () => {
    const doc = await new MarkdownParser().parse(sourceFile('just some prose.'));
    expect(doc.sections).toHaveLength(1);
    expect(doc.sections[0]!.heading).toBeUndefined();
    expect(doc.sections[0]!.paragraphs.join(' ')).toContain('just some prose.');
  });

  it('uses the filename as the title when no H1 is present', async () => {
    const doc = await new MarkdownParser().parse(
      sourceFile('## Subhead\n\npara.', { uri: 'file:///path/to/notes.md' })
    );
    expect(doc.title).toBe('notes.md');
  });

  it('preserves lists, code blocks, and image alt text for narration', async () => {
    const doc = await new MarkdownParser().parse(
      sourceFile(
        [
          '# Lesson',
          '',
          '- first item',
          '- second item',
          '',
          '```ts',
          'const answer = 42;',
          '```',
          '',
          '![Architecture diagram](diagram.png)',
        ].join('\n')
      )
    );
    const content = doc.sections.flatMap((section) => section.paragraphs).join('\n');
    expect(content).toContain('- first item');
    expect(content).toContain('Code (ts):');
    expect(content).toContain('const answer = 42;');
    expect(content).toContain('Architecture diagram');
  });

  it('detects Spanish and honors an explicit source-language override', async () => {
    const spanish = await new MarkdownParser().parse(
      sourceFile('# Tema\n\nEste es un texto para aprender de la arquitectura y los sistemas.')
    );
    expect(spanish.language).toBe('es');

    const overridden = await new MarkdownParser().parse(
      sourceFile('# Theme\n\nThis is the source content.'),
      { sourceLanguage: 'fr' }
    );
    expect(overridden.language).toBe('fr');
  });

  it('rejects empty or heading-only documents before paid stages', async () => {
    await expect(new MarkdownParser().parse(sourceFile('# Empty'))).rejects.toThrow(
      /No readable text was extracted/
    );
  });
});
