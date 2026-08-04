import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PdfParser } from './pdf.js';
import type { SourceFile } from '../types.js';

// A hand-built 824-byte PDF: one page, three text lines, and a /Title in the
// Info dictionary. Kept tiny and in-repo so the PDF path has real coverage
// without a large binary fixture.
const FIXTURE = fileURLToPath(new URL('./__fixtures__/minimal.pdf', import.meta.url));

function pdfSource(overrides: Partial<SourceFile> = {}): SourceFile {
  return {
    id: 'pdf-fixture',
    contentHash: '0'.repeat(64),
    uri: 'file:///lesson.pdf',
    format: 'pdf',
    bytes: readFileSync(FIXTURE),
    fetchedAt: '2026-07-30T00:00:00.000Z',
    sourcePath: 'lesson',
    ...overrides,
  };
}

describe('PdfParser', () => {
  it('extracts page text and the page count', async () => {
    const doc = await new PdfParser().parse(pdfSource());

    const text = doc.sections.flatMap((section) => section.paragraphs).join(' ');
    expect(text).toContain('Shared Responsibility Model');
    expect(text).toContain('identities and data');
    expect(doc.metadata.pageCount).toBe(1);
  });

  it('prefers the PDF Info title over the file name', async () => {
    const doc = await new PdfParser().parse(pdfSource());
    expect(doc.title).toBe('Cloud Security Fundamentals');
  });

  it('falls back to the file name when the document has no Info title', async () => {
    // Strip the /Title entry so the Info dictionary no longer supplies one.
    const bytes = Buffer.from(
      readFileSync(FIXTURE)
        .toString('latin1')
        .replace('/Title (Cloud Security Fundamentals) ', ''),
      'latin1'
    );

    const doc = await new PdfParser().parse(
      pdfSource({ bytes, uri: 'file:///modulo-tres.pdf' })
    );
    expect(doc.title).toBe('modulo-tres.pdf');
  });

  it('does not leak page separators into the narrated text', async () => {
    const doc = await new PdfParser().parse(pdfSource());

    const text = doc.sections.flatMap((section) => section.paragraphs).join(' ');
    // pdf-parse v2 inserts "-- N of M --" between pages by default; that would
    // otherwise be read aloud in the generated audio.
    expect(text).not.toMatch(/--\s*\d+\s*of\s*\d+\s*--/);
  });

  it('rejects a PDF with no readable text', async () => {
    const bytes = Buffer.from(
      readFileSync(FIXTURE)
        .toString('latin1')
        .replace(/\(([^)]*)\) Tj/g, '() Tj'),
      'latin1'
    );

    await expect(new PdfParser().parse(pdfSource({ bytes }))).rejects.toThrow(/No readable text/);
  });
});
