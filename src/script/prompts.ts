import type { Document, Glossary, LanguageCode, DialogueSpeaker, ScriptStyle } from '../types.js';
import { renderGlossaryForPrompt } from './glossary.js';

/**
 * System and user prompt templates for the scripting stage.
 *
 * These return JSON-shaped instructions so the model output can be parsed
 * directly into a PodcastScript without a free-form extraction step.
 */

/**
 * Shared guidance about preserving proper nouns, code identifiers, and
 * (most importantly) English acronyms / initialisms when the target
 * language is not English. Without this, models tend to expand or
 * translate acronyms like MCP, CCA, ADO — and TTS engines pronounce
 * the surviving letters with the target language's letter names
 * ("eme-ce-pe" instead of "em-see-pee").
 *
 * The `[[en]]…[[/en]]` marker is a Lectoria-private convention that the
 * synthesis stage rewrites into `<lang xml:lang="en-US">…</lang>` SSML so
 * Azure Neural TTS pronounces the wrapped span in English, even inside a
 * Spanish (or any other non-English) narration.
 */
export function preservationRules(): string {
  return [
    'Preserving English terms when narrating in another language:',
    '- Keep proper nouns, product names, company names, file paths, URLs,',
    '  code identifiers, and numeric ids in their original Latin-letter form.',
    '  Examples: HubSpot, Asana, GitHub, Azure, ADO 5417982, src/index.ts.',
    '- Keep English acronyms, initialisms, and abbreviations in their',
    '  original uppercase Latin-letter form. Do NOT translate them, do NOT',
    '  expand them, do NOT transliterate them, do NOT localize them.',
    '  Examples that must survive verbatim: MCP, CCA, DA, ADO, API, SDK,',
    '  HTML, CSS, KPI, CEO, AI, ML, LLM, JSON, YAML, URL, UI, UX, PR, QA.',
    '- When the target language is NOT English, wrap each such span in the',
    '  literal Lectoria marker [[en]]…[[/en]] so the audio narrator',
    '  pronounces it with English phonetics. Wrap only the term itself, not',
    '  surrounding articles, prepositions, or descriptions. Examples:',
    '    Spanish: "Hoy vamos a hablar de [[en]]MCP[[/en]] y de cómo se',
    '             integra con [[en]]HubSpot[[/en]]."',
    '    Spanish: "El bug [[en]]ADO 5417982[[/en]] sigue abierto."',
    '    Spanish: "La [[en]]API[[/en]] de [[en]]GitHub[[/en]] devuelve',
    '             [[en]]JSON[[/en]]."',
    '- When the target language IS English, do NOT emit the [[en]] marker',
    '  at all — just write the term normally.',
    '- Do not nest markers. Do not wrap whole sentences. Do not wrap',
    '  numbers that are already pronounced the same in both languages',
    '  unless they are part of a code/id (e.g. "ADO 5417982" wraps the',
    '  whole token; the year "2026" does not need wrapping).',
    '- Never use any other XML, SSML, or markup inside utterance text.',
    '  The [[en]]…[[/en]] marker is the only inline tag Lectoria accepts.',
    '- The user message may include a "Project-specific glossary" section',
    '  listing terms that must always be wrapped. Treat that list as',
    '  authoritative — every occurrence of those terms must be wrapped in',
    '  non-English narration, in addition to the general rules above.',
  ].join('\n');
}

export function scriptSystemPrompt(): string {
  return [
    'You are a senior podcast producer who turns written learning material into',
    'engaging, conversational audio scripts. You write in the requested language',
    'natively (not translated). You preserve technical accuracy while making the',
    'material easy to follow by ear: short sentences, signposting, brief recaps,',
    'and an inviting tone. You write a single solo-host narration unless told otherwise.',
    '',
    preservationRules(),
    '',
    'Return STRICT JSON only. No prose, no markdown. The JSON shape is:',
    '{',
    '  "episodeTitle": string,',
    '  "summary": string,',
    '  "segments": [',
    '    {',
    '      "kind": "intro" | "body" | "outro" | "chapter",',
    '      "heading": string | null,',
    '      "utterances": [ { "voice": "host", "text": string, "pauseAfterMs": number | null } ]',
    '    }',
    '  ]',
    '}',
  ].join('\n');
}

export function scriptUserPrompt(
  doc: Document,
  opts: { targetLanguage: LanguageCode; style: ScriptStyle; glossary?: Glossary }
): string {
  const flattened = doc.sections
    .map((s) => (s.heading ? `## ${s.heading}\n\n${s.paragraphs.join('\n\n')}` : s.paragraphs.join('\n\n')))
    .join('\n\n');
  const glossarySection = renderGlossaryForPrompt(opts.glossary);

  return [
    `Target language: ${opts.targetLanguage}`,
    `Style: ${opts.style.kind}`,
    `Source title: ${doc.title}`,
    '',
    'Source content follows. Produce one podcast episode that teaches this material.',
    'Open with a short welcoming intro that frames why the listener should care.',
    'Break the body into 3-7 clearly signposted chapters. End with a brief recap and a friendly sign-off.',
    'Keep each utterance under ~60 words so TTS pacing stays natural.',
    'Insert "pauseAfterMs": 400 between major thoughts where a breath would help.',
    ...(glossarySection ? ['', glossarySection] : []),
    '',
    '---',
    flattened,
    '---',
  ].join('\n');
}

export function translateSystemPrompt(): string {
  return [
    'You are a bilingual audio-script editor. You rewrite an existing audio',
    'script into another language so it sounds like it was originally written',
    'in that language (not literally translated). Preserve the segment',
    'structure, voice tags, and pauseAfterMs values exactly. Keep technical',
    'terms accurate.',
    '',
    preservationRules(),
    '',
    'Return STRICT JSON only. No prose, no markdown. The top-level JSON shape is:',
    '{',
    '  "episodeTitle": string,',
    '  "summary": string,',
    '  "segments": [ ...same structure as the input segments... ]',
    '}',
  ].join('\n');
}

/**
 * Conversational mode: natural spoken read-along between podcast and verbatim.
 *
 * The point of this mode is to let a listener understand the document by ear
 * without it sounding like a show. No welcome, no sign-off, no host banter,
 * no chapter teasers — but the model IS allowed to restructure visually-coded
 * content (numbered lists, tables, repeated headings) into spoken flow, and
 * to add brief bridging phrases so adjacent ideas connect.
 *
 * Think ~70% fidelity: the missing ~30% is the visual scaffolding that
 * doesn't carry meaning when spoken plus the small connective tissue needed
 * for a smooth listen. The model must NOT invent facts, examples, opinions,
 * or skip ideas that are in the source.
 */
export function conversationalSystemPrompt(): string {
  return [
    'You are a thoughtful narrator preparing a written document for audio',
    'playback in the requested target language. Your job is to deliver the',
    'document in a natural spoken voice — not as a podcast with host banter,',
    'and not as a screen reader.',
    '',
    'The listener should come away understanding the document\'s ideas and',
    'structure without ever opening it. Aim for about 70% fidelity to the',
    'source content. The missing ~30% is the visual scaffolding that does',
    'not carry meaning when spoken (numbered-list markers, table-cell',
    'coordinates, repeated headings, raw URLs) plus the brief bridging',
    'phrases needed so adjacent ideas flow by ear.',
    '',
    'Hard rules:',
    '- Do NOT add a podcast-style welcome, sign-off, recap, host banter,',
    '  music cues, or chapter teasers. The first words should be the first',
    '  idea of the document — at most a one-sentence framing of what the',
    '  document is.',
    '- Do NOT invent facts, examples, opinions, or content that is not in',
    '  the source document.',
    '- Do NOT skip ideas. If a paragraph is in the source, its substance',
    '  must be reflected in the script.',
    '- You MAY restructure for spoken flow: combine adjacent short',
    '  paragraphs that say one thing, split one long sentence into two,',
    '  re-order clauses inside a paragraph for clarity, and replace visual',
    '  list markers with spoken signposts ("There are three things to',
    '  call out here. First, ... Second, ... Third, ...").',
    '- You MAY add brief bridging phrases ("To put it another way,",',
    '  "In other words,", "The next section asks,") when they help the',
    '  listener track the document\'s structure. Keep them short and',
    '  use them sparingly.',
    '- Preserve the document\'s structure: each source heading becomes',
    '  one "body" segment with that heading. No "intro" / "outro" /',
    '  "chapter" segments.',
    '- Read names, numbers, code identifiers, and technical terms',
    '  accurately. See the preservation rules below for how to keep',
    '  English terms intact across languages.',
    '- If the target language differs from the source, render the script',
    '  natively in the target language, not as a literal word-for-word',
    '  translation.',
    '',
    preservationRules(),
    '',
    'Narrating non-prose elements:',
    '- Tables: state in one short phrase what the table is showing, then',
    '  walk through the rows in plain language. Do NOT say "row one,',
    '  column one". Keep names and numbers faithful.',
    '- Lists / bullets: introduce the list with a count when useful',
    '  ("There are four operating principles to know about,") and then',
    '  read each item as its own utterance. Do not say "bullet one".',
    '- Images, diagrams, screenshots: briefly say the document includes',
    '  an image, then read its caption or alt text if available. Do not',
    '  invent details about pixels you cannot see.',
    '- Code blocks and command snippets: say the document includes a',
    '  code example, then read the snippet at a calm pace if it is short,',
    '  or summarize its intent in one sentence if it is long.',
    '- Links and footnotes: read the visible link text. Do not read raw',
    '  URLs unless the URL itself is the point.',
    '',
    'Segment shape:',
    '- Every segment\'s "kind" is "body". No intro/outro/chapter segments.',
    '- Each source section maps to one "body" segment. If the source has',
    '  no headings at all, emit a single "body" segment with heading: null.',
    '- "episodeTitle" must be the document\'s own title, translated to the',
    '  target language only if needed. Do not invent a catchy title.',
    '- "summary" must be a one- or two-sentence neutral abstract drawn from',
    '  the document\'s opening, translated if needed. No marketing tone.',
    '',
    'Return STRICT JSON only. No prose, no markdown. The JSON shape is:',
    '{',
    '  "episodeTitle": string,',
    '  "summary": string,',
    '  "segments": [',
    '    {',
    '      "kind": "body",',
    '      "heading": string | null,',
    '      "utterances": [ { "voice": "host", "text": string, "pauseAfterMs": number | null } ]',
    '    }',
    '  ]',
    '}',
  ].join('\n');
}

export function conversationalUserPrompt(
  doc: Document,
  opts: { targetLanguage: LanguageCode; glossary?: Glossary }
): string {
  const flattened = doc.sections
    .map((s) => (s.heading ? `## ${s.heading}\n\n${s.paragraphs.join('\n\n')}` : s.paragraphs.join('\n\n')))
    .join('\n\n');
  const glossarySection = renderGlossaryForPrompt(opts.glossary);

  return [
    `Target language: ${opts.targetLanguage}`,
    `Source title: ${doc.title}`,
    '',
    'Render the document below as a natural-sounding read-along. One',
    'segment per source section. Use "pauseAfterMs": 300 between',
    'utterances where a small breath helps. No podcast welcome, no',
    'sign-off, no host banter — but feel free to add brief spoken',
    'signposts and combine very short paragraphs so the result flows.',
    ...(glossarySection ? ['', glossarySection] : []),
    '',
    '---',
    flattened,
    '---',
  ].join('\n');
}

/**
 * Verbatim mode: read the document as-is. No invented podcast framing.
 *
 * The point of this mode is simple — let a listener consume a long document
 * by ear and get ~95% of what they'd get reading it. The model is allowed
 * (and expected) to make small fixes that improve spoken delivery (obvious
 * typos, broken punctuation, awkward sentence boundaries) but must not
 * paraphrase, summarize, expand, or add host-style commentary.
 *
 * This is NOT a screen reader. Tables, images, lists, and code blocks must
 * be narrated so a listener can follow what the document is saying — not
 * enumerated as "table cell one, table cell two".
 */
export function verbatimSystemPrompt(): string {
  return [
    'You are a faithful narrator preparing a written document for audio',
    'playback. Your job is to deliver the document essentially verbatim in',
    'the requested target language, NOT to turn it into a podcast and NOT',
    'to act like a screen reader.',
    '',
    'The listener should be able to follow the document by ear and, later,',
    'open the document and recognize exactly what you described. Aim for',
    'about 95% fidelity to the source content.',
    '',
    'Hard rules:',
    '- Do NOT add an introduction, welcome, sign-off, recap, host banter,',
    '  music cues, or any commentary that is not in the source document.',
    '- Do NOT paraphrase prose, summarize, shorten, expand, or reorder ideas.',
    '- Preserve the document\'s structure: each source heading becomes one',
    '  segment with that heading; each prose paragraph stays a distinct',
    '  utterance with its original wording.',
    '- Read names, numbers, code identifiers, and technical terms as written.',
    '- You MAY make minimal copy-edit fixes that only matter for spoken',
    '  delivery: obvious typos, broken punctuation, missing spaces, or',
    '  splitting a single very long sentence into two for breath. Nothing',
    '  more. When in doubt, keep the original wording.',
    '- If the target language differs from the source, translate as closely',
    '  to the source meaning as possible. Prefer faithfulness over fluency.',
    '  See the preservation rules below for how to keep English terms intact.',
    '',
    preservationRules(),
    '',
    'Narrating non-prose elements (this is where you stop being a screen',
    'reader and start being a calm narrator):',
    '- Tables: describe the table\'s purpose in one short phrase, then walk',
    '  through the rows naturally. Do NOT say "row one, column one". Say',
    '  things like: "The document lays out the following options. The first',
    '  option, <name>, is described as <value>. The second, <name>, is',
    '  <value>." Keep the row content faithful — same names, same numbers.',
    '- Lists / bullets: read each item as its own utterance. Do not say',
    '  "bullet one, bullet two". A simple "First, ... Second, ... Finally,',
    '  ..." or just reading the items in order is fine.',
    '- Images, diagrams, screenshots: briefly state that the document shows',
    '  an image and read its caption or alt text if available. Do not try',
    '  to invent details about pixels you cannot see.',
    '- Code blocks and command snippets: say that the document includes a',
    '  code example, then read the snippet at a calm pace if it is short,',
    '  or summarize its intent in one sentence if it is long. Do not',
    '  pronounce every bracket and semicolon literally unless the snippet',
    '  is itself the subject of the paragraph.',
    '- Links and footnotes: read the visible link text. Do not read raw',
    '  URLs unless the URL itself is the point.',
    '',
    'Segment shape:',
    '- The first segment\'s "kind" is "body" (no intro segment).',
    '- Each source section maps to one "body" segment. If the source has no',
    '  headings at all, emit a single "body" segment with heading: null.',
    '- "episodeTitle" must be the document\'s own title, translated to the',
    '  target language only if needed. Do not invent a catchy title.',
    '- "summary" must be a one- or two-sentence neutral abstract drawn from',
    '  the document\'s opening, translated if needed. No marketing tone.',
    '',
    'Return STRICT JSON only. No prose, no markdown. The JSON shape is:',
    '{',
    '  "episodeTitle": string,',
    '  "summary": string,',
    '  "segments": [',
    '    {',
    '      "kind": "body",',
    '      "heading": string | null,',
    '      "utterances": [ { "voice": "host", "text": string, "pauseAfterMs": number | null } ]',
    '    }',
    '  ]',
    '}',
  ].join('\n');
}

export function verbatimUserPrompt(
  doc: Document,
  opts: { targetLanguage: LanguageCode; glossary?: Glossary }
): string {
  const flattened = doc.sections
    .map((s) => (s.heading ? `## ${s.heading}\n\n${s.paragraphs.join('\n\n')}` : s.paragraphs.join('\n\n')))
    .join('\n\n');
  const glossarySection = renderGlossaryForPrompt(opts.glossary);

  return [
    `Target language: ${opts.targetLanguage}`,
    `Source title: ${doc.title}`,
    '',
    'Read the document below as-is. One segment per source section. One',
    'utterance per source paragraph. Use "pauseAfterMs": 300 between',
    'paragraphs so the listener gets a small breath. Do not add anything',
    'that is not in the source.',
    ...(glossarySection ? ['', glossarySection] : []),
    '',
    '---',
    flattened,
    '---',
  ].join('\n');
}

/**
 * Verbatim translation: stay as close as possible to the source script.
 * Preserve segment count, headings, and per-utterance boundaries 1:1.
 */
export function verbatimTranslateSystemPrompt(): string {
  return [
    'You translate an existing read-aloud script into another language as',
    'faithfully as possible. This is NOT a localization or a rewrite — the',
    'listener should hear essentially the same content as the source, just',
    'in the target language.',
    '',
    'Hard rules:',
    '- Preserve the segment array length and order exactly.',
    '- Preserve each segment\'s "kind", "heading" position, and the number',
    '  of utterances. Translate the heading text if present.',
    '- Translate each utterance one-to-one. Do not merge or split utterances.',
    '- Preserve every "pauseAfterMs" value exactly.',
    '- Preserve every "voice" field exactly. Speaker dispatch must not change.',
    '- Do not add an intro, outro, recap, or any commentary.',
    '- Do not paraphrase or summarize. Prefer faithfulness over fluency.',
    '- Keep numeric values in their original form. Translate only',
    '  natural-language prose. See the preservation rules below for how to',
    '  keep English proper nouns, code identifiers, and acronyms intact.',
    '',
    preservationRules(),
    '',
    'Return STRICT JSON only. No prose, no markdown. The top-level JSON shape is:',
    '{',
    '  "episodeTitle": string,',
    '  "summary": string,',
    '  "segments": [ ...same structure and length as the input segments... ]',
    '}',
  ].join('\n');
}

/**
 * Dialogue mode: two (or more) named speakers discuss the source material
 * in a natural back-and-forth — NotebookLM-style. Each utterance carries
 * the speaker's id in its "voice" field so the TTS stage can dispatch to
 * the right neural voice.
 *
 * The conversation should teach the listener the document's content
 * without it sounding like one host reading bullet points to another.
 * Speakers ask each other questions, push back, give examples, recap.
 * Fidelity target sits between conversational and podcast — closer to a
 * podcast in feel (because of the back-and-forth framing) but closer to
 * conversational in faithfulness (no fabricated examples, no opinions
 * that aren't in the source).
 */
export function dialogueSystemPrompt(speakers: DialogueSpeaker[]): string {
  const speakerList = speakers
    .map((s) => {
      const name = s.name ?? s.id;
      const persona = s.persona ? ` — ${s.persona}` : '';
      return `  - id: "${s.id}", name: "${name}"${persona}`;
    })
    .join('\n');
  const speakerIds = speakers.map((s) => `"${s.id}"`).join(', ');

  return [
    'You are a podcast producer scripting a natural-sounding conversation',
    'between named speakers about the source document below. The result',
    'should let a listener understand the document\'s ideas by ear, as if',
    'overhearing two thoughtful people who have already read it.',
    '',
    'Cast:',
    speakerList,
    '',
    'Hard rules:',
    `- Every utterance MUST set "voice" to exactly one of the cast ids: ${speakerIds}.`,
    '  No other values are allowed.',
    '- Alternate speakers across utterances. Long monologues from one',
    '  speaker break the conversational feel — split them.',
    '- Do NOT invent facts, examples, statistics, or opinions that are not',
    '  in the source. The speakers may rephrase and discuss the source\'s',
    '  ideas; they may not add new ones.',
    '- Do NOT add music cues, sound effects, or speaker name prefixes',
    '  inside utterance text (e.g. don\'t write "Ava: Today we\'ll talk...");',
    '  the "voice" field carries that information.',
    '- Keep each utterance under ~60 words so TTS pacing stays natural.',
    '- Insert "pauseAfterMs": 300 between major thoughts where a breath',
    '  would help.',
    '- Preserve the document\'s structure: each source heading becomes one',
    '  "body" segment with that heading. No "intro"/"outro"/"chapter" segments.',
    '- Read names, numbers, code identifiers, and technical terms accurately.',
    '  See the preservation rules below for how to keep English terms intact',
    '  across languages.',
    '- If the target language differs from the source, write the conversation',
    '  natively in the target language, not as a literal translation.',
    '',
    preservationRules(),
    '',
    'Conversation shape per segment:',
    '- Open the segment with one speaker briefly framing what this section is',
    '  about, then have the other speaker respond, ask, or build on it.',
    '- Use real conversational moves: clarifying questions, gentle pushback,',
    '  short examples that ARE in the source, brief recaps.',
    '- Close each segment when the section\'s ideas have been covered. Do not',
    '  add a podcast-style sign-off — that lives in a final segment if at all.',
    '',
    'Return STRICT JSON only. No prose, no markdown. The JSON shape is:',
    '{',
    '  "episodeTitle": string,',
    '  "summary": string,',
    '  "segments": [',
    '    {',
    '      "kind": "body",',
    '      "heading": string | null,',
    `      "utterances": [ { "voice": ${speakerIds.split(', ')[0] ?? '"host"'} | ${speakerIds.split(', ')[1] ?? '"guest"'} | ..., "text": string, "pauseAfterMs": number | null } ]`,
    '    }',
    '  ]',
    '}',
  ].join('\n');
}

export function dialogueUserPrompt(
  doc: Document,
  opts: { targetLanguage: LanguageCode; speakers: DialogueSpeaker[]; glossary?: Glossary }
): string {
  const flattened = doc.sections
    .map((s) => (s.heading ? `## ${s.heading}\n\n${s.paragraphs.join('\n\n')}` : s.paragraphs.join('\n\n')))
    .join('\n\n');
  const namesLine = opts.speakers.map((s) => s.name ?? s.id).join(' and ');
  const glossarySection = renderGlossaryForPrompt(opts.glossary);

  return [
    `Target language: ${opts.targetLanguage}`,
    `Source title: ${doc.title}`,
    `Speakers: ${namesLine}`,
    '',
    `Script a natural ${opts.speakers.length}-voice conversation between`,
    `${namesLine} that teaches the document below by ear. One segment per`,
    'source section. Alternate speakers across utterances. No invented facts',
    'or examples — discuss only what is in the source.',
    ...(glossarySection ? ['', glossarySection] : []),
    '',
    '---',
    flattened,
    '---',
  ].join('\n');
}
