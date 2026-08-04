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
  Glossary,
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
import { applyGlossaryToScript } from './glossary.js';
import { renderGlossaryForPrompt } from './glossary.js';
import { createScriptId } from '../identity.js';
import {
  ModelOutputValidationError,
  parseModelScript,
  type ParsedModelScript,
} from './schema.js';

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
  /** Per-request deadline in milliseconds. Defaults to 120 seconds. */
  timeoutMs?: number;
  /** SDK retries for transport and throttling failures. Defaults to 3. */
  maxRetries?: number;
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
    opts: { targetLanguage: LanguageCode; style: ScriptStyle; glossary?: Glossary; signal?: AbortSignal }
  ): Promise<PodcastScript> {
    // Podcast style produces a single host show (welcome / chapters / outro)
    // that doesn't decompose section-by-section, so it stays a single call.
    // Conversational and verbatim already promise "one segment per source
    // section" — chunking them keeps each request small enough to fit inside
    // the Azure deployment's TPM (tokens-per-minute) cap, which is what
    // causes 429 on long documents that no amount of waiting can fix.
    const raw =
      opts.style.kind === 'podcast' || doc.sections.length <= 1
        ? await this.#generateScriptInOneCall(doc, opts)
        : await this.#generateScriptBySection(doc, opts);
    // Safety net: wrap any glossary term the model missed. No-op for English
    // scripts and when no glossary is supplied.
    return applyGlossaryToScript(raw, opts.glossary);
  }

  async translateScript(
    script: PodcastScript,
    targetLanguage: LanguageCode,
    opts: { glossary?: Glossary; signal?: AbortSignal } = {}
  ): Promise<PodcastScript> {
    if (script.language === targetLanguage) return script;
    // Same reasoning as generateScript: translate one segment per call so
    // long scripts don't blow past the deployment's TPM cap.
    const raw =
      script.segments.length <= 1
        ? await this.#translateScriptInOneCall(script, targetLanguage, opts)
        : await this.#translateScriptBySegment(script, targetLanguage, opts);
    return applyGlossaryToScript(raw, opts.glossary);
  }

  async #generateScriptInOneCall(
    doc: Document,
    opts: { targetLanguage: LanguageCode; style: ScriptStyle; glossary?: Glossary; signal?: AbortSignal }
  ): Promise<PodcastScript> {
    const { systemPrompt, userPrompt, temperature } = selectScriptPrompt(doc, opts);

    const parsed = await this.#requestParsedScript({
      systemPrompt,
      userPrompt,
      temperature,
      signal: opts.signal,
      allowedSpeakers: speakersForStyle(opts.style),
    });
    return {
      id: createScriptId(doc.id, opts.targetLanguage),
      documentId: doc.id,
      language: opts.targetLanguage,
      episodeTitle: parsed.episodeTitle,
      summary: parsed.summary,
      segments: parsed.segments,
      style: opts.style,
    };
  }

  async #generateScriptBySection(
    doc: Document,
    opts: { targetLanguage: LanguageCode; style: ScriptStyle; glossary?: Glossary; signal?: AbortSignal }
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
      id: createScriptId(doc.id, opts.targetLanguage),
      documentId: doc.id,
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
    opts: { glossary?: Glossary; signal?: AbortSignal }
  ): Promise<PodcastScript> {
    const verbatim = script.style?.kind === 'verbatim';
    const systemPrompt = verbatim ? verbatimTranslateSystemPrompt() : translateSystemPrompt();
    const glossaryBlock = renderGlossaryForPrompt(opts.glossary);

    const payload = JSON.stringify({
      targetLanguage,
      sourceLanguage: script.language,
      script: {
        episodeTitle: script.episodeTitle,
        summary: script.summary,
        segments: script.segments,
      },
    });
    const userContent = glossaryBlock
      ? `${glossaryBlock}\n\nInput script JSON follows. Return the translated script as STRICT JSON.\n\n${payload}`
      : payload;

    const parsed = await this.#requestParsedScript({
      systemPrompt,
      userPrompt: userContent,
      temperature: verbatim ? 0.2 : 0.3,
      signal: opts.signal,
      allowedSpeakers: speakersInScript(script),
    });
    return {
      id: createScriptId(script.documentId, targetLanguage),
      documentId: script.documentId,
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
    opts: { glossary?: Glossary; signal?: AbortSignal }
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
      id: createScriptId(script.documentId, targetLanguage),
      documentId: script.documentId,
      language: targetLanguage,
      episodeTitle: episodeTitle ?? script.episodeTitle,
      summary: summary ?? script.summary,
      segments: translatedSegments,
      style: script.style,
    };
  }

  async #requestParsedScript(input: {
    systemPrompt: string;
    userPrompt: string;
    temperature: number;
    signal?: AbortSignal;
    allowedSpeakers: ReadonlySet<string>;
  }): Promise<ParsedModelScript> {
    const first = await this.#requestJson(input.systemPrompt, input.userPrompt, input.temperature, input.signal);
    try {
      return parseModelScript(first, input.allowedSpeakers);
    } catch (error) {
      if (!(error instanceof ModelOutputValidationError)) throw error;
      this.#logger.warn(
        `[model] invalid structured output; requesting one repair (${formatValidationIssues(error)})`
      );
      const repairPrompt = [
        'Correct the previous response so it matches the requested JSON schema.',
        'Return JSON only. Do not add fields or prose.',
        `Validation issues: ${formatValidationIssues(error)}`,
        'Previous response:',
        first,
      ].join('\n');
      const repaired = await this.#requestJson(
        input.systemPrompt,
        repairPrompt,
        Math.min(input.temperature, 0.2),
        input.signal
      );
      try {
        return parseModelScript(repaired, input.allowedSpeakers);
      } catch (repairError) {
        if (repairError instanceof ModelOutputValidationError) {
          throw new Error(
            `Azure OpenAI returned invalid script JSON after one repair attempt: ${formatValidationIssues(repairError)}`,
            { cause: repairError }
          );
        }
        throw repairError;
      }
    }
  }

  async #requestJson(
    systemPrompt: string,
    userPrompt: string,
    temperature: number,
    signal?: AbortSignal
  ): Promise<string> {
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
      { signal }
    );
    const raw = response.choices[0]?.message?.content;
    if (!raw) throw new Error('Azure OpenAI returned empty script content.');
    return raw;
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
    maxRetries: opts.maxRetries ?? 3,
    timeout: opts.timeoutMs ?? 120_000,
  };
  if (auth.kind === 'apiKey') {
    return new AzureOpenAI({ ...base, apiKey: auth.apiKey });
  }
  const credential = resolveCredential(auth);
  const azureADTokenProvider = getBearerTokenProvider(credential, COGNITIVE_SERVICES_SCOPE);
  return new AzureOpenAI({ ...base, azureADTokenProvider });
}

interface PromptSelection {
  systemPrompt: string;
  userPrompt: string;
  temperature: number;
}

function selectScriptPrompt(
  doc: Document,
  opts: { targetLanguage: LanguageCode; style: ScriptStyle; glossary?: Glossary }
): PromptSelection {
  const { targetLanguage, glossary } = opts;
  switch (opts.style.kind) {
    case 'verbatim':
      return {
        systemPrompt: verbatimSystemPrompt(),
        userPrompt: verbatimUserPrompt(doc, { targetLanguage, glossary }),
        temperature: 0.2,
      };
    case 'conversational':
      return {
        systemPrompt: conversationalSystemPrompt(),
        userPrompt: conversationalUserPrompt(doc, { targetLanguage, glossary }),
        temperature: 0.4,
      };
    case 'podcast':
      return {
        systemPrompt: scriptSystemPrompt(),
        userPrompt: scriptUserPrompt(doc, { targetLanguage, style: opts.style, glossary }),
        temperature: 0.7,
      };
    case 'dialogue':
      return {
        systemPrompt: dialogueSystemPrompt(opts.style.speakers),
        userPrompt: dialogueUserPrompt(doc, {
          targetLanguage,
          speakers: opts.style.speakers,
          glossary,
        }),
        // Lower than podcast (0.7) because dialogue must stay grounded in
        // the source, higher than conversational (0.4) because the
        // back-and-forth needs some natural variation.
        temperature: 0.5,
      };
  }
}

function speakersForStyle(style: ScriptStyle): ReadonlySet<string> {
  return new Set(style.kind === 'dialogue' ? style.speakers.map((speaker) => speaker.id) : ['host']);
}

function speakersInScript(script: PodcastScript): ReadonlySet<string> {
  const speakers = new Set<string>();
  for (const segment of script.segments) {
    for (const utterance of segment.utterances) speakers.add(utterance.voice ?? 'host');
  }
  return speakers.size > 0 ? speakers : new Set(['host']);
}

function formatValidationIssues(error: ModelOutputValidationError): string {
  return error.issues.length > 0 ? error.issues.join('; ') : error.message;
}
