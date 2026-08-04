import { describe, it, expect } from 'vitest';
import {
  applyGlossaryMarkers,
  applyGlossaryToScript,
  normalizeGlossary,
  renderGlossaryForPrompt,
  type NormalizedGlossaryTerm,
} from './glossary.js';
import type { Glossary, PodcastScript } from '../types.js';

function script(language: string, text: string): PodcastScript {
  return {
    id: 'fixture',
    documentId: 'fixture-document',
    language,
    episodeTitle: 'T',
    summary: 'S',
    segments: [
      {
        kind: 'body',
        heading: 'H',
        utterances: [{ voice: 'host', text }],
      },
    ],
  };
}

function terms(input: Glossary['terms']): NormalizedGlossaryTerm[] {
  return normalizeGlossary({ terms: input });
}

describe('normalizeGlossary', () => {
  it('expands bare strings and infers case-sensitivity from ALL-CAPS', () => {
    expect(normalizeGlossary({ terms: ['MCP', 'HubSpot'] })).toEqual([
      { term: 'MCP', caseSensitive: true },
      { term: 'HubSpot', caseSensitive: false },
    ]);
  });

  it('respects explicit caseSensitive overrides on objects', () => {
    expect(
      normalizeGlossary({
        terms: [
          { term: 'asana', caseSensitive: true },
          { term: 'API', caseSensitive: false },
        ],
      })
    ).toEqual([
      { term: 'asana', caseSensitive: true },
      { term: 'API', caseSensitive: false },
    ]);
  });

  it('keeps meaning and trims whitespace', () => {
    expect(normalizeGlossary({ terms: [{ term: '  MCP  ', meaning: '  Model Context Protocol  ' }] })).toEqual([
      { term: 'MCP', meaning: 'Model Context Protocol', caseSensitive: true },
    ]);
  });

  it('treats multi-word ALL-CAPS like "ADO 5417982" as case-sensitive', () => {
    expect(normalizeGlossary({ terms: ['ADO 5417982'] })).toEqual([
      { term: 'ADO 5417982', caseSensitive: true },
    ]);
  });

  it('skips empty and whitespace-only entries', () => {
    expect(normalizeGlossary({ terms: ['', '  ', { term: '' }] })).toEqual([]);
  });

  it('returns [] when glossary is undefined or malformed', () => {
    expect(normalizeGlossary(undefined)).toEqual([]);
    expect(normalizeGlossary({} as Glossary)).toEqual([]);
  });
});

describe('renderGlossaryForPrompt', () => {
  it('returns empty string when there are no terms', () => {
    expect(renderGlossaryForPrompt(undefined)).toBe('');
    expect(renderGlossaryForPrompt({ terms: [] })).toBe('');
  });

  it('lists each term with meaning and case-insensitive flag where set', () => {
    const out = renderGlossaryForPrompt({
      terms: ['MCP', { term: 'HubSpot' }, { term: 'asana', caseSensitive: false, meaning: 'project tool' }],
    });
    expect(out).toContain('- MCP');
    expect(out).toContain('- HubSpot');
    expect(out).toContain('- asana (case-insensitive) — project tool');
    expect(out).toContain('Project-specific glossary');
  });
});

describe('applyGlossaryMarkers (low-level text wrap)', () => {
  it('wraps a case-sensitive acronym only when written in its exact form', () => {
    expect(applyGlossaryMarkers('We use MCP and mcp here.', terms(['MCP']))).toBe(
      'We use [[en]]MCP[[/en]] and mcp here.'
    );
  });

  it('wraps a case-insensitive proper noun in any casing', () => {
    expect(applyGlossaryMarkers('Try Asana or asana.', terms(['Asana']))).toBe(
      'Try [[en]]Asana[[/en]] or [[en]]asana[[/en]].'
    );
  });

  it('respects word boundaries so "MCP" does not wrap inside "compositeMCPClient"', () => {
    expect(applyGlossaryMarkers('compositeMCPClient and MCP.', terms(['MCP']))).toBe(
      'compositeMCPClient and [[en]]MCP[[/en]].'
    );
  });

  it('does not double-wrap terms already inside an existing marker', () => {
    expect(applyGlossaryMarkers('We use [[en]]MCP[[/en]] today and MCP tomorrow.', terms(['MCP']))).toBe(
      'We use [[en]]MCP[[/en]] today and [[en]]MCP[[/en]] tomorrow.'
    );
  });

  it('handles multi-word ALL-CAPS tokens like "ADO 5417982"', () => {
    expect(applyGlossaryMarkers('Fix ADO 5417982 next.', terms(['ADO 5417982']))).toBe(
      'Fix [[en]]ADO 5417982[[/en]] next.'
    );
  });

  it('wraps longest matching term first to avoid nested markers', () => {
    expect(
      applyGlossaryMarkers('See ADO 5417982 and ADO generally.', terms(['ADO', 'ADO 5417982']))
    ).toBe('See [[en]]ADO 5417982[[/en]] and [[en]]ADO[[/en]] generally.');
  });

  it('escapes regex-special characters in terms', () => {
    expect(applyGlossaryMarkers('Use C# for this.', terms(['C#']))).toBe(
      'Use [[en]]C#[[/en]] for this.'
    );
  });

  it('is a no-op when there are no terms', () => {
    expect(applyGlossaryMarkers('plain text', [])).toBe('plain text');
  });
});

describe('applyGlossaryToScript', () => {
  it('wraps glossary terms in every utterance for non-English scripts', () => {
    const input = script('es', 'Hoy hablamos de MCP y HubSpot.');
    const out = applyGlossaryToScript(input, { terms: ['MCP', 'HubSpot'] });
    expect(out.segments[0]!.utterances[0]!.text).toBe(
      'Hoy hablamos de [[en]]MCP[[/en]] y [[en]]HubSpot[[/en]].'
    );
  });

  it('also wraps episodeTitle, summary, and segment heading', () => {
    const input: PodcastScript = {
      ...script('es', 'body'),
      episodeTitle: 'Sobre MCP',
      summary: 'Una nota sobre MCP.',
      segments: [
        {
          kind: 'body',
          heading: 'MCP en acción',
          utterances: [{ voice: 'host', text: 'body' }],
        },
      ],
    };
    const out = applyGlossaryToScript(input, { terms: ['MCP'] });
    expect(out.episodeTitle).toBe('Sobre [[en]]MCP[[/en]]');
    expect(out.summary).toBe('Una nota sobre [[en]]MCP[[/en]].');
    expect(out.segments[0]!.heading).toBe('[[en]]MCP[[/en]] en acción');
  });

  it('is a no-op when the script language is English', () => {
    const input = script('en', 'Today we discuss MCP and HubSpot.');
    const out = applyGlossaryToScript(input, { terms: ['MCP', 'HubSpot'] });
    expect(out).toBe(input);
  });

  it('treats en-US, en-GB as English too', () => {
    const input = script('en-US', 'Today we discuss MCP.');
    const out = applyGlossaryToScript(input, { terms: ['MCP'] });
    expect(out).toBe(input);
  });

  it('is a no-op when the glossary is empty or missing', () => {
    const input = script('es', 'Hoy hablamos de MCP.');
    expect(applyGlossaryToScript(input, undefined)).toBe(input);
    expect(applyGlossaryToScript(input, { terms: [] })).toBe(input);
  });

  it('does not mutate the input script', () => {
    const input = script('es', 'Hoy MCP.');
    const before = JSON.stringify(input);
    applyGlossaryToScript(input, { terms: ['MCP'] });
    expect(JSON.stringify(input)).toBe(before);
  });
});
