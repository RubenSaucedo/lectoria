/**
 * Core contracts every pipeline stage consumes or produces.
 *
 * Pipeline: ingest -> parse -> script -> translate -> synthesize -> package -> distribute
 *   ingest      produces SourceFile
 *   parse       produces Document
 *   script      produces PodcastScript (source-language)
 *   translate   produces PodcastScript (target-language)
 *   synthesize  produces SynthesizedAudio
 *   package     produces Episode
 *   distribute  consumes Episode (and updates the Feed)
 */

export type LanguageCode = 'en' | 'es' | (string & {});

export type SourceFormat = 'pdf' | 'docx' | 'md' | 'html' | 'txt';

export interface SourceFile {
  /** Stable identifier derived from the logical source URI. */
  id: string;
  /** SHA-256 of the fetched bytes; changes when the source revision changes. */
  contentHash: string;
  /** Absolute path or URL the bytes came from. */
  uri: string;
  /** Detected format used to pick a parser. */
  format: SourceFormat;
  /** Raw bytes of the source document. */
  bytes: Buffer;
  /** ISO 8601 timestamp of when the source was fetched. */
  fetchedAt: string;
  /**
   * Relative path from the ingest root, using POSIX separators ('/').
   * For a single-file ingest, this is just the file's basename without
   * extension (e.g., 'twa-design'). For a folder ingest like
   * `samples/courses/python/lesson-1.md` with input root `samples/courses`,
   * this is `python/lesson-1` (no extension).
   *
   * Used by the pipeline to mirror input structure into the output
   * directory and to group episodes by their source directory for
   * per-folder podcast feeds.
   */
  sourcePath: string;
}

export interface DocumentSection {
  heading?: string;
  paragraphs: string[];
}

export interface Document {
  id: string;
  /** Content revision inherited from SourceFile. */
  contentHash: string;
  title: string;
  /** Best-guess source language. Translation stage will target other languages. */
  language: LanguageCode;
  sections: DocumentSection[];
  /**
   * Relative path from the ingest root, POSIX-style, no extension.
   * Inherited from `SourceFile.sourcePath`. Used by the pipeline to mirror
   * input structure into outDir and to scope per-folder podcast feeds.
   */
  sourcePath: string;
  metadata: {
    sourceUri: string;
    sourceFormat: SourceFormat;
    fetchedAt: string;
    [key: string]: unknown;
  };
}

export type SegmentKind = 'intro' | 'body' | 'outro' | 'chapter';

export interface Utterance {
  /**
   * Logical speaker id (e.g. "host", "guest", "narrator"). Mapped to a
   * provider voice id at synthesis time via VoiceMap[voice][language].
   * Single-voice styles (podcast / conversational / verbatim) emit "host"
   * for every utterance; dialogue mode alternates among the configured
   * speaker ids.
   */
  voice?: string;
  text: string;
  pauseAfterMs?: number;
}

export interface PodcastSegment {
  kind: SegmentKind;
  heading?: string;
  utterances: Utterance[];
}

export interface PodcastScript {
  /** Stable script identity. Do not parse document or language values from it. */
  id: string;
  /** Explicit source-document identity retained across translations. */
  documentId: string;
  episodeTitle: string;
  language: LanguageCode;
  summary: string;
  segments: PodcastSegment[];
  /**
   * The style this script was generated in. Translators read this so a
   * verbatim source script gets a faithful translation, not a podcast remix.
   */
  style?: ScriptStyle;
  /** Optional rough estimate; final value lives on the Episode. */
  estimatedDurationSec?: number;
}

export interface SynthesizedAudio {
  /** Path to a raw audio file (typically WAV or MP3) on disk. */
  path: string;
  durationSec: number;
  /** Where each segment starts in the audio, in seconds. Used to build chapters. */
  segmentOffsetsSec: number[];
}

export interface Chapter {
  startSec: number;
  title: string;
}

export interface Episode {
  id: string;
  scriptId: string;
  documentId: string;
  language: LanguageCode;
  title: string;
  description: string;
  audioPath: string;
  audioSizeBytes: number;
  /** SHA-256 of the finalized, tagged audio file. */
  audioSha256: string;
  durationSec: number;
  chapters: Chapter[];
  publishedAt: string;
}

/** ----- Stage interfaces ----- */

export interface IngestSource {
  /** Whether this adapter handles the given URI. */
  supports(uri: string): boolean;
  /** Fetch zero or more source files from a URI (file path, folder path, URL, etc.). */
  fetch(uri: string): Promise<SourceFile[]>;
}

export interface DocumentParser {
  format: SourceFormat;
  parse(file: SourceFile, opts?: ParserOptions): Promise<Document>;
}

export interface ParserOptions {
  /** Explicit source language when automatic detection is ambiguous. */
  sourceLanguage?: LanguageCode;
}

export interface DialogueSpeaker {
  /** Speaker id used as the `voice` field on each utterance and as the key into VoiceMap. */
  id: string;
  /** Optional display name the model uses inside the script ("Ava", "Jorge"). Defaults to id. */
  name?: string;
  /** Optional short persona/role hint passed to the script model ("the curious learner"). */
  persona?: string;
}

/**
 * Ordered from most adapted to most faithful, plus a `dialogue` mode that
 * produces a two- or many-voice exchange:
 *
 * - `podcast`: a friendly podcast host rewrites the doc into an episode
 *   with welcome, chapters, recap, and sign-off. Highest production feel,
 *   lowest fidelity to the source structure. Single voice.
 * - `conversational`: a natural spoken read-along — no podcast welcome
 *   or sign-off, but the model is allowed to restructure lists, combine
 *   short paragraphs, and add brief spoken signposts so it flows by ear.
 *   ~70% fidelity. Best when you want to understand the document by
 *   listening without it sounding like a show. Single voice.
 * - `verbatim`: read the document essentially as-is, in the requested
 *   language. No invented intro/outro, no host banter, no signposting —
 *   just the document content, lightly cleaned up for spoken delivery.
 *   ~95% fidelity. Single voice.
 * - `dialogue`: two (or more) named speakers discuss the material in a
 *   natural back-and-forth — NotebookLM-style. Each utterance carries
 *   the speaker id so the TTS stage can dispatch to the right voice.
 */
export type ScriptStyle =
  | { kind: 'podcast' }
  | { kind: 'conversational' }
  | { kind: 'verbatim' }
  | { kind: 'dialogue'; speakers: DialogueSpeaker[] };

export interface ScriptModel {
  generateScript(
    doc: Document,
    opts: { targetLanguage: LanguageCode; style: ScriptStyle; glossary?: Glossary; signal?: AbortSignal }
  ): Promise<PodcastScript>;
  translateScript(
    script: PodcastScript,
    targetLanguage: LanguageCode,
    opts?: { glossary?: Glossary; signal?: AbortSignal }
  ): Promise<PodcastScript>;
}

/**
 * A single glossary entry. Most often a bare string (the term itself), but
 * accepts an object form when you want to give the script model a hint
 * about what the term means (so it doesn't expand or translate it) or
 * override the default case-sensitivity heuristic.
 *
 * Examples:
 *   "MCP"
 *   "HubSpot"
 *   { term: "DA", meaning: "Domain Admin" }
 *   { term: "asana", caseSensitive: false }
 */
export type GlossaryEntry =
  | string
  | {
      /** Exact written form to keep verbatim, e.g. "MCP", "HubSpot", "ADO 5417982". */
      term: string;
      /**
       * Optional short gloss to help the script model understand the term
       * without expanding or translating it in the script.
       */
      meaning?: string;
      /**
       * Whether matching is case-sensitive. Defaults to true for ALL-CAPS
       * acronyms (so "MCP" wraps only when written "MCP", not "mcp"), and
       * false otherwise.
       */
      caseSensitive?: boolean;
    };

/**
 * Project-specific list of terms that should keep their original-language
 * pronunciation across all target languages.
 *
 * The script-generation prompt enumerates these explicitly so the LLM
 * wraps them in the `[[en]]…[[/en]]` marker, and a deterministic
 * post-processor wraps any unmarked occurrences after the model returns —
 * so terms that slip past the model still get the right pronunciation.
 *
 * The synthesis stage then rewrites those markers into SSML
 * `<lang xml:lang="en-US">…</lang>` so Azure Neural TTS reads them with
 * English phonetics, even mid-Spanish-narration.
 */
export interface Glossary {
  terms: GlossaryEntry[];
}

export interface VoiceMap {
  /**
   * Map logical speaker id ("host", "guest", "narrator") to a provider
   * voice per language. Dialogue mode requires an entry for every
   * speaker id that appears in the script.
   *
   * A voice is either a bare Azure voice id (e.g. "es-ES-AlvaroNeural") or a
   * {@link VoiceSpec} object when you want to tune delivery (pace, pitch, or
   * an Azure "express-as" speaking style).
   */
  [logicalVoice: string]: { [language: string]: VoiceValue };
}

/**
 * A voice value: either a bare Azure voice id, or a {@link VoiceSpec} that
 * layers delivery tuning on top of the voice. Bare strings keep single-voice
 * scripts working unchanged.
 */
export type VoiceValue = string | VoiceSpec;

/**
 * A voice plus optional delivery tuning applied at synthesis time via SSML.
 * `rate`/`pitch` map to `<prosody>` and work on every neural voice; `style`
 * maps to `<mstts:express-as>` and only takes effect on voices that support
 * that style (an unsupported style errors the run), so leave it unset unless
 * you've confirmed support for the chosen voice.
 */
export interface VoiceSpec {
  /** Azure voice id, e.g. "es-ES-AlvaroNeural". */
  name: string;
  /** Prosody speaking rate, e.g. "-6%" (slower/measured) or "+5%". */
  rate?: string;
  /** Prosody pitch, e.g. "+2%" or "-1st". */
  pitch?: string;
  /** Azure express-as style, e.g. "cheerful". Only for voices that support it. */
  style?: string;
  /** Style intensity 0.01–2 (Azure default 1). Only meaningful with `style`. */
  styleDegree?: number;
}

export interface TtsProvider {
  synthesize(
    script: PodcastScript,
    opts: { outputPath: string; voices: VoiceMap; signal?: AbortSignal }
  ): Promise<SynthesizedAudio>;
}

export interface Packager {
  package(
    script: PodcastScript,
    audio: SynthesizedAudio,
    opts: { outputPath: string }
  ): Promise<Episode>;
}

export interface Distributor {
  publish(episode: Episode): Promise<void>;
}

/**
 * Structured progress events emitted by `runPipeline`. Subscribe with
 * `RunOptions.onProgress` to drive a progress bar, telemetry pipeline, or
 * UI without parsing log strings. Events run alongside the Logger interface
 * (which produces human-readable lines) — pick one or both.
 *
 * The `phase` discriminator names a stage; `*:start` events carry totals so
 * consumers can size their progress bar, `*:item` events fire per unit of
 * work, and `*:complete` events fire once per stage.
 */
export type ProgressEvent =
  | { phase: 'parse:start'; source: string }
  | { phase: 'parse:complete'; documentId: string; sections: number }
  | {
      phase: 'cost:assessment';
      documents: number;
      sourceCharacters: number;
      estimatedAudioMinutes: number;
      estimatedUsd: number;
      warnings: string[];
    }
  | {
      phase: 'script:start';
      documentId: string;
      language: LanguageCode;
      style: ScriptStyle['kind'];
      sections: number;
      /** True when the pipeline will chunk by section to dodge TPM caps. */
      chunked: boolean;
    }
  | {
      phase: 'script:section';
      documentId: string;
      sectionIndex: number;
      sectionTotal: number;
      heading?: string;
    }
  | { phase: 'script:complete'; scriptId: string; segments: number }
  | {
      phase: 'translate:start';
      scriptId: string;
      language: LanguageCode;
      segments: number;
      chunked: boolean;
    }
  | {
      phase: 'translate:segment';
      scriptId: string;
      language: LanguageCode;
      segmentIndex: number;
      segmentTotal: number;
    }
  | { phase: 'translate:complete'; scriptId: string; language: LanguageCode }
  | {
      phase: 'tts:start';
      scriptId: string;
      language: LanguageCode;
      segments: number;
    }
  | {
      phase: 'tts:segment';
      scriptId: string;
      language: LanguageCode;
      segmentIndex: number;
      segmentTotal: number;
    }
  | {
      phase: 'tts:complete';
      scriptId: string;
      language: LanguageCode;
      durationSec: number;
    }
  | {
      phase: 'episode:complete';
      episodeId: string;
      language: LanguageCode;
      audioPath: string;
      durationSec: number;
    }
  | { phase: 'run:complete'; episodes: number };

export type ProgressListener = (event: ProgressEvent) => void;
