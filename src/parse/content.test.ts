import { describe, expect, it } from 'vitest';
import { sectionsFromHtml } from './content.js';

describe('sectionsFromHtml', () => {
  it('does not duplicate paragraphs nested inside list items or tables', () => {
    const sections = sectionsFromHtml(`
      <h2>Topic</h2>
      <ul><li><p>First item</p></li></ul>
      <table><tr><td><p>Cell value</p></td></tr></table>
    `);
    const paragraphs = sections.flatMap((section) => section.paragraphs);
    expect(paragraphs.filter((value) => value.includes('First item'))).toEqual(['- First item']);
    expect(paragraphs.filter((value) => value.includes('Cell value'))).toEqual([
      'Table:\nCell value',
    ]);
  });

  it('preserves image alt text inside paragraphs without duplicating it', () => {
    const paragraphs = sectionsFromHtml(
      '<p>Review <img alt="architecture diagram" src="diagram.png"> carefully.</p>'
    ).flatMap((section) => section.paragraphs);
    expect(paragraphs).toEqual(['Review Image: architecture diagram carefully.']);
  });

  it('preserves bare text in body and semantic containers', () => {
    const bodyText = sectionsFromHtml('Just bare text.').flatMap(
      (section) => section.paragraphs
    );
    expect(bodyText).toEqual(['Just bare text.']);

    const nested = sectionsFromHtml('<main><section>Section text only.</section></main>')
      .flatMap((section) => section.paragraphs);
    expect(nested).toEqual(['Section text only.']);
  });
});
