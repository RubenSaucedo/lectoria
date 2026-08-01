import type { VoiceMap } from '../types.js';

/**
 * Named voice presets — a bundle of `host`/`guest` voices per language, with
 * optional delivery tuning (pace, style). Pick one with the `--voice` CLI flag
 * or the `LECTORIA_VOICE_PRESET` env var; per-role env overrides
 * (`LECTORIA_VOICE_ES`, …) still layer on top.
 *
 * Presets lean on **voice choice + measured pace** (universally supported via
 * `<prosody rate>`) rather than `<mstts:express-as>` styles, because most
 * Spanish neural voices support few or no styles and an unsupported style
 * errors the whole synthesis run. Rate is a percentage; negative is slower.
 */
export const VOICE_PRESETS: Record<string, VoiceMap> = {
  /**
   * Warm, measured, peninsular-Castilian narration — modeled on the delivery
   * of Spanish book-summary podcasts (clear diction, unhurried pace, didactic
   * tone). Álvaro is an inherently warm Castilian male; a slightly slower rate
   * gives the "pausado" cadence that makes dense material easy to follow.
   * (Álvaro supports only `cheerful`/`sad` styles, neither of which fits a
   * neutral didactic read, so no express-as style is applied.)
   */
  espana: {
    host: {
      es: { name: 'es-ES-AlvaroNeural', rate: '-6%' },
      en: { name: 'en-US-AndrewMultilingualNeural', rate: '-4%' },
    },
    guest: {
      es: { name: 'es-ES-DarioNeural', rate: '-4%' },
      en: { name: 'en-US-BrianMultilingualNeural', rate: '-2%' },
    },
  },

  /**
   * Neutral Latin-American variation — the same measured, friendly read in
   * Mexican Spanish for listeners who prefer a Latin-American accent. Jorge's
   * natural cadence is slower, so it runs a touch faster (+5%/+7%) to feel as
   * lively as the Castilian presets.
   */
  latino: {
    host: {
      es: { name: 'es-MX-JorgeNeural', rate: '+5%' },
      en: { name: 'en-US-AndrewMultilingualNeural', rate: '-3%' },
    },
    guest: {
      es: { name: 'es-MX-GerardoNeural', rate: '+7%' },
      en: { name: 'en-US-BrianMultilingualNeural' },
    },
  },

  /**
   * "In between" Castilian and Latin-American — a multilingual voice whose
   * Spanish is less regionally marked, for a more international feel.
   */
  intermedio: {
    host: {
      es: { name: 'es-ES-TristanMultilingualNeural', rate: '-4%' },
      en: { name: 'en-US-AndrewMultilingualNeural', rate: '-4%' },
    },
    guest: {
      es: { name: 'es-ES-DarioNeural', rate: '-2%' },
      en: { name: 'en-US-BrianMultilingualNeural' },
    },
  },

  /**
   * Female counterpart to `intermedio`: Ximena's multilingual Spanish keeps
   * the same broadly international character and measured pace as Tristan.
   */
  'intermedio-femenino': {
    host: {
      es: { name: 'es-ES-XimenaMultilingualNeural', rate: '-4%' },
      en: { name: 'en-US-AvaMultilingualNeural', rate: '-4%' },
    },
    guest: {
      es: { name: 'es-ES-ElviraNeural', rate: '-2%' },
      en: { name: 'en-US-JennyNeural' },
    },
  },
};

/** The preset used when none is requested. */
export const DEFAULT_VOICE_PRESET = 'espana';

/**
 * Resolve a preset name to a fresh (deep-cloned) VoiceMap. Falls back to the
 * default preset when `name` is undefined/empty; throws a readable error with
 * the available preset names when `name` is unknown.
 */
export function resolveVoicePreset(name?: string): { name: string; voices: VoiceMap } {
  const key = name?.trim() || DEFAULT_VOICE_PRESET;
  const voices = VOICE_PRESETS[key];
  if (!voices) {
    const known = Object.keys(VOICE_PRESETS).join(', ');
    throw new Error(`Unknown voice preset "${key}". Available presets: ${known}.`);
  }
  return { name: key, voices: structuredClone(voices) };
}
