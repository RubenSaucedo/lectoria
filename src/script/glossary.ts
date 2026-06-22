import type { Glossary, GlossaryEntry, PodcastScript, PodcastSegment } from '../types.js';

/**
 * Normalized form of a glossary entry, with the case-sensitivity heuristic
 * applied. Always carries an explicit boolean so downstream code never
 * has to re-derive it.
 */
export interface NormalizedGlossaryTerm {
  term: string;
  meaning?: string;
  caseSensitive: boolean;
}

/**
 * Expand the loose `GlossaryEntry` shape (bare strings or objects) into a
 * uniform array with the case-sensitivity default resolved. Skips empty
 * terms so callers can pass user-edited files without filtering first.
 *
 * Default heuristic: a term is case-sensitive iff it's all uppercase (with
 * digits / punctuation allowed). That matches acronyms like "MCP" / "API" /
 * "ADO 5417982" without also catching brand names like "HubSpot" where
 * the casing matters less for matching.
 */
export function normalizeGlossary(glossary: Glossary | undefined): NormalizedGlossaryTerm[] {
  if (!glossary || !Array.isArray(glossary.terms)) return [];
  const out: NormalizedGlossaryTerm[] = [];
  for (const entry of glossary.terms) {
    const normalized = normalizeEntry(entry);
    if (normalized) out.push(normalized);
  }
  return out;
}

function normalizeEntry(entry: GlossaryEntry): NormalizedGlossaryTerm | null {
  if (typeof entry === 'string') {
    const term = entry.trim();
    if (!term) return null;
    return { term, caseSensitive: isAllCapsAcronym(term) };
  }
  const term = entry.term?.trim();
  if (!term) return null;
  return {
    term,
    meaning: entry.meaning?.trim() || undefined,
    caseSensitive: entry.caseSensitive ?? isAllCapsAcronym(term),
  };
}

function isAllCapsAcronym(term: string): boolean {
  // True when every letter in the term is uppercase. Digits, spaces, and
  // punctuation are allowed and don't affect the decision so "ADO 5417982"
  // and "C#" still count as case-sensitive.
  let sawLetter = false;
  for (const ch of term) {
    if (/\p{L}/u.test(ch)) {
      sawLetter = true;
      if (ch.toUpperCase() !== ch) return false;
    }
  }
  return sawLetter;
}

/**
 * Renders the glossary as a compact instruction block for the user prompt.
 * The system prompt already explains the marker; this block enumerates the
 * project's specific terms so the model treats them as authoritative.
 *
 * Returns an empty string when there's nothing to emit so callers can
 * concatenate unconditionally.
 */
export function renderGlossaryForPrompt(glossary: Glossary | undefined): string {
  const terms = normalizeGlossary(glossary);
  if (terms.length === 0) return '';

  const lines: string[] = [
    'Project-specific glossary — always wrap every occurrence of these',
    'exact terms in [[en]]…[[/en]] markers when the target language is not',
    'English. Do NOT translate, expand, or transliterate them. Do not wrap',
    'them when the target language IS English.',
  ];
  for (const t of terms) {
    const cs = t.caseSensitive ? '' : ' (case-insensitive)';
    const meaning = t.meaning ? ` — ${t.meaning}` : '';
    lines.push(`  - ${t.term}${cs}${meaning}`);
  }
  return lines.join('\n');
}

/**
 * Marker the synthesis stage recognises. Mirrored in src/synthesize/azure-speech.ts.
 * Kept simple so it survives JSON round-trips without escaping.
 */
const OPEN = '[[en]]';
const CLOSE = '[[/en]]';
const MARKER_RE = /\[\[en\]\]([\s\S]*?)\[\[\/en\]\]/g;

/**
 * Walk a finished script and wrap any unmarked occurrence of a glossary
 * term in `[[en]]…[[/en]]`. Skips spans already inside a marker so we
 * never double-wrap. Returns a new script — the input is not mutated.
 *
 * This is the deterministic safety net: prompts try, this pass guarantees.
 * Terms longer than 1 character are matched with word boundaries
 * (`\b<term>\b`) so substrings inside other words don't get wrapped.
 * Terms that contain whitespace are matched literally (no word-boundary
 * heuristic) since `\b` doesn't compose with internal spaces.
 *
 * Also wraps `episodeTitle`, `summary`, and segment `heading`s so
 * downstream consumers (RSS feed, ID3 tags) see the markers too — though
 * the synthesis stage currently strips them only inside utterance text.
 */
export function applyGlossaryToScript(
  script: PodcastScript,
  glossary: Glossary | undefined
): PodcastScript {
  const terms = normalizeGlossary(glossary);
  if (terms.length === 0) return script;

  // English scripts don't need the marker — the synthesis stage would just
  // strip it back out — so skip the work and keep scripts clean.
  if (typeof script.language === 'string' && script.language.toLowerCase().startsWith('en')) {
    return script;
  }

  const wrap = (text: string) => applyGlossaryMarkers(text, terms);

  return {
    ...script,
    episodeTitle: wrap(script.episodeTitle),
    summary: wrap(script.summary),
    segments: script.segments.map<PodcastSegment>((seg) => ({
      ...seg,
      heading: seg.heading ? wrap(seg.heading) : seg.heading,
      utterances: seg.utterances.map((u) => ({ ...u, text: wrap(u.text) })),
    })),
  };
}

/**
 * Wrap every unmarked occurrence of each glossary term in `[[en]]…[[/en]]`.
 *
 * Algorithm: split the text into "outside-marker" and "inside-marker"
 * regions. Only the outside regions are scanned for terms; insides are
 * preserved verbatim so we never wrap something that's already wrapped.
 *
 * Exported for unit testing.
 */
export function applyGlossaryMarkers(text: string, terms: NormalizedGlossaryTerm[]): string {
  if (!text || terms.length === 0) return text;

  // Walk the input segment-by-segment: any chunk *outside* an existing
  // `[[en]]…[[/en]]` span is eligible for wrapping; anything inside is kept
  // exactly as-is.
  const out: string[] = [];
  let cursor = 0;
  MARKER_RE.lastIndex = 0;
  for (let match = MARKER_RE.exec(text); match !== null; match = MARKER_RE.exec(text)) {
    out.push(wrapTermsInPlainText(text.slice(cursor, match.index), terms));
    out.push(match[0]);
    cursor = match.index + match[0].length;
  }
  out.push(wrapTermsInPlainText(text.slice(cursor), terms));
  return out.join('');
}

function wrapTermsInPlainText(text: string, terms: NormalizedGlossaryTerm[]): string {
  if (!text) return text;
  // Longest terms first so "ADO 5417982" wraps before bare "ADO" inside the
  // same string and we don't end up with nested markers.
  const sorted = [...terms].sort((a, b) => b.term.length - a.term.length);
  let working = text;
  for (const t of sorted) {
    working = wrapTerm(working, t);
  }
  return working;
}

function wrapTerm(text: string, t: NormalizedGlossaryTerm): string {
  const escaped = escapeRegex(t.term);
  // Build the boundary based on the term's own edge characters: `\b` only
  // works when both sides are word characters. Multi-word terms ("ADO
  // 5417982") use lookarounds so they can't match mid-token.
  const flags = t.caseSensitive ? 'g' : 'gi';
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, flags + 'u');

  return text.replace(pattern, (match, offset, full) => {
    // Don't wrap if this match is already inside an `[[en]]…[[/en]]` span.
    // (The caller already excluded existing markers from the input, but
    // be defensive in case a term contains marker punctuation.)
    if (typeof offset === 'number' && typeof full === 'string' && isInsideExistingMarker(full, offset)) {
      return match;
    }
    return `${OPEN}${match}${CLOSE}`;
  });
}

function isInsideExistingMarker(full: string, offset: number): boolean {
  const before = full.slice(0, offset);
  const lastOpen = before.lastIndexOf(OPEN);
  const lastClose = before.lastIndexOf(CLOSE);
  return lastOpen !== -1 && lastOpen > lastClose;
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
