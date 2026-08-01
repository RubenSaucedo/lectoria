import { describe, expect, it } from 'vitest';
import { TextParser } from './text.js';
import type { SourceFile } from '../types.js';

function textSource(text: string): SourceFile {
  return {
    id: 'text-fixture',
    contentHash: '0'.repeat(64),
    uri: 'file:///lesson.txt',
    format: 'txt',
    bytes: Buffer.from(text),
    fetchedAt: '2026-07-30T00:00:00.000Z',
    sourcePath: 'lesson',
  };
}

describe('TextParser', () => {
  it('parses supported txt files and detects their source language', async () => {
    const doc = await new TextParser().parse(
      textSource('Este es el primer párrafo.\n\nEste contenido es para aprender.')
    );
    expect(doc.language).toBe('es');
    expect(doc.sections[0]!.paragraphs).toHaveLength(2);
  });

  it('rejects empty text files', async () => {
    await expect(new TextParser().parse(textSource('  \n'))).rejects.toThrow(/No readable text/);
  });
});
