import { AzureOpenAI } from 'openai';
import { getBearerTokenProvider } from '@azure/identity';
import {
  COGNITIVE_SERVICES_SCOPE,
  resolveCredential,
  type LectoriaAuth,
} from '../azure-auth.js';
import { noopLogger, type Logger } from '../logger.js';
import type {
  Document,
  LanguageCode,
  PodcastScript,
  PodcastSegment,
  ProgressListener,
  ScriptModel,
  ScriptStyle,
} from '../types.js';
import {
  conversationalSystemPrompt,
  conversationalUserPrompt,
  dialogueSystemPrompt,
  dialogueUserPrompt,
  scriptSystemPrompt,
  scriptUserPrompt,
  translateSystemPrompt,
  verbatimSystemPrompt,
  verbatimTranslateSystemPrompt,
  verbatimUserPrompt,
} from './prompts.js';

export interface AzureOpenAIScriptModelOptions {
  endpoint: string;
  deployment: string;
  apiVersion: string;
  /**
   * Auth strategy. Defaults to `{ kind: 'default' }` which uses
   * DefaultAzureCredential — fine for the CLI but library consumers
   * should pass their own credential or API key explicitly.
   */
  auth?: LectoriaAuth;
  /**
   * Optional structured logger for progress + warnings. Defaults to no-op
   * so the library doesn't pollute the host's stdout/stderr.
   */
  logger?: Logger;
  /**
   * Optional structured progress callback. Receives one event per chunked
   * section / segment so consumers can drive a progress bar.
   */
  onProgress?: ProgressListener;
}

export class AzureOpenAIScriptModel implements ScriptModel {
  #client: AzureOpenAI;
  #deployment: string;
  #logger: Logger;
  #onProgress?: ProgressListener;

  constructor(opts: AzureOpenAIScriptModelOptions) {
    const auth = opts.auth ?? { kind: 'default' };
    this.#client = createOpenAIClient(opts, auth);
    this.#deployment = opts.deployment;
    this.#logger = opts.logger ?? noopLogger;
    this.#onProgress = opts.onProgress;
  }

  async generateScript(
    doc: Document,
    opts: { targetLanguage: LanguageCode; style: ScriptStyle; signal?: AbortSignal }
  ): Promise<PodcastScript> {
    // Podcast style produces a single host show (welcome / chapters / outro)
    // that doesn't decompose section-by-section, so it stays a single call.
    // Conversational and verbatim already promise "one segment per source
    // section" — chunking them keeps each request small enough to fit inside
    // the Azure deployment's TPM (tokens-per-minute) cap, which is what
    // causes 429 on long documents that no amount of waiting can fix.
    if (opts.style.kind === 'podcast' || doc.sections.length <= 1) {
      return this.#generateScriptInOneCall(doc, opts);
    }
    return this.#generateScriptBySection(doc, opts);
  }

  async translateScript(
    script: PodcastScript,
    targetLanguage: LanguageCode,
    opts: { signal?: AbortSignal } = {}
  ): Promise<PodcastScript> {
    if (script.language === targetLanguage) return script;
    // Same reasoning as generateScript: translate one segment per call so
    // long scripts don't blow past the deployment's TPM cap.
    if (script.segments.length <= 1) {
      return this.#translateScriptInOneCall(script, targetLanguage, opts);
    }
    return this.#translateScriptBySegment(script, targetLanguage, opts);
  }

  async #generateScriptInOneCall(
    doc: Document,
    opts: { targetLanguage: LanguageCode; style: ScriptStyle; signal?: AbortSignal }
  ): Promise<PodcastScript> {
    const { systemPrompt, userPrompt, temperature } = selectScriptPrompt(doc, opts);

    const response = await this.#client.chat.completions.create(
      {
        model: this.#deployment,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature,
      },
      { signal: opts.signal }
    );

    const raw = response.choices[0]?.message?.content;
    if (!raw) throw new Error('Azure OpenAI returned empty script content.');

    const parsed = parseScriptJson(raw);
    return {
      id: `${doc.id}-${opts.targetLanguage}`,
      language: opts.targetLanguage,
      episodeTitle: parsed.episodeTitle,
      summary: parsed.summary,
      segments: parsed.segments,
      style: opts.style,
    };
  }

  async #generateScriptBySection(
    doc: Document,
    opts: { targetLanguage: LanguageCode; style: ScriptStyle; signal?: AbortSignal }
  ): Promise<PodcastScript> {
    const total = doc.sections.length;
    this.#logger.info(
      `[script] generating ${total} sections (${opts.style.kind}, ${opts.targetLanguage}) in chunks to stay under TPM cap...`
    );

    let episodeTitle: string | undefined;
    let summary: string | undefined;
    const segments: PodcastSegment[] = [];

    for (let i = 0; i < total; i++) {
      opts.signal?.throwIfAborted();
      const section = doc.sections[i]!;
      const sectionDoc: Document = { ...doc, sections: [section] };
      const partial = await this.#generateScriptInOneCall(sectionDoc, opts);

      // The prompt promises "one segment per source section", but a section
      // with multiple paragraphs may legitimately come back as several
      // utterances inside a single segment, or rarely as multiple body
      // segments. Take whatever segments came back so nothing is dropped.
      for (const seg of partial.segments) segments.push(seg);

      if (i === 0) {
        // Use frontmatter from the first chunk, which sees the doc title and
        // can produce a faithful episodeTitle + summary.
        episodeTitle = partial.episodeTitle;
        summary = partial.summary;
      }

      this.#logger.info(`[script] section ${i + 1}/${total} ✓`);
      this.#onProgress?.({
        phase: 'script:section',
        documentId: doc.id,
        sectionIndex: i,
        sectionTotal: total,
        heading: section.heading,
      });
    }

    return {
      id: `${doc.id}-${opts.targetLanguage}`,
      language: opts.targetLanguage,
      episodeTitle: episodeTitle ?? doc.title,
      summary: summary ?? '',
      segments,
      style: opts.style,
    };
  }

  async #translateScriptInOneCall(
    script: PodcastScript,
    targetLanguage: LanguageCode,
    opts: { signal?: AbortSignal }
  ): Promise<PodcastScript> {
    const verbatim = script.style?.kind === 'verbatim';
    const systemPrompt = verbatim ? verbatimTranslateSystemPrompt() : translateSystemPrompt();

    const response = await this.#client.chat.completions.create(
      {
        model: this.#deployment,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          {
            role: 'user',
            content: JSON.stringify({
              targetLanguage,
              sourceLanguage: script.language,
              script: {
                episodeTitle: script.episodeTitle,
                summary: script.summary,
                segments: script.segments,
              },
            }),
          },
        ],
        temperature: verbatim ? 0.2 : 0.3,
      },
      { signal: opts.signal }
    );

    const raw = response.choices[0]?.message?.content;
    if (!raw) throw new Error('Azure OpenAI returned empty translation content.');

    const parsed = parseScriptJson(raw);
    return {
      id: `${script.id.replace(/-[^-]+$/, '')}-${targetLanguage}`,
      language: targetLanguage,
      episodeTitle: parsed.episodeTitle,
      summary: parsed.summary,
      segments: parsed.segments,
      style: script.style,
    };
  }

  async #translateScriptBySegment(
    script: PodcastScript,
    targetLanguage: LanguageCode,
    opts: { signal?: AbortSignal }
  ): Promise<PodcastScript> {
    const total = script.segments.length;
    this.#logger.info(
      `[translate ${targetLanguage}] translating ${total} segments in chunks to stay under TPM cap...`
    );

    const translatedSegments: PodcastSegment[] = [];
    let episodeTitle: string | undefined;
    let summary: string | undefined;

    for (let i = 0; i < total; i++) {
      opts.signal?.throwIfAborted();
      const segment = script.segments[i]!;
      const partial = await this.#translateScriptInOneCall(
        {
          ...script,
          episodeTitle: i === 0 ? script.episodeTitle : '',
          summary: i === 0 ? script.summary : '',
          segments: [segment],
        },
        targetLanguage,
        opts
      );
      if (i === 0) {
        episodeTitle = partial.episodeTitle;
        summary = partial.summary;
      }
      for (const seg of partial.segments) translatedSegments.push(seg);
      this.#logger.info(`[translate ${targetLanguage}] segment ${i + 1}/${total} ✓`);
      this.#onProgress?.({
        phase: 'translate:segment',
        scriptId: script.id,
        language: targetLanguage,
        segmentIndex: i,
        segmentTotal: total,
      });
    }

    return {
      id: `${script.id.replace(/-[^-]+$/, '')}-${targetLanguage}`,
      language: targetLanguage,
      episodeTitle: episodeTitle ?? script.episodeTitle,
      summary: summary ?? script.summary,
      segments: translatedSegments,
      style: script.style,
    };
  }
}

function createOpenAIClient(
  opts: AzureOpenAIScriptModelOptions,
  auth: LectoriaAuth
): AzureOpenAI {
  const base = {
    endpoint: opts.endpoint,
    apiVersion: opts.apiVersion,
    deployment: opts.deployment,
    maxRetries: 5,
  };
  if (auth.kind === 'apiKey') {
    return new AzureOpenAI({ ...base, apiKey: auth.apiKey });
  }
  const credential = resolveCredential(auth);
  const azureADTokenProvider = getBearerTokenProvider(credential, COGNITIVE_SERVICES_SCOPE);
  return new AzureOpenAI({ ...base, azureADTokenProvider });
}

interface ParsedScript {
  episodeTitle: string;
  summary: string;
  segments: PodcastSegment[];
}

interface PromptSelection {
  systemPrompt: string;
  userPrompt: string;
  temperature: number;
}

function selectScriptPrompt(
  doc: Document,
  opts: { targetLanguage: LanguageCode; style: ScriptStyle }
): PromptSelection {
  switch (opts.style.kind) {
    case 'verbatim':
      return {
        systemPrompt: verbatimSystemPrompt(),
        userPrompt: verbatimUserPrompt(doc, { targetLanguage: opts.targetLanguage }),
        temperature: 0.2,
      };
    case 'conversational':
      return {
        systemPrompt: conversationalSystemPrompt(),
        userPrompt: conversationalUserPrompt(doc, { targetLanguage: opts.targetLanguage }),
        temperature: 0.4,
      };
    case 'podcast':
      return {
        systemPrompt: scriptSystemPrompt(),
        userPrompt: scriptUserPrompt(doc, opts),
        temperature: 0.7,
      };
    case 'dialogue':
      return {
        systemPrompt: dialogueSystemPrompt(opts.style.speakers),
        userPrompt: dialogueUserPrompt(doc, {
          targetLanguage: opts.targetLanguage,
          speakers: opts.style.speakers,
        }),
        // Lower than podcast (0.7) because dialogue must stay grounded in
        // the source, higher than conversational (0.4) because the
        // back-and-forth needs some natural variation.
        temperature: 0.5,
      };
  }
}

function parseScriptJson(raw: string): ParsedScript {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Model did not return valid JSON: ${(err as Error).message}\n---\n${raw}`);
  }
  if (typeof json !== 'object' || json === null) {
    throw new Error('Model JSON output was not an object.');
  }
  const obj = json as Record<string, unknown>;

  // The model may nest the script under a "script" key (especially for translations
  // where the input shape wraps content in { script: { ... } }).
  const source =
    typeof obj.script === 'object' && obj.script !== null && 'segments' in obj.script
      ? (obj.script as Record<string, unknown>)
      : obj;

  const segments = Array.isArray(source.segments) ? (source.segments as PodcastSegment[]) : [];
  if (segments.length === 0) {
    throw new Error(`Model returned zero segments. Raw output:\n${raw.slice(0, 500)}`);
  }
  return {
    episodeTitle: String(source.episodeTitle ?? 'Untitled episode'),
    summary: String(source.summary ?? ''),
    segments,
  };
}
