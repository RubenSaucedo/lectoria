import { AzureSpeechTts } from './synthesize/azure-speech.js';
import { atomicWriteFile } from './fs-safe.js';
import type { LectoriaAuth } from './azure-auth.js';
import type {
  LanguageCode,
  PodcastScript,
  ProgressListener,
  SynthesizedAudio,
  VoiceMap,
} from './types.js';

export interface CreateTtsOptions {
  region: string;
  /**
   * Auth strategy. Defaults to `{ kind: 'default' }` (DefaultAzureCredential).
   * Pass `{ kind: 'apiKey', apiKey }` for hosts that don't speak Entra, or
   * `{ kind: 'credential', credential }` to plug in any `@azure/identity`
   * credential.
   */
  auth?: LectoriaAuth;
  /**
   * Full Azure resource ID of the Speech resource. Required with `credential`
   * or `default` auth (needed for the `aad#<resourceId>#<token>` wrapper).
   */
  resourceId?: string;
  /**
   * Default Azure voice id used when `.speak()` / `.speakToFile()` is called
   * without an explicit `voice`. Example: `en-US-AvaMultilingualNeural`.
   */
  defaultVoice?: string;
  /** Default language code used when no `language` is passed. Defaults to 'en'. */
  defaultLanguage?: LanguageCode;
  /** Optional structured progress callback. */
  onProgress?: ProgressListener;
  /** Deadline for each Speech request. Defaults to 120 seconds. */
  timeoutMs?: number;
  /**
   * Number of transient retries after the first attempt. Defaults to 2.
   *
   * Pass `0` when a caller must not be billed twice for one request without
   * having asked for it — a retry is another paid synthesis, and a client that
   * saw a timeout cannot tell whether the first call also produced audio.
   */
  maxRetries?: number;
  /** Base retry delay in milliseconds. Defaults to 500. */
  retryDelayMs?: number;
}

export interface SpeakOptions {
  /** Azure voice id. Falls back to the factory's `defaultVoice`. */
  voice?: string;
  /** Language code (used in the SSML `xml:lang` envelope). Falls back to defaultLanguage. */
  language?: LanguageCode;
  /** Cancellation signal. */
  signal?: AbortSignal;
}

/**
 * Result of a buffer-returning speak call.
 */
export interface SpeakResult {
  bytes: Buffer;
  durationSec: number;
}

/**
 * Lightweight surface for using lectoria as a plain text-to-speech library
 * without going through the full doc-to-podcast pipeline. Returned by
 * `createTTS()`.
 *
 * Use this when you already have the text you want spoken — e.g. an LLM
 * response, a notification message, a generated chapter. For Markdown /
 * docx / PDF → audio with structure-aware chunking and translation, use
 * `runPipeline()` instead.
 */
export interface TtsClient {
  /** Synthesise raw text and return the MP3 bytes in memory. */
  speak(text: string, opts?: SpeakOptions): Promise<SpeakResult>;
  /** Synthesise raw text and write the MP3 to disk. */
  speakToFile(text: string, outputPath: string, opts?: SpeakOptions): Promise<SynthesizedAudio>;
  /**
   * Synthesise an already-built `PodcastScript` (multi-segment, multi-voice).
   * Equivalent to using `AzureSpeechTts` directly — exposed here so callers
   * who already have the factory don't need to construct the provider twice.
   */
  synthesizeScript(
    script: PodcastScript,
    opts: { outputPath: string; voices: VoiceMap; signal?: AbortSignal }
  ): Promise<SynthesizedAudio>;
  /** Underlying provider, for advanced use (custom SSML, etc.). */
  readonly provider: AzureSpeechTts;
}

/**
 * Creates a text-to-speech client backed by Azure AI Speech.
 *
 * @example
 * ```ts
 * import { createTTS } from 'lectoria';
 *
 * const tts = createTTS({
 *   region: 'westus',
 *   auth: { kind: 'apiKey', apiKey: process.env.AZURE_SPEECH_KEY! },
 *   defaultVoice: 'en-US-AvaMultilingualNeural',
 * });
 *
 * await tts.speakToFile('Hello world', './hello.mp3');
 * ```
 */
export function createTTS(opts: CreateTtsOptions): TtsClient {
  const provider = new AzureSpeechTts({
    region: opts.region,
    resourceId: opts.resourceId,
    auth: opts.auth,
    onProgress: opts.onProgress,
    timeoutMs: opts.timeoutMs,
    maxRetries: opts.maxRetries,
    retryDelayMs: opts.retryDelayMs,
  });
  const defaultLanguage = opts.defaultLanguage ?? 'en';

  function resolveVoiceAndLanguage(speakOpts: SpeakOptions | undefined): {
    voice: string;
    language: LanguageCode;
  } {
    const voice = speakOpts?.voice ?? opts.defaultVoice;
    if (!voice) {
      throw new Error(
        'createTTS: no voice provided. Pass `voice` on the call, or set `defaultVoice` on createTTS().'
      );
    }
    return { voice, language: speakOpts?.language ?? defaultLanguage };
  }

  /**
   * Wraps the raw text into the minimal PodcastScript shape the provider
   * accepts: one body segment, one utterance. The voice id we attach
   * (`speaker`) is also what we key the VoiceMap on, so the SSML stage
   * resolves it cleanly without needing a real "host" entry.
   */
  function buildOneShotScript(
    text: string,
    voice: string,
    language: LanguageCode
  ): { script: PodcastScript; voices: VoiceMap } {
    const speakerKey = 'speaker';
    return {
      script: {
        id: `ad-hoc-${Date.now()}`,
        documentId: 'ad-hoc',
        episodeTitle: '',
        language,
        summary: '',
        segments: [
          {
            kind: 'body',
            utterances: [{ voice: speakerKey, text }],
          },
        ],
      },
      voices: { [speakerKey]: { [language]: voice } },
    };
  }

  return {
    provider,
    async speak(text, speakOpts) {
      const { voice, language } = resolveVoiceAndLanguage(speakOpts);
      const { script, voices } = buildOneShotScript(text, voice, language);
      const { bytes, durationSec } = await provider.synthesizeToBuffer(script, {
        voices,
        signal: speakOpts?.signal,
      });
      return { bytes, durationSec };
    },
    async speakToFile(text, outputPath, speakOpts) {
      const { voice, language } = resolveVoiceAndLanguage(speakOpts);
      const { script, voices } = buildOneShotScript(text, voice, language);
      const { bytes, durationSec, segmentOffsetsSec } = await provider.synthesizeToBuffer(script, {
        voices,
        signal: speakOpts?.signal,
      });
      await atomicWriteFile(outputPath, bytes);
      return { path: outputPath, durationSec, segmentOffsetsSec };
    },
    synthesizeScript(script, scriptOpts) {
      return provider.synthesize(script, scriptOpts);
    },
  };
}
