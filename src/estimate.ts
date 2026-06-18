import { ingest } from './ingest/index.js';
import { parse } from './parse/index.js';
import type { Document, LanguageCode, ScriptStyle } from './types.js';

/**
 * Pricing table used by `estimateCost()`. All prices are USD per **one
 * million** units (tokens for OpenAI, characters for Azure Speech). The
 * defaults are Azure list prices snapshotted on the date below — treat
 * them as a rough guide, NOT a billing reference. Always verify against
 * https://azure.microsoft.com/pricing/ for production planning.
 */
export interface PricingTable {
  /** Azure OpenAI input tokens — `gpt-4o` global standard tier. */
  openAiInputPer1M: number;
  /** Azure OpenAI output tokens — `gpt-4o` global standard tier. */
  openAiOutputPer1M: number;
  /** Azure AI Speech Neural TTS — per character billed. */
  azureSpeechPer1M: number;
}

/**
 * Snapshot of Azure list prices used as fallbacks when no `pricing` override
 * is passed. Update the constant + the date in `pricingLastVerified` when
 * Azure changes prices. Consumers should always pass their own table if
 * they care about billing accuracy.
 */
export const DEFAULT_PRICING: PricingTable = {
  openAiInputPer1M: 2.5,
  openAiOutputPer1M: 10.0,
  azureSpeechPer1M: 16.0,
};

export const pricingLastVerified = '2026-06-18';

export interface EstimateInput {
  /** Source path (file or folder). Either this OR `document` is required. */
  source?: string;
  /** Pre-parsed document. Skips ingest+parse — useful for tests and pipelines. */
  document?: Document;
  /** Languages to generate audio for. Defaults to `[document.language]`. */
  languages?: LanguageCode[];
  /** Script style (affects output expansion). Defaults to conversational. */
  style?: ScriptStyle;
}

export interface EstimateOptions {
  /** Override any subset of the default pricing table. */
  pricing?: Partial<PricingTable>;
}

export interface LanguageEstimate {
  language: LanguageCode;
  /** Whether this language reuses the source script (no translate call needed). */
  reusesSourceScript: boolean;
  scriptInputTokens: number;
  scriptOutputTokens: number;
  ttsCharacters: number;
  /** Rough audio length at ~150 words per minute (~900 chars/min). */
  audioMinutes: number;
  usd: { script: number; tts: number; total: number };
}

export interface EstimateResult {
  documentId: string;
  documentTitle: string;
  /** Total source text chars across all sections (post-parse). */
  sourceCharacters: number;
  /** Number of source sections (= number of script chunks for non-podcast styles). */
  sections: number;
  style: ScriptStyle['kind'];
  pricing: PricingTable;
  pricingLastVerified: string;
  languages: LanguageEstimate[];
  total: {
    scriptInputTokens: number;
    scriptOutputTokens: number;
    ttsCharacters: number;
    audioMinutes: number;
    usd: { script: number; tts: number; total: number };
  };
  /**
   * Honest list of assumptions baked into the estimate so callers don't
   * mistake it for a quote. Surface these next to the dollar figure.
   */
  assumptions: string[];
}

/**
 * Estimates the API spend of running `runPipeline` for a given document,
 * style, and language set — without actually calling Azure. Useful for:
 *   - showing a cost preview in a UI before kicking off a run
 *   - capping batch jobs that would exceed a budget
 *   - sanity-checking a long document before paying for it
 *
 * The numbers are rough heuristics, not guarantees. The `assumptions`
 * field on the result spells out every estimate so you can show it
 * verbatim next to the dollar figure.
 *
 * @example
 * ```ts
 * import { estimateCost } from 'lectoria';
 *
 * const est = await estimateCost({
 *   source: './lesson.md',
 *   languages: ['en', 'es'],
 *   style: { kind: 'conversational' },
 * });
 * console.log(`Estimated cost: $${est.total.usd.total.toFixed(2)}`);
 * ```
 */
export async function estimateCost(
  input: EstimateInput,
  opts: EstimateOptions = {}
): Promise<EstimateResult> {
  const document = input.document ?? (await parseOnly(input.source));
  const style: ScriptStyle = input.style ?? { kind: 'conversational' };
  const languages =
    input.languages && input.languages.length > 0
      ? input.languages
      : [document.language as LanguageCode];

  const pricing: PricingTable = { ...DEFAULT_PRICING, ...opts.pricing };

  const sourceCharacters = documentCharacterCount(document);
  const sourceTokens = approxTokens(sourceCharacters);
  const sections = Math.max(1, document.sections.length);

  // Non-podcast styles chunk one call per section (matches azure-openai.ts).
  // Podcast collapses to one call regardless of section count.
  const numScriptChunks = style.kind === 'podcast' ? 1 : sections;

  // The system + user prompt scaffolding adds a per-call overhead.
  // 400 tokens is a rough average across the four prompt families.
  const SYSTEM_PROMPT_TOKENS_PER_CALL = 400;
  const expansion = outputExpansion(style.kind);

  const languageEstimates: LanguageEstimate[] = languages.map((language) => {
    const reusesSourceScript = language === document.language;

    // The first language goes through generateScript; the others go through
    // translateScript with the already-generated source script.
    let scriptInputTokens: number;
    let scriptOutputTokens: number;

    if (reusesSourceScript) {
      scriptInputTokens = sourceTokens + numScriptChunks * SYSTEM_PROMPT_TOKENS_PER_CALL;
      scriptOutputTokens = Math.round(sourceTokens * expansion);
    } else {
      // Translation reads the source script (≈ output of generation) AND
      // writes a similar-sized translation. Chunked per segment, same
      // section count for non-podcast.
      const sourceScriptTokens = Math.round(sourceTokens * expansion);
      scriptInputTokens = sourceScriptTokens + numScriptChunks * SYSTEM_PROMPT_TOKENS_PER_CALL;
      scriptOutputTokens = sourceScriptTokens; // translation preserves length
    }

    // TTS bills per character. Output tokens × 4 chars/token is the standard
    // OpenAI heuristic. SSML wrapping adds a few percent, ignored here.
    const ttsCharacters = scriptOutputTokens * 4;
    const audioMinutes = ttsCharacters / 900;

    const scriptUsd =
      (scriptInputTokens / 1_000_000) * pricing.openAiInputPer1M +
      (scriptOutputTokens / 1_000_000) * pricing.openAiOutputPer1M;
    const ttsUsd = (ttsCharacters / 1_000_000) * pricing.azureSpeechPer1M;

    return {
      language,
      reusesSourceScript,
      scriptInputTokens,
      scriptOutputTokens,
      ttsCharacters,
      audioMinutes,
      usd: {
        script: round2(scriptUsd),
        tts: round2(ttsUsd),
        total: round2(scriptUsd + ttsUsd),
      },
    };
  });

  const total = languageEstimates.reduce(
    (acc, l) => ({
      scriptInputTokens: acc.scriptInputTokens + l.scriptInputTokens,
      scriptOutputTokens: acc.scriptOutputTokens + l.scriptOutputTokens,
      ttsCharacters: acc.ttsCharacters + l.ttsCharacters,
      audioMinutes: acc.audioMinutes + l.audioMinutes,
      usd: {
        script: round2(acc.usd.script + l.usd.script),
        tts: round2(acc.usd.tts + l.usd.tts),
        total: round2(acc.usd.total + l.usd.total),
      },
    }),
    {
      scriptInputTokens: 0,
      scriptOutputTokens: 0,
      ttsCharacters: 0,
      audioMinutes: 0,
      usd: { script: 0, tts: 0, total: 0 },
    }
  );

  return {
    documentId: document.id,
    documentTitle: document.title,
    sourceCharacters,
    sections,
    style: style.kind,
    pricing,
    pricingLastVerified,
    languages: languageEstimates,
    total,
    assumptions: [
      'Token count derived from chars/4 — accurate to within ~10% for English/Spanish prose, less for code-heavy docs.',
      `Output expansion factor: ${expansion}× input (style: ${style.kind}). Verbatim is closest to 1.0×; podcast adds intro/outro/chapter scaffolding.`,
      `Script chunking: ${numScriptChunks} call(s) — ${style.kind === 'podcast' ? 'podcast style uses one call' : 'one call per source section'}, each paying ~${SYSTEM_PROMPT_TOKENS_PER_CALL} tokens of prompt overhead.`,
      'Translation input ≈ output of source-language script; translation output ≈ same length as source script.',
      'TTS bills per character: output tokens × 4 chars/token. SSML overhead (~3%) ignored.',
      'Audio length assumes ~150 spoken words per minute (~900 chars/min). Voice and language can shift this by 10–20%.',
      `Pricing: Azure list prices snapshotted on ${pricingLastVerified}. Pass \`opts.pricing\` to override.`,
    ],
  };
}

async function parseOnly(source: string | undefined): Promise<Document> {
  if (!source) {
    throw new Error('estimateCost: pass either `source` (path) or `document` (pre-parsed).');
  }
  const files = await ingest(source);
  if (files.length === 0) {
    throw new Error(`estimateCost: no source files found at "${source}".`);
  }
  if (files.length > 1) {
    throw new Error(
      `estimateCost: "${source}" resolved to ${files.length} files. Call estimateCost once per document, or pass \`document\` directly.`
    );
  }
  return parse(files[0]!);
}

function documentCharacterCount(doc: Document): number {
  let chars = doc.title.length;
  for (const section of doc.sections) {
    if (section.heading) chars += section.heading.length;
    for (const p of section.paragraphs) chars += p.length;
  }
  return chars;
}

function approxTokens(characters: number): number {
  // OpenAI's rule of thumb: 1 token ≈ 4 chars for English. Spanish runs a
  // bit longer (~3.5) but we keep the same factor — the assumptions list
  // calls this out so consumers know the bound.
  return Math.ceil(characters / 4);
}

function outputExpansion(style: ScriptStyle['kind']): number {
  switch (style) {
    case 'verbatim':
      return 1.0;
    case 'conversational':
      return 1.1;
    case 'dialogue':
      return 1.3;
    case 'podcast':
      return 1.5;
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
