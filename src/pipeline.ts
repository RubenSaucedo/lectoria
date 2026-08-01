import { copyFile, mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { basename, extname, join, relative, resolve } from 'node:path';
import type { Config } from './config.js';
import type {
  Distributor,
  Document,
  DocumentParser,
  Episode,
  Glossary,
  IngestSource,
  LanguageCode,
  Packager,
  PodcastScript,
  ProgressListener,
  ScriptModel,
  ScriptStyle,
  SynthesizedAudio,
  TtsProvider,
} from './types.js';
import { ingest } from './ingest/index.js';
import { parse } from './parse/index.js';
import { AzureOpenAIScriptModel } from './script/index.js';
import { translateToAll } from './translate/index.js';
import { AzureSpeechTts } from './synthesize/index.js';
import { Id3Packager } from './package/index.js';
import { RssDistributor } from './distribute/index.js';
import { noopLogger, type Logger } from './logger.js';
import { createBufferHash, createFingerprint } from './identity.js';
import { PipelineCheckpointStore } from './checkpoint.js';
import { temporarySiblingPath, withFileLock } from './fs-safe.js';
import {
  normalizeLanguageCodes,
  requiredSpeakers,
  validateScriptVoiceCoverage,
  validateVoiceCoverage,
} from './validation.js';
import {
  estimateCost,
  type EstimateResult,
  type LanguageEstimate,
  type PricingTable,
} from './estimate.js';
import {
  createCostAssessment,
  enforceCostPolicy,
  formatCostAssessment,
  resolveCostPolicy,
  type CostAssessment,
  type CostPolicy,
} from './cost-policy.js';

export interface RunOptions {
  source: string;
  style?: ScriptStyle;
  targetLanguages?: LanguageCode[];
  /** Structured logger for human-readable progress + warnings. Defaults to no-op. */
  logger?: Logger;
  /** Cancellation signal forwarded to every long-running stage. */
  signal?: AbortSignal;
  /**
   * Structured progress callback. Receives one event per pipeline milestone
   * (parse, script:section, translate:segment, tts:segment, episode:complete).
   * Use this to drive a progress bar or telemetry pipeline without parsing
   * log strings.
   */
  onProgress?: ProgressListener;
  /**
   * Walk subdirectories when the source is a folder. Default `true`.
   * Set to `false` to scan only the top level.
   */
  recursive?: boolean;
  /**
   * Emit per-folder podcast feeds (feed.xml + episodes.json) alongside the
   * audio files. By default this is enabled only when `feed.audioBaseUrl`
   * is configured. Set explicitly to `false` for audio-only runs.
   */
  distribute?: boolean;
  /**
   * Project-specific terms (brand names, acronyms, code identifiers) that
   * should keep their original-language pronunciation across translations.
   * Threaded into the script and translate stages so the model wraps them
   * in `[[en]]…[[/en]]` markers, with a deterministic post-pass wrapping
   * any occurrences the model misses. The synthesis stage rewrites the
   * markers into SSML `<lang xml:lang="en-US">` so Azure Neural TTS reads
   * them with English phonetics inside non-English narrations.
   *
   * Overrides any glossary set on `Config.glossary`.
   */
  glossary?: Glossary;
  /** Explicit source language passed to every parser. */
  sourceLanguage?: LanguageCode;
  /** Reuse content-addressed script/audio/episode checkpoints. Default true. */
  resume?: boolean;
  /** Override the default `<outDir>/.lectoria-cache` checkpoint directory. */
  checkpointDir?: string;
  /**
   * Version key for custom script/TTS/packager adapters. Checkpoint reuse is
   * disabled for those overrides unless this key is supplied.
   */
  checkpointKey?: string;
  /** Continue processing other source files after an item fails. Default false. */
  continueOnError?: boolean;
  /** Receives structured per-source failures when continueOnError is enabled. */
  onItemError?: (error: PipelineItemError) => void;
  /**
   * Local preflight estimation before Azure calls. Defaults to warning mode
   * for the built-in Azure adapters. Pass false to disable.
   */
  costPolicy?: CostPolicy | false;
  /** Receives every enabled cost assessment, including below-threshold runs. */
  onCostAssessment?: (assessment: CostAssessment) => void;
}

/**
 * Per-stage adapter overrides. Pass any subset to replace the default
 * Azure-backed implementations with your own (e.g. OpenAI direct, ElevenLabs,
 * in-memory distributor for tests). Anything you don't pass falls back to
 * the default that consumes `config`.
 *
 * Note: when `distributor` is overridden, the orchestrator funnels every
 * episode through that single instance instead of building per-folder
 * RssDistributor instances. That keeps test fakes simple and lets advanced
 * callers implement their own multi-feed routing.
 */
export interface RunOverrides {
  ingestSource?: IngestSource;
  parsers?: readonly DocumentParser[];
  scriptModel?: ScriptModel;
  tts?: TtsProvider;
  packager?: Packager;
  distributor?: Distributor;
}

export class PipelineItemError extends Error {
  readonly sourceUri: string;
  readonly stage: string;

  constructor(sourceUri: string, stage: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Pipeline failed during ${stage} for "${sourceUri}": ${detail}`, { cause });
    this.name = 'PipelineItemError';
    this.sourceUri = sourceUri;
    this.stage = stage;
  }

}

interface PreparedDocument {
  sourceUri: string;
  doc: Document;
  checkpoint?: PipelineCheckpointStore;
  scripts: Map<LanguageCode, PodcastScript>;
  audio: Map<LanguageCode, SynthesizedAudio>;
  priorEpisodes: Map<LanguageCode, Episode>;
  completedEpisodes: Map<LanguageCode, Episode>;
}

/**
 * Runs the full pipeline on a single source URI.
 *
 * The orchestrator composes pure stage functions and fans out per target
 * language at the script stage. For folder ingests it walks recursively
 * (unless `recursive: false`), mirrors the input directory structure into
 * `outDir`, and — if `distribute` is true — emits one RSS feed per source
 * directory, treating each folder as its own podcast.
 *
 * Paid stages are checkpointed by default. Errors remain fail-fast unless
 * `continueOnError` is enabled for source-local batch recovery.
 */
export async function runPipeline(
  config: Config,
  opts: RunOptions,
  overrides: RunOverrides = {}
): Promise<Episode[]> {
  const targetLanguages = normalizeLanguageCodes(
    opts.targetLanguages ?? config.targetLanguages,
    'target languages'
  );
  const sourceLanguage = opts.sourceLanguage
    ? normalizeLanguageCodes([opts.sourceLanguage], 'source language')[0]
    : undefined;
  const style: ScriptStyle = opts.style ?? { kind: 'conversational' };
  const logger = opts.logger ?? noopLogger;
  const onProgress = opts.onProgress;
  const signal = opts.signal;
  const recursive = opts.recursive ?? true;
  const distributeEnabled =
    opts.distribute ?? Boolean(overrides.distributor || config.feed.audioBaseUrl);
  const glossary = opts.glossary ?? config.glossary;
  const speakers = requiredSpeakers(style);
  validateVoiceCoverage(config.voices, targetLanguages, speakers);
  const outDir = resolve(config.outDir);
  await mkdir(outDir, { recursive: true });

  const scriptModel: ScriptModel =
    overrides.scriptModel ??
    new AzureOpenAIScriptModel({ ...config.azure.openai, logger, onProgress });
  const tts: TtsProvider =
    overrides.tts ??
    new AzureSpeechTts({
      region: config.azure.speech.region,
      resourceId: config.azure.speech.resourceId,
      onProgress,
    });
  const packager: Packager = overrides.packager ?? new Id3Packager();

  if (
    distributeEnabled &&
    !overrides.distributor &&
    !config.feed.audioBaseUrl
  ) {
    throw new Error(
      'RSS distribution requires config.feed.audioBaseUrl (LECTORIA_AUDIO_BASE_URL) to be an explicit public URL. Use distribute: false or --no-distribute for local audio only.'
    );
  }

  const inputRootName = await deriveInputRootName(opts.source);
  const sources = overrides.ingestSource
    ? await overrides.ingestSource.fetch(opts.source)
    : await ingest(opts.source, { recursive });
  if (sources.length === 0) throw new Error(`No supported source files found at "${opts.source}".`);
  const parsedDocuments: Array<{ sourceUri: string; doc: Document }> = [];
  for (const source of sources) {
    try {
      signal?.throwIfAborted();
      onProgress?.({ phase: 'parse:start', source: source.uri });
      const doc = await parse(source, {
        parsers: overrides.parsers,
        sourceLanguage,
      });
      parsedDocuments.push({ sourceUri: source.uri, doc });
      onProgress?.({
        phase: 'parse:complete',
        documentId: doc.id,
        sections: doc.sections.length,
      });
    } catch (error) {
      handleItemError(new PipelineItemError(source.uri, 'parse', error), opts, logger);
    }
  }
  const outputPlans = planOutputs(parsedDocuments.map((item) => item.doc), outDir, inputRootName, targetLanguages);
  const preparedDocuments: PreparedDocument[] = [];
  for (const item of parsedDocuments) {
    const checkpoint = resolveCheckpointStore(
      config,
      opts,
      overrides,
      item.doc,
      style,
      targetLanguages,
      outDir
    );
    await checkpoint?.ensure();
    const prepared: PreparedDocument = {
      ...item,
      checkpoint,
      scripts: new Map(),
      audio: new Map(),
      priorEpisodes: new Map(),
      completedEpisodes: new Map(),
    };
    await hydratePreparedCheckpoint(prepared, targetLanguages, outputPlans);
    preparedDocuments.push(prepared);
  }
  const customCostAdapters = Boolean(overrides.scriptModel || overrides.tts);
  const costPolicyInput =
    opts.costPolicy === undefined && customCostAdapters ? false : opts.costPolicy;
  const costPolicy = resolveCostPolicy(costPolicyInput);
  if (costPolicy.mode !== 'off') {
    validateCustomAdapterPricing(overrides, costPolicy.pricing);
    const estimates = (
      await Promise.all(
        preparedDocuments.map(async (prepared) => {
          const fullEstimate = await estimateCost(
            { document: prepared.doc, languages: targetLanguages, style },
            { pricing: costPolicy.pricing }
          );
          return estimateRemainingWork(fullEstimate, prepared);
        })
      )
    ).filter((estimate): estimate is EstimateResult => estimate !== undefined);
    const assessment = createCostAssessment(estimates, costPolicy);
    opts.onCostAssessment?.(assessment);
    onProgress?.({
      phase: 'cost:assessment',
      documents: assessment.totals.documents,
      sourceCharacters: assessment.totals.sourceCharacters,
      estimatedAudioMinutes: assessment.totals.audioMinutes,
      estimatedUsd: assessment.totals.usd.total,
      warnings: assessment.warnings,
    });
    if (assessment.warnings.length > 0) {
      logger.warn(
        `[cost] ${formatCostAssessment(assessment)}. ${assessment.warnings.join('; ')}. Pricing snapshot: ${assessment.pricingLastVerified}.`
      );
    }
    await enforceCostPolicy(assessment, costPolicy);
  }

  // Cache one Distributor per feed directory. When `overrides.distributor`
  // is set, the cache resolves every key to that single instance — preserving
  // legacy single-feed behavior for callers that opt out of per-folder feeds.
  const distributors = new Map<string, Distributor>();
  const episodes: Episode[] = [];

  for (const prepared of preparedDocuments) {
    const { sourceUri, doc, checkpoint } = prepared;
    const processDocument = async (): Promise<void> => {
    // A second run may have populated this cache while waiting for its lock.
    await hydratePreparedCheckpoint(prepared, targetLanguages, outputPlans);
    signal?.throwIfAborted();
    const primaryLanguage = targetLanguages[0]!;
    if (prepared.completedEpisodes.size === targetLanguages.length) {
      for (const language of targetLanguages) {
        const episode = prepared.completedEpisodes.get(language)!;
        const episodeDir = resolveEpisodeDir(outDir, inputRootName, doc.sourcePath);
        if (distributeEnabled) {
          const distributor = resolveDistributor(
            distributors,
            episodeDir,
            outDir,
            config,
            overrides.distributor
          );
          await distributor.publish(episode);
        }
        episodes.push(episode);
        onProgress?.({
          phase: 'episode:complete',
          episodeId: episode.id,
          language: episode.language,
          audioPath: episode.audioPath,
          durationSec: episode.durationSec,
        });
      }
      return;
    }
    const chunked = style.kind !== 'podcast' && doc.sections.length > 1;
    onProgress?.({
      phase: 'script:start',
      documentId: doc.id,
      language: primaryLanguage,
      style: style.kind,
      sections: doc.sections.length,
      chunked,
    });
    let baseScript = prepared.scripts.get(primaryLanguage);
    if (!baseScript) {
      baseScript = await scriptModel.generateScript(doc, {
        targetLanguage: primaryLanguage,
        style,
        glossary,
        signal,
      });
      await checkpoint?.saveScript(baseScript);
      prepared.scripts.set(primaryLanguage, baseScript);
    }
    validateScriptVoiceCoverage(baseScript, config.voices);
    onProgress?.({
      phase: 'script:complete',
      scriptId: baseScript.id,
      segments: baseScript.segments.length,
    });

    const localizedScripts = await translateToAll(scriptModel, baseScript, targetLanguages, {
      signal,
      onProgress,
      glossary,
      ...(checkpoint
        ? {
            loadCached: async (language: LanguageCode) => prepared.scripts.get(language),
            saveCached: async (script: PodcastScript) => {
              prepared.scripts.set(script.language, script);
              await checkpoint.saveScript(script);
            },
          }
        : {}),
    });

    const episodeDir = resolveEpisodeDir(outDir, inputRootName, doc.sourcePath);
    await mkdir(episodeDir, { recursive: true });

    for (const script of localizedScripts) {
      signal?.throwIfAborted();
      validateScriptVoiceCoverage(script, config.voices);
      const audioPath = outputPlans.get(outputPlanKey(doc.id, script.language));
      if (!audioPath) throw new Error(`Missing output plan for ${doc.id} (${script.language}).`);
      const priorEpisode = prepared.priorEpisodes.get(script.language);
      const completedEpisode = prepared.completedEpisodes.get(script.language);
      if (completedEpisode) {
        const episode = completedEpisode;
        if (distributeEnabled) {
          const distributor = resolveDistributor(
            distributors,
            episodeDir,
            outDir,
            config,
            overrides.distributor
          );
          await distributor.publish(episode);
        }
        episodes.push(episode);
        onProgress?.({
          phase: 'episode:complete',
          episodeId: episode.id,
          language: episode.language,
          audioPath: episode.audioPath,
          durationSec: episode.durationSec,
        });
        continue;
      }
      onProgress?.({
        phase: 'tts:start',
        scriptId: script.id,
        language: script.language,
        segments: script.segments.length,
      });
      let audio = prepared.audio.get(script.language);
      let disposableRawPath: string | undefined;
      if (!audio) {
        const rawPath = checkpoint?.audioPath(script.language) ?? temporarySiblingPath(audioPath);
        disposableRawPath = checkpoint ? undefined : rawPath;
        audio = await tts.synthesize(script, {
          outputPath: rawPath,
          voices: config.voices,
          signal,
        });
        await checkpoint?.saveAudio(script.language, audio, script);
        prepared.audio.set(script.language, audio);
      }
      onProgress?.({
        phase: 'tts:complete',
        scriptId: script.id,
        language: script.language,
        durationSec: audio.durationSec,
      });

      const packagingPath = temporarySiblingPath(audioPath);
      let episode: Episode;
      try {
        await copyFile(audio.path, packagingPath);
        const packaged = await packager.package(
          script,
          { ...audio, path: packagingPath },
          { outputPath: packagingPath }
        );
        const fileInfo = await stat(packagingPath);
        const audioSha256 = createBufferHash(await readFile(packagingPath));
        await rename(packagingPath, audioPath);
        episode = {
          ...packaged,
          audioPath,
          audioSizeBytes: fileInfo.size,
          audioSha256,
          publishedAt: priorEpisode?.publishedAt ?? packaged.publishedAt,
        };
        await checkpoint?.saveEpisode(episode);
        prepared.priorEpisodes.set(script.language, episode);
        prepared.completedEpisodes.set(script.language, episode);
      } catch (error) {
        await rm(packagingPath, { force: true }).catch(() => undefined);
        throw error;
      } finally {
        if (disposableRawPath) await rm(disposableRawPath, { force: true }).catch(() => undefined);
      }
      if (distributeEnabled) {
        const distributor = resolveDistributor(
          distributors,
          episodeDir,
          outDir,
          config,
          overrides.distributor
        );
        await distributor.publish(episode);
      }
      episodes.push(episode);
      onProgress?.({
        phase: 'episode:complete',
        episodeId: episode.id,
        language: episode.language,
        audioPath: episode.audioPath,
        durationSec: episode.durationSec,
      });
    }
    };
    try {
      if (checkpoint) {
        await withFileLock(checkpoint.root, processDocument, {
          timeoutMs: 60 * 60 * 1_000,
          staleMs: 5 * 60 * 1_000,
        });
      } else {
        await processDocument();
      }
    } catch (error) {
      handleItemError(new PipelineItemError(sourceUri, 'process', error), opts, logger);
    }
  }

  logger.debug(`pipeline.complete episodes=${episodes.length} feeds=${distributors.size}`);
  onProgress?.({ phase: 'run:complete', episodes: episodes.length });
  return episodes;
}

/**
 * Returns the top-level folder name to use under `outDir` for this run.
 * For folder ingests, that's the folder's basename. For single-file
 * ingests, it's the file's stem — so `lectoria run lesson.md` lands at
 * `out/lesson/lesson-en.mp3`, matching the multi-podcast layout.
 */
async function deriveInputRootName(source: string): Promise<string> {
  const absolute = resolve(source);
  const info = await stat(absolute).catch(() => null);
  if (info?.isDirectory()) return basename(absolute);
  const ext = extname(absolute);
  return ext ? basename(absolute, ext) : basename(absolute);
}

/**
 * Builds the on-disk directory for an episode's audio + per-folder feed.
 * `doc.sourcePath` is a POSIX path like `python/lesson-1` (no extension);
 * we mirror its parent under `<outDir>/<inputRootName>/`.
 */
function resolveEpisodeDir(outDir: string, inputRootName: string, sourcePath: string): string {
  const posixDir = sourcePath.includes('/') ? sourcePath.slice(0, sourcePath.lastIndexOf('/')) : '';
  if (!posixDir) return join(outDir, inputRootName);
  return join(outDir, inputRootName, ...posixDir.split('/'));
}

/**
 * Lazily instantiates one `RssDistributor` per feed directory and caches it
 * so repeated episodes in the same folder land in the same feed. When the
 * caller passed an override distributor, every key resolves to that single
 * instance instead.
 */
function resolveDistributor(
  cache: Map<string, Distributor>,
  feedDir: string,
  outDir: string,
  config: Config,
  override?: Distributor
): Distributor {
  const cached = cache.get(feedDir);
  if (cached) return cached;
  const instance: Distributor =
    override ??
    new RssDistributor({
      outDir: feedDir,
      feed: { ...config.feed, title: feedTitleFromDir(feedDir, config.feed.title) },
      audioBaseUrl: config.feed.audioBaseUrl!,
      publicPath: relative(outDir, feedDir).split('\\').join('/'),
    });
  cache.set(feedDir, instance);
  return instance;
}

function planOutputs(
  docs: Document[],
  outDir: string,
  inputRootName: string,
  languages: readonly LanguageCode[]
): Map<string, string> {
  const candidates = new Map<
    string,
    Array<{ candidate: string; doc: Document; language: LanguageCode; dir: string; stem: string }>
  >();
  const documentIds = new Set<string>();
  for (const doc of docs) {
    if (documentIds.has(doc.id)) {
      throw new Error(`Duplicate document id "${doc.id}" detected before Azure calls.`);
    }
    documentIds.add(doc.id);
    const dir = resolveEpisodeDir(outDir, inputRootName, doc.sourcePath);
    const stem = doc.sourcePath.split('/').pop() ?? 'document';
    for (const language of languages) {
      const candidate = join(dir, `${stem}-${language}.mp3`);
      const collisionKey = pathCollisionKey(candidate);
      const entries = candidates.get(collisionKey) ?? [];
      entries.push({ candidate, doc, language, dir, stem });
      candidates.set(collisionKey, entries);
    }
  }

  const plans = new Map<string, string>();
  const finalPaths = new Set<string>();
  for (const entries of candidates.values()) {
    for (const entry of entries) {
      const path =
        entries.length === 1
          ? entry.candidate
          : join(
              entry.dir,
              `${entry.stem}-${entry.doc.metadata.sourceFormat}-${entry.doc.id.slice(-8)}-${entry.language}.mp3`
            );
      const finalKey = pathCollisionKey(path);
      if (finalPaths.has(finalKey)) throw new Error(`Output collision detected at "${path}".`);
      finalPaths.add(finalKey);
      plans.set(outputPlanKey(entry.doc.id, entry.language), path);
    }
  }
  return plans;
}

function outputPlanKey(documentId: string, language: LanguageCode): string {
  return `${documentId}\0${language}`;
}

async function hydratePreparedCheckpoint(
  prepared: PreparedDocument,
  targetLanguages: readonly LanguageCode[],
  outputPlans: ReadonlyMap<string, string>
): Promise<void> {
  prepared.scripts.clear();
  prepared.audio.clear();
  prepared.priorEpisodes.clear();
  prepared.completedEpisodes.clear();
  if (!prepared.checkpoint) return;

  for (const language of targetLanguages) {
    const priorEpisode = await prepared.checkpoint.loadEpisode(language);
    if (!priorEpisode) continue;
    prepared.priorEpisodes.set(language, priorEpisode);
    const audioPath = outputPlans.get(outputPlanKey(prepared.doc.id, language));
    if (
      audioPath &&
      await pathExists(audioPath) &&
      await audioMatchesCheckpoint(audioPath, priorEpisode.audioSha256)
    ) {
      prepared.completedEpisodes.set(language, { ...priorEpisode, audioPath });
    }
  }
  if (prepared.completedEpisodes.size === targetLanguages.length) return;

  for (const language of targetLanguages) {
    const script = await prepared.checkpoint.loadScript(language);
    if (script) prepared.scripts.set(language, script);
    if (script && !prepared.completedEpisodes.has(language)) {
      const audio = await prepared.checkpoint.loadAudio(language, script);
      if (audio) prepared.audio.set(language, audio);
    }
  }
}

function estimateRemainingWork(
  full: EstimateResult,
  prepared: PreparedDocument
): EstimateResult | undefined {
  const documentComplete =
    prepared.completedEpisodes.size === full.languages.length;
  const languages = full.languages.map((estimate, index) => {
    const completed = prepared.completedEpisodes.has(estimate.language);
    const needsPrimaryScript =
      index === 0 &&
      !documentComplete &&
      !prepared.scripts.has(estimate.language);
    if (completed && !needsPrimaryScript) {
      return zeroLanguageEstimate(estimate);
    }
    const scriptCached = prepared.scripts.has(estimate.language);
    const audioCached = completed || prepared.audio.has(estimate.language);
    const scriptUsd = scriptCached ? 0 : estimate.usd.script;
    const ttsUsd = audioCached ? 0 : estimate.usd.tts;
    return {
      ...estimate,
      scriptInputTokens: scriptCached ? 0 : estimate.scriptInputTokens,
      scriptOutputTokens: scriptCached ? 0 : estimate.scriptOutputTokens,
      ttsCharacters: audioCached ? 0 : estimate.ttsCharacters,
      audioMinutes: audioCached ? 0 : estimate.audioMinutes,
      usd: {
        script: scriptUsd,
        tts: ttsUsd,
        total: scriptUsd + ttsUsd,
      },
    };
  });
  const total = sumLanguageEstimates(languages);
  const hasPaidWork =
    total.scriptInputTokens > 0 ||
    total.scriptOutputTokens > 0 ||
    total.ttsCharacters > 0;
  if (!hasPaidWork) return undefined;
  const hasScriptWork =
    total.scriptInputTokens > 0 || total.scriptOutputTokens > 0;
  return {
    ...full,
    sourceCharacters: hasScriptWork ? full.sourceCharacters : 0,
    sections: hasScriptWork ? full.sections : 0,
    languages,
    total,
    assumptions: [
      ...full.assumptions,
      'Checkpoint-aware preflight: cached scripts, raw audio, and finalized episodes are excluded from remaining estimated spend.',
    ],
  };
}

function zeroLanguageEstimate(estimate: LanguageEstimate): LanguageEstimate {
  return {
    ...estimate,
    scriptInputTokens: 0,
    scriptOutputTokens: 0,
    ttsCharacters: 0,
    audioMinutes: 0,
    usd: { script: 0, tts: 0, total: 0 },
  };
}

function sumLanguageEstimates(
  languages: LanguageEstimate[]
): EstimateResult['total'] {
  return languages.reduce(
    (sum, estimate) => ({
      scriptInputTokens: sum.scriptInputTokens + estimate.scriptInputTokens,
      scriptOutputTokens: sum.scriptOutputTokens + estimate.scriptOutputTokens,
      ttsCharacters: sum.ttsCharacters + estimate.ttsCharacters,
      audioMinutes: sum.audioMinutes + estimate.audioMinutes,
      usd: {
        script: sum.usd.script + estimate.usd.script,
        tts: sum.usd.tts + estimate.usd.tts,
        total: sum.usd.total + estimate.usd.total,
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
}

function validateCustomAdapterPricing(
  overrides: RunOverrides,
  pricing: Partial<PricingTable> | undefined
): void {
  const missing: string[] = [];
  if (overrides.scriptModel) {
    if (pricing?.openAiInputPer1M === undefined) missing.push('openAiInputPer1M');
    if (pricing?.openAiOutputPer1M === undefined) missing.push('openAiOutputPer1M');
  }
  if (overrides.tts && pricing?.azureSpeechPer1M === undefined) {
    missing.push('azureSpeechPer1M');
  }
  if (missing.length > 0) {
    throw new Error(
      `Cost awareness with custom paid adapters requires explicit costPolicy.pricing values: ${missing.join(', ')}.`
    );
  }
}

function resolveCheckpointStore(
  config: Config,
  opts: RunOptions,
  overrides: RunOverrides,
  doc: Document,
  style: ScriptStyle,
  targetLanguages: readonly LanguageCode[],
  outDir: string
): PipelineCheckpointStore | undefined {
  if (opts.resume === false) return undefined;
  const customPaidStage = overrides.scriptModel || overrides.tts || overrides.packager;
  if (customPaidStage && !opts.checkpointKey) return undefined;
  const fingerprint = createFingerprint({
    formatVersion: 1,
    checkpointKey: opts.checkpointKey ?? 'lectoria-default-adapters-v1',
    document: {
      id: doc.id,
      contentHash: doc.contentHash,
      title: doc.title,
      language: doc.language,
      sections: doc.sections,
      sourcePath: doc.sourcePath,
      sourceUri: doc.metadata.sourceUri,
      sourceFormat: doc.metadata.sourceFormat,
    },
    style,
    targetLanguages,
    glossary: opts.glossary ?? config.glossary,
    voices: config.voices,
    azure: {
      openai: config.azure.openai,
      speech: config.azure.speech,
    },
  });
  return new PipelineCheckpointStore(
    join(resolve(opts.checkpointDir ?? join(outDir, '.lectoria-cache')), fingerprint)
  );
}

function handleItemError(error: PipelineItemError, opts: RunOptions, logger: Logger): void {
  if (opts.signal?.aborted) {
    throw opts.signal.reason instanceof Error
      ? opts.signal.reason
      : new DOMException('Pipeline aborted.', 'AbortError');
  }
  if (isAbortError(error.cause)) throw error.cause;
  opts.onItemError?.(error);
  if (!opts.continueOnError) throw error;
  logger.warn(error.message);
}

function pathCollisionKey(path: string): string {
  return path.normalize('NFC').toLocaleLowerCase('en-US');
}

async function audioMatchesCheckpoint(path: string, expectedHash: string): Promise<boolean> {
  return createBufferHash(await readFile(path)) === expectedHash;
}

function isAbortError(error: unknown): error is Error {
  if (!(error instanceof Error)) return false;
  if (error.name === 'AbortError') return true;
  return isAbortError(error.cause);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Derives a human-readable feed title from a directory path. Title-cases
 * kebab/snake-case folder names so `data-science` → "Data Science". Falls
 * back to the configured global title when the leaf is empty.
 */
function feedTitleFromDir(feedDir: string, fallback: string): string {
  const leaf = basename(feedDir);
  if (!leaf) return fallback;
  return leaf
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
