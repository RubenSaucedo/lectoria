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
 * Resolves the provider voice id for a given logical speaker + language.
 * Falls back to `host` when `voiceKey` is missing or unmapped — so existing
 * single-voice scripts (every utterance with voice="host" or voice undefined)
 * keep working unchanged.
 *
 * Throws when even `host` is not configured for `language`, with a message
 * that lists what IS configured so the caller can fix their VoiceMap fast.
 */
function resolveVoice(language: string, voices: VoiceMap, voiceKey: string | undefined): string {
  const key = voiceKey ?? 'host';
  const candidate = voices[key]?.[language];
  if (candidate) return candidate;

  // Explicit speaker id requested but unmapped — surface what IS available
  // so the caller can either add the mapping or fix the speaker id.
  if (key !== 'host') {
    const fallback = voices.host?.[language];
    if (fallback) return fallback;
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

function ssmlForSegment(
  language: string,
  voices: VoiceMap,
  segment: PodcastSegment
): string {
  // Cache resolved provider voice ids per speaker key inside this segment so
  // we don't repeat the lookup for every utterance.
  const voiceCache = new Map<string, string>();
  const voiceFor = (speakerKey: string | undefined): string => {
    const key = speakerKey ?? 'host';
    const cached = voiceCache.get(key);
    if (cached) return cached;
    const resolved = resolveVoice(language, voices, key);
    voiceCache.set(key, resolved);
    return resolved;
  };

  // Group consecutive utterances by speaker so each voice block synthesises
  // multiple utterances in one shot — cleaner audio than restarting the
  // voice for every line.
  const runs: Array<{ voiceId: string; body: string }> = [];
  for (const u of segment.utterances) {
    const voiceId = voiceFor(u.voice);
    const safeText = escapeXml(u.text);
    const pause = u.pauseAfterMs ? `<break time="${u.pauseAfterMs}ms"/>` : '';
    const fragment = `${safeText} ${pause}`;
    const last = runs[runs.length - 1];
    if (last && last.voiceId === voiceId) {
      last.body += ` ${fragment}`;
    } else {
      runs.push({ voiceId, body: fragment });
    }
  }

  const voiceBlocks = runs
    .map((r) => `<voice name="${r.voiceId}"><prosody rate="0%">${r.body}</prosody></voice>`)
    .join('');

  return [
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${language}">`,
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
