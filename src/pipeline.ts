import { mkdir, stat } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import type { Config } from './config.js';
import type {
  Distributor,
  Document,
  Episode,
  Glossary,
  LanguageCode,
  Packager,
  PodcastScript,
  ProgressListener,
  ScriptModel,
  ScriptStyle,
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
   * audio files. Default `true`. Set to `false` to produce audio only —
   * useful for callers that handle distribution themselves.
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
  scriptModel?: ScriptModel;
  tts?: TtsProvider;
  packager?: Packager;
  distributor?: Distributor;
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
 * Errors propagate so the CLI can format them; resume / state tracking is
 * a v1 concern.
 */
export async function runPipeline(
  config: Config,
  opts: RunOptions,
  overrides: RunOverrides = {}
): Promise<Episode[]> {
  const targetLanguages = opts.targetLanguages ?? (config.targetLanguages as LanguageCode[]);
  const style: ScriptStyle = opts.style ?? { kind: 'conversational' };
  const logger = opts.logger ?? noopLogger;
  const onProgress = opts.onProgress;
  const signal = opts.signal;
  const recursive = opts.recursive ?? true;
  const distributeEnabled = opts.distribute ?? true;
  const glossary = opts.glossary ?? config.glossary;
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

  const inputRootName = await deriveInputRootName(opts.source);
  const sources = await ingest(opts.source, { recursive });

  // Cache one Distributor per feed directory. When `overrides.distributor`
  // is set, the cache resolves every key to that single instance — preserving
  // legacy single-feed behavior for callers that opt out of per-folder feeds.
  const distributors = new Map<string, Distributor>();
  const episodes: Episode[] = [];

  for (const source of sources) {
    signal?.throwIfAborted();
    onProgress?.({ phase: 'parse:start', source: source.uri });
    const doc: Document = await parse(source);
    onProgress?.({
      phase: 'parse:complete',
      documentId: doc.id,
      sections: doc.sections.length,
    });

    const primaryLanguage = targetLanguages[0] ?? doc.language;
    const chunked = style.kind !== 'podcast' && doc.sections.length > 1;
    onProgress?.({
      phase: 'script:start',
      documentId: doc.id,
      language: primaryLanguage,
      style: style.kind,
      sections: doc.sections.length,
      chunked,
    });
    const baseScript: PodcastScript = await scriptModel.generateScript(doc, {
      targetLanguage: primaryLanguage,
      style,
      glossary,
      signal,
    });
    onProgress?.({
      phase: 'script:complete',
      scriptId: baseScript.id,
      segments: baseScript.segments.length,
    });

    const localizedScripts = await translateToAll(scriptModel, baseScript, targetLanguages, {
      signal,
      onProgress,
      glossary,
    });

    const episodeDir = resolveEpisodeDir(outDir, inputRootName, doc.sourcePath);
    await mkdir(episodeDir, { recursive: true });

    for (const script of localizedScripts) {
      signal?.throwIfAborted();
      const audioPath = join(episodeDir, `${doc.id}-${script.language}.mp3`);
      onProgress?.({
        phase: 'tts:start',
        scriptId: script.id,
        language: script.language,
        segments: script.segments.length,
      });
      const audio = await tts.synthesize(script, { outputPath: audioPath, voices: config.voices, signal });
      onProgress?.({
        phase: 'tts:complete',
        scriptId: script.id,
        language: script.language,
        durationSec: audio.durationSec,
      });

      const episode = await packager.package(script, audio, { outputPath: audioPath });
      if (distributeEnabled) {
        const distributor = resolveDistributor(distributors, episodeDir, config, overrides.distributor);
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
    });
  cache.set(feedDir, instance);
  return instance;
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
