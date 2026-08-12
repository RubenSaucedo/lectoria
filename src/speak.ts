import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DEFAULT_PRICING, pricingLastVerified, type PricingTable } from './estimate.js';
import { VOICE_PRESETS } from './voices/presets.js';
import type { LectoriaAuth } from './azure-auth.js';

/**
 * Support for `lectoria speak` — one line of text in, one audio file and a
 * **measured** duration out.
 *
 * Why this exists separately from `run`
 * ------------------------------------
 * `run` is the document-to-podcast pipeline: ingest, parse, generate a script
 * with a model, translate, synthesise, package, publish. Consumers who already
 * have the exact words they want spoken need none of that, and paying an LLM to
 * rewrite text they already authored is both expensive and wrong.
 *
 * The motivating consumer is a video narration tool that must place speech
 * against a recording. It needs one thing the library already computes and the
 * CLI never exposed: **how long the audio actually turned out to be**, measured
 * from the synthesiser rather than guessed from a word count.
 *
 * The logic lives here rather than in `cli.ts` so it can be tested without
 * spawning commander or reaching Azure.
 */

/** Exit codes. Distinct values so a caller can branch without parsing prose. */
export const EXIT = {
  ok: 0,
  /** Bad input: no text, both text flags, an unusable voice. Retrying is pointless. */
  usage: 1,
  /** Azure is not configured on this machine. Nothing was attempted, nothing billed. */
  notConfigured: 2,
  /** Configured, attempted, and the call failed. May be worth retrying; may not. */
  failed: 3,
} as const;

export type SpeakFailureReason = 'usage' | 'not-configured' | 'synthesis-failed';

/**
 * An error carrying a machine-readable reason. The distinction that matters to
 * a caller is "you have not set this up" versus "the paid call failed", because
 * the first is a one-time fix by a human and the second may be transient.
 */
export class SpeakError extends Error {
  readonly reason: SpeakFailureReason;
  readonly exitCode: number;
  constructor(reason: SpeakFailureReason, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SpeakError';
    this.reason = reason;
    this.exitCode =
      reason === 'not-configured' ? EXIT.notConfigured
        : reason === 'synthesis-failed' ? EXIT.failed
          : EXIT.usage;
  }
}

/**
 * Reads the text to speak from exactly one source.
 *
 * `--text-file` exists because `--text` does not survive a Windows shell: a
 * narration line containing quotes, apostrophes or newlines is mangled by
 * cmd.exe and PowerShell quoting long before it reaches this process. A file
 * has no such problem, and the caller was going to write the line down anyway.
 */
export async function resolveText(opts: { text?: string; textFile?: string }): Promise<string> {
  const hasText = typeof opts.text === 'string';
  const hasFile = typeof opts.textFile === 'string';
  if (hasText && hasFile) {
    throw new SpeakError('usage', 'Pass either --text or --text-file, not both.');
  }
  if (!hasText && !hasFile) {
    throw new SpeakError(
      'usage',
      'Nothing to speak. Pass --text "..." or --text-file <path>. Prefer --text-file when the line contains quotes or newlines.'
    );
  }

  let text: string;
  if (hasFile) {
    const absolute = resolve(opts.textFile!);
    try {
      text = await readFile(absolute, 'utf-8');
    } catch (err) {
      throw new SpeakError('usage', `--text-file "${opts.textFile}" could not be read: ${(err as Error).message}`, { cause: err });
    }
  } else {
    text = opts.text!;
  }

  const trimmed = text.trim();
  if (!trimmed) {
    // Synthesising nothing bills for the request and returns a zero duration,
    // which downstream would happily place as a real beat. Refuse instead.
    throw new SpeakError(
      'usage',
      hasFile
        ? `--text-file "${opts.textFile}" is empty. There is nothing to synthesise, and an empty request still costs a call.`
        : '--text is empty. There is nothing to synthesise, and an empty request still costs a call.'
    );
  }
  return trimmed;
}

/**
 * `speak --voice` takes a **raw Azure voice id**, not one of the presets that
 * `run --voice` accepts. The two are genuinely different things — a preset maps
 * roles and languages to voices for a multi-speaker script, and a single line
 * has neither a role nor a cast — but the flag name is shared, so a caller will
 * eventually pass a preset here. Detect that exact mistake and say what to do,
 * rather than forwarding "espana" to Azure as a voice id and reporting whatever
 * the service says about it.
 */
export function resolveVoice(voice: string | undefined, env = process.env): string {
  const chosen = voice ?? env.LECTORIA_SPEAK_VOICE;
  if (!chosen) {
    throw new SpeakError(
      'usage',
      'No voice. Pass --voice <azure-voice-id> (e.g. en-US-AvaMultilingualNeural) or set LECTORIA_SPEAK_VOICE.'
    );
  }
  const preset = VOICE_PRESETS[chosen];
  if (preset) {
    const example = firstVoiceName(preset);
    throw new SpeakError(
      'usage',
      `"${chosen}" is a voice preset, which is what \`run --voice\` takes. \`speak\` synthesises a single line, so it needs one Azure voice id${example ? ` — the ${chosen} preset uses ${example}` : ''}. Run \`lectoria voices\` to see them all.`
    );
  }
  return chosen;
}

function firstVoiceName(preset: Record<string, Record<string, unknown>>): string | undefined {
  for (const byLang of Object.values(preset)) {
    for (const value of Object.values(byLang)) {
      if (typeof value === 'string') return value;
      const spec = value as { name?: string };
      if (spec?.name) return spec.name;
    }
  }
  return undefined;
}

export interface SpeechEnv {
  region: string;
  resourceId?: string;
  auth: LectoriaAuth;
  /** How auth was resolved, so `--json` output can say it without leaking the key. */
  authKind: 'apiKey' | 'default';
}

/**
 * Resolves Azure Speech configuration from the environment.
 *
 * This deliberately does **not** go through `loadConfig()`. That builds the
 * whole pipeline config and requires an Azure OpenAI endpoint and a Speech
 * resource id, none of which a single synthesis call needs — with an API key,
 * a resource id is not used at all. Requiring them would refuse to speak on a
 * machine that is perfectly capable of speaking.
 *
 * Anything missing here is `not-configured`, never `failed`: nothing was
 * attempted, so nothing was billed, and the fix is a human setting a variable.
 */
export function resolveSpeechEnv(env = process.env): SpeechEnv {
  const region = env.AZURE_SPEECH_REGION?.trim();
  const apiKey = env.AZURE_SPEECH_KEY?.trim();
  const resourceId = env.AZURE_SPEECH_RESOURCE_ID?.trim();

  if (!region) {
    throw new SpeakError(
      'not-configured',
      'AZURE_SPEECH_REGION is not set, so no Speech resource can be reached. Set it (e.g. eastus), plus either AZURE_SPEECH_KEY, or AZURE_SPEECH_RESOURCE_ID with `az login`. Nothing was attempted and nothing was billed.'
    );
  }
  if (apiKey) return { region, auth: { kind: 'apiKey', apiKey }, authKind: 'apiKey' };
  if (!resourceId) {
    throw new SpeakError(
      'not-configured',
      'No Speech credentials. Set AZURE_SPEECH_KEY, or set AZURE_SPEECH_RESOURCE_ID (the full /subscriptions/... id) and sign in with `az login` so DefaultAzureCredential can mint a token. Nothing was attempted and nothing was billed.'
    );
  }
  return { region, resourceId, auth: { kind: 'default' }, authKind: 'default' };
}

export interface SpeakEstimate {
  characters: number;
  voice: string;
  /**
   * Named `estimatedDurationSec`, and **never** `durationSec`, on purpose.
   * A real speak result carries a duration measured by the synthesiser. If the
   * estimate used the same key, a caller reading `.durationSec` would silently
   * receive a guess with a ±20% error and place narration against it. A
   * different key turns that into an immediate, loud failure.
   */
  estimatedDurationSec: number;
  estimatedUsd: number;
  pricing: { azureSpeechPer1M: number; lastVerified: string };
  estimated: true;
  assumptions: string[];
}

/** Characters per minute of speech, matching the assumption `estimateCost` uses. */
const CHARS_PER_MINUTE = 900;

/**
 * Projects what a `speak` call would cost and roughly how long it would run,
 * **without contacting Azure**. This is what makes a consent prompt possible:
 * a caller can show a number before anyone is billed.
 *
 * It does not reuse `estimateCost()`, which is document-shaped — it ingests and
 * parses a file and prices script generation and translation through Azure
 * OpenAI. `speak` does none of that. Routing through it would report a cost for
 * work this command will never do.
 */
export function estimateSpeak(
  text: string,
  voice: string,
  opts: { pricing?: Partial<PricingTable> } = {}
): SpeakEstimate {
  const pricing = { ...DEFAULT_PRICING, ...opts.pricing };
  const characters = text.length;
  return {
    characters,
    voice,
    estimatedDurationSec: (characters / CHARS_PER_MINUTE) * 60,
    estimatedUsd: (characters / 1_000_000) * pricing.azureSpeechPer1M,
    pricing: { azureSpeechPer1M: pricing.azureSpeechPer1M, lastVerified: pricingLastVerified },
    estimated: true,
    assumptions: [
      'Billed characters counted from the trimmed input text. SSML wrapping adds a few percent, ignored here.',
      `Duration assumes ~150 spoken words per minute (~${CHARS_PER_MINUTE} chars/min). Voice, language and punctuation shift this by 10-20%, and code, acronyms and URLs read slower than prose.`,
      'The duration is a projection. Only synthesis reports the real one, which is why this field is not called durationSec.',
      `Pricing: Azure list price snapshotted ${pricingLastVerified}. Not a quote; verify at https://azure.microsoft.com/pricing/.`,
    ],
  };
}

export interface SpeakOutput {
  path: string;
  /** Measured by the synthesiser from the returned audio, not estimated. */
  durationSec: number;
  characters: number;
  voice: string;
  language: string;
  region: string;
  authKind: 'apiKey' | 'default';
  estimated: false;
}

/**
 * Turns an error from the synthesis call into one carrying `synthesis-failed`,
 * so the caller can tell it apart from a machine that was never set up.
 *
 * A 401 is deliberately reported as a failure rather than as not-configured:
 * credentials exist, they were used, and the service rejected them. Calling
 * that "not configured" would send someone to set variables that are already
 * set. The message names the likelier causes instead.
 */
export function asSynthesisFailure(error: unknown): SpeakError {
  const message = error instanceof Error ? error.message : String(error);
  if (/401|unauthor|forbidden|403/i.test(message)) {
    return new SpeakError(
      'synthesis-failed',
      `Azure rejected the credentials: ${message}. They are present but not accepted — check the key matches the region, that the resource id is the right resource, and that the signed-in principal holds "Cognitive Services User".`,
      { cause: error }
    );
  }
  // The Speech SDK reaches the service over a WebSocket, and a **rejected key**
  // surfaces as an abnormal close (1006, "Unable to contact server") rather than
  // as a 401. Verified against the live service with a deliberately invalid key.
  // Taken at face value that message sends people to debug their network when
  // the real problem is a wrong key or the wrong region for the key.
  //
  // It is genuinely ambiguous — the same close code appears when the host is
  // unreachable — so this does not claim which one it is. It says both, in the
  // order they are likely, because the error itself does not know.
  if (/1006|unable to contact server|websocket/i.test(message)) {
    return new SpeakError(
      'synthesis-failed',
      `The connection to Azure Speech closed without an answer: ${message}\nThis message is the same for a rejected credential and for an unreachable network, so it does not say which. In order of likelihood: the key or token is wrong, the key belongs to a different region than AZURE_SPEECH_REGION, the resource id names another resource, or the host cannot reach the endpoint. Nothing was synthesised; whether the attempt was billed is up to Azure, but a rejected request is not.`,
      { cause: error }
    );
  }
  return new SpeakError('synthesis-failed', `Synthesis failed: ${message}`, { cause: error });
}

export function formatEstimate(estimate: SpeakEstimate): string {
  return [
    `${estimate.characters} characters, voice ${estimate.voice}`,
    `~${estimate.estimatedDurationSec.toFixed(1)}s of audio, ~$${estimate.estimatedUsd.toFixed(4)}`,
    'Estimate only. No call was made and nothing was billed.',
  ].join('\n');
}

export function formatResult(result: SpeakOutput): string {
  return `${result.path}\t${result.durationSec.toFixed(3)}s\t${result.characters} chars\t${result.voice}`;
}
