import * as sdk from 'microsoft-cognitiveservices-speech-sdk';
import { writeFile } from 'node:fs/promises';
import {
  COGNITIVE_SERVICES_SCOPE,
  resolveCredential,
  type LectoriaAuth,
} from '../azure-auth.js';
import type {
  PodcastScript,
  PodcastSegment,
  ProgressListener,
  SynthesizedAudio,
  TtsProvider,
  VoiceMap,
  VoiceSpec,
  VoiceValue,
} from '../types.js';

export interface AzureSpeechTtsOptions {
  region: string;
  /**
   * Full Azure resource ID of the Speech resource, e.g.:
   *   /subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.CognitiveServices/accounts/<name>
   * Required when using `credential` or `default` auth (used to build the
   * Entra ID authorization token `aad#<resourceId>#<token>`). Not used for
   * `apiKey` auth.
   */
  resourceId?: string;
  /**
   * Auth strategy. Defaults to `{ kind: 'default' }` which uses
   * DefaultAzureCredential. Pass `{ kind: 'apiKey', apiKey }` for hosts
   * that don't speak Entra.
   */
  auth?: LectoriaAuth;
  /**
   * Optional structured progress callback. Receives one event per segment
   * synthesised so consumers can drive a progress bar.
   */
  onProgress?: ProgressListener;
}

/**
 * Azure AI Speech Neural TTS adapter.
 *
 * Supports two auth modes:
 *  - Entra ID (credential / default): the Speech SDK expects a token
 *    wrapped as `aad#<resourceId>#<accessToken>`. The token is refreshed
 *    before every segment so long runs don't expire mid-flight.
 *  - API key: SpeechConfig.fromSubscription(apiKey, region). No refresh
 *    needed.
 *
 * The whole script is rendered segment-by-segment so the packaging stage can
 * emit chapter markers. A production pass should subscribe to word-boundary
 * events for sub-segment accuracy.
 */
export class AzureSpeechTts implements TtsProvider {
  #options: AzureSpeechTtsOptions;
  #auth: LectoriaAuth;
  #onProgress?: ProgressListener;

  constructor(options: AzureSpeechTtsOptions) {
    this.#options = options;
    this.#auth = options.auth ?? { kind: 'default' };
    this.#onProgress = options.onProgress;
    if (this.#auth.kind !== 'apiKey' && !options.resourceId) {
      throw new Error(
        'AzureSpeechTts: resourceId is required when using credential or default auth (needed to build the Entra token wrapper).'
      );
    }
  }

  async synthesize(
    script: PodcastScript,
    opts: { outputPath: string; voices: VoiceMap; signal?: AbortSignal }
  ): Promise<SynthesizedAudio> {
    const { bytes, durationSec, segmentOffsetsSec } = await this.synthesizeToBuffer(script, opts);
    await writeFile(opts.outputPath, bytes);
    return { path: opts.outputPath, durationSec, segmentOffsetsSec };
  }

  /**
   * Same work as `synthesize` but returns the merged audio bytes in memory
   * instead of writing them to disk. Used by the `createTTS()` factory to
   * power `speak()` (buffer) vs `speakToFile()` (file).
   */
  async synthesizeToBuffer(
    script: PodcastScript,
    opts: { voices: VoiceMap; signal?: AbortSignal }
  ): Promise<{ bytes: Buffer; durationSec: number; segmentOffsetsSec: number[] }> {
    const speechConfig = await this.#buildSpeechConfig();
    speechConfig.speechSynthesisOutputFormat = sdk.SpeechSynthesisOutputFormat.Audio24Khz96KBitRateMonoMp3;

    const segmentOffsetsSec: number[] = [];
    const audioChunks: Buffer[] = [];
    let cumulativeMs = 0;
    const total = script.segments.length;

    for (let i = 0; i < total; i++) {
      const segment = script.segments[i]!;
      opts.signal?.throwIfAborted();
      segmentOffsetsSec.push(cumulativeMs / 1000);
      await this.#refreshAuth(speechConfig);
      const ssml = ssmlForSegment(script.language, opts.voices, segment);
      const { bytes, durationMs } = await synthesizeSsml(speechConfig, ssml);
      audioChunks.push(bytes);
      cumulativeMs += durationMs;
      this.#onProgress?.({
        phase: 'tts:segment',
        scriptId: script.id,
        language: script.language,
        segmentIndex: i,
        segmentTotal: total,
      });
    }

    return {
      bytes: Buffer.concat(audioChunks),
      durationSec: cumulativeMs / 1000,
      segmentOffsetsSec,
    };
  }

  async #buildSpeechConfig(): Promise<sdk.SpeechConfig> {
    if (this.#auth.kind === 'apiKey') {
      return sdk.SpeechConfig.fromSubscription(this.#auth.apiKey, this.#options.region);
    }
    const token = await this.#mintAuthorizationToken();
    return sdk.SpeechConfig.fromAuthorizationToken(token, this.#options.region);
  }

  async #refreshAuth(speechConfig: sdk.SpeechConfig): Promise<void> {
    if (this.#auth.kind === 'apiKey') return;
    speechConfig.authorizationToken = await this.#mintAuthorizationToken();
  }

  async #mintAuthorizationToken(): Promise<string> {
    const credential = resolveCredential(this.#auth);
    const tokenResponse = await credential.getToken(COGNITIVE_SERVICES_SCOPE);
    if (!tokenResponse) {
      throw new Error('Failed to acquire Entra ID token for Azure Speech. Run `az login` or pass an explicit credential.');
    }
    return `aad#${this.#options.resourceId}#${tokenResponse.token}`;
  }
}

/**
 * Resolves the voice for a given logical speaker + language into a normalized
 * {@link VoiceSpec} (bare voice-id values become `{ name }`).
 *
 * Falls back to `host` when `voiceKey` is missing or unmapped — so existing
 * single-voice scripts (every utterance with voice="host" or voice undefined)
 * keep working unchanged.
 *
 * Throws when even `host` is not configured for `language`, with a message
 * that lists what IS configured so the caller can fix their VoiceMap fast.
 */
function resolveVoice(language: string, voices: VoiceMap, voiceKey: string | undefined): VoiceSpec {
  const key = voiceKey ?? 'host';
  const candidate = voices[key]?.[language];
  if (candidate) return normalizeVoice(candidate);

  // Explicit speaker id requested but unmapped — surface what IS available
  // so the caller can either add the mapping or fix the speaker id.
  if (key !== 'host') {
    const fallback = voices.host?.[language];
    if (fallback) return normalizeVoice(fallback);
    const known = Object.keys(voices).join(', ');
    throw new Error(
      `No voice configured for speaker "${key}" in language "${language}", and no "host" fallback either. Configured speaker ids: ${known}.`
    );
  }
  const known = Object.keys(voices.host ?? {}).join(', ');
  throw new Error(
    `No "host" voice configured for language "${language}". Configured host languages: ${known}.`
  );
}

/** Normalize a VoiceValue (bare id or spec) into a VoiceSpec. */
function normalizeVoice(value: VoiceValue): VoiceSpec {
  return typeof value === 'string' ? { name: value } : value;
}

/** Stable identity for grouping consecutive utterances that share a voice + delivery. */
function voiceKeyOf(v: VoiceSpec): string {
  return `${v.name}|${v.rate ?? ''}|${v.pitch ?? ''}|${v.style ?? ''}|${v.styleDegree ?? ''}`;
}

/**
 * Wrap an SSML body fragment for one voice, applying delivery tuning:
 * `<prosody rate/pitch>` (works on every voice) optionally wrapped in
 * `<mstts:express-as style>` (only for voices that support the style).
 */
function voiceBlock(v: VoiceSpec, body: string): string {
  const rate = v.rate ?? '0%';
  const pitchAttr = v.pitch ? ` pitch="${escapeXml(v.pitch)}"` : '';
  let inner = `<prosody rate="${escapeXml(rate)}"${pitchAttr}>${body}</prosody>`;
  if (v.style) {
    const degree = v.styleDegree != null ? ` styledegree="${v.styleDegree}"` : '';
    inner = `<mstts:express-as style="${escapeXml(v.style)}"${degree}>${inner}</mstts:express-as>`;
  }
  return `<voice name="${escapeXml(v.name)}">${inner}</voice>`;
}

export function ssmlForSegment(
  language: string,
  voices: VoiceMap,
  segment: PodcastSegment
): string {
  // Cache resolved voices per speaker key inside this segment so we don't
  // repeat the lookup for every utterance.
  const voiceCache = new Map<string, VoiceSpec>();
  const voiceFor = (speakerKey: string | undefined): VoiceSpec => {
    const key = speakerKey ?? 'host';
    const cached = voiceCache.get(key);
    if (cached) return cached;
    const resolved = resolveVoice(language, voices, key);
    voiceCache.set(key, resolved);
    return resolved;
  };

  // Group consecutive utterances by voice + delivery so each block synthesises
  // multiple utterances in one shot — cleaner audio than restarting the
  // voice for every line.
  const runs: Array<{ voice: VoiceSpec; key: string; body: string }> = [];
  for (const u of segment.utterances) {
    const voice = voiceFor(u.voice);
    const key = voiceKeyOf(voice);
    const safeText = renderUtteranceText(u.text, language);
    const pause = u.pauseAfterMs ? `<break time="${u.pauseAfterMs}ms"/>` : '';
    const fragment = `${safeText} ${pause}`;
    const last = runs[runs.length - 1];
    if (last && last.key === key) {
      last.body += ` ${fragment}`;
    } else {
      runs.push({ voice, key, body: fragment });
    }
  }

  const voiceBlocks = runs.map((r) => voiceBlock(r.voice, r.body)).join('');

  // Only declare the mstts namespace when a run actually uses express-as, so
  // style-free scripts keep their previous (namespace-free) SSML envelope.
  const usesStyle = runs.some((r) => r.voice.style);
  const mstts = usesStyle ? ' xmlns:mstts="http://www.w3.org/2001/mstts"' : '';

  return [
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis"${mstts} xml:lang="${language}">`,
    voiceBlocks,
    `</speak>`,
  ].join('');
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Lectoria marker that tells the synthesis stage to switch the neural voice
 * into English phonetics for a span of text. Scripts produced by our LLM
 * prompts wrap English acronyms / proper nouns / code identifiers in this
 * marker whenever the surrounding narration is in another language. See
 * `preservationRules()` in src/script/prompts.ts.
 *
 * The marker is intentionally not XML so it survives JSON round-tripping
 * through OpenAI structured output without escaping surprises.
 */
const ENGLISH_SPAN_MARKER = /\[\[en\]\]([\s\S]*?)\[\[\/en\]\]/g;

/**
 * Convert an utterance's plain text into SSML-safe inline content.
 *
 * - XML-escapes everything (so `<`, `&`, quotes are safe to embed).
 * - Converts `[[en]]X[[/en]]` markers into `<lang xml:lang="en-US">X</lang>`
 *   so Azure Neural TTS pronounces the wrapped span with English phonetics
 *   — even when the surrounding voice is set to es-ES, fr-FR, etc.
 * - When the script's own language is already English, the marker is
 *   stripped and the inner text is emitted as-is (no need to switch).
 *
 * Exported for unit testing.
 */
export function renderUtteranceText(text: string, scriptLanguage: string): string {
  const isEnglish = scriptLanguage.toLowerCase().startsWith('en');

  const parts: string[] = [];
  let cursor = 0;
  // Reset lastIndex because the regex is /g and lives at module scope.
  ENGLISH_SPAN_MARKER.lastIndex = 0;
  for (let match = ENGLISH_SPAN_MARKER.exec(text); match !== null; match = ENGLISH_SPAN_MARKER.exec(text)) {
    const [whole, inner] = match;
    parts.push(escapeXml(text.slice(cursor, match.index)));
    const safeInner = escapeXml(inner ?? '');
    parts.push(isEnglish ? safeInner : `<lang xml:lang="en-US">${safeInner}</lang>`);
    cursor = match.index + whole.length;
  }
  parts.push(escapeXml(text.slice(cursor)));
  return parts.join('');
}

function synthesizeSsml(
  config: sdk.SpeechConfig,
  ssml: string
): Promise<{ bytes: Buffer; durationMs: number }> {
  return new Promise((resolveP, rejectP) => {
    const synthesizer = new sdk.SpeechSynthesizer(config, undefined);
    synthesizer.speakSsmlAsync(
      ssml,
      (result) => {
        synthesizer.close();
        if (result.reason !== sdk.ResultReason.SynthesizingAudioCompleted) {
          rejectP(new Error(`Azure Speech synthesis failed: ${result.errorDetails ?? result.reason}`));
          return;
        }
        const audio = Buffer.from(result.audioData);
        // audioDuration is in 100-nanosecond ticks; convert to milliseconds.
        const durationMs = Number(result.audioDuration) / 10_000;
        resolveP({ bytes: audio, durationMs });
      },
      (err) => {
        synthesizer.close();
        rejectP(new Error(`Azure Speech synthesis error: ${err}`));
      }
    );
  });
}
