import type { LanguageCode, PodcastScript, ScriptStyle, VoiceMap } from './types.js';

export function normalizeLanguageCodes(
  values: readonly string[],
  label = 'target languages'
): LanguageCode[] {
  if (values.length === 0) throw new Error(`${label} must contain at least one language code.`);
  const normalized: LanguageCode[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) throw new Error(`${label} contains an empty language code.`);
    let canonical: string;
    try {
      canonical = Intl.getCanonicalLocales(trimmed)[0] ?? '';
    } catch {
      throw new Error(`Invalid language code "${value}" in ${label}. Use a BCP-47 code such as en, es, or es-MX.`);
    }
    if (!canonical) throw new Error(`Invalid language code "${value}" in ${label}.`);
    const key = canonical.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(canonical);
  }
  if (normalized.length === 0) throw new Error(`${label} must contain at least one language code.`);
  return normalized;
}

export function requiredSpeakers(style: ScriptStyle): string[] {
  const speakers = style.kind === 'dialogue' ? style.speakers.map((speaker) => speaker.id) : ['host'];
  const normalized = speakers.map((speaker) => speaker.trim()).filter(Boolean);
  const unique = new Set(normalized);
  if (unique.size !== normalized.length) {
    throw new Error(`Script style contains duplicate speaker IDs: ${normalized.join(', ')}.`);
  }
  if (unique.size === 0) throw new Error('Script style must configure at least one speaker.');
  return [...unique];
}

export function validateVoiceCoverage(
  voices: VoiceMap,
  languages: readonly LanguageCode[],
  speakers: readonly string[]
): void {
  const missing: string[] = [];
  for (const speaker of speakers) {
    for (const language of languages) {
      if (!voices[speaker]?.[language]) missing.push(`${speaker}:${language}`);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `Voice configuration is missing ${missing.join(', ')}. Configure every requested speaker and language before starting Azure calls.`
    );
  }
}

export function validateScriptVoiceCoverage(script: PodcastScript, voices: VoiceMap): void {
  const speakers = new Set<string>();
  for (const segment of script.segments) {
    for (const utterance of segment.utterances) speakers.add(utterance.voice ?? 'host');
  }
  validateVoiceCoverage(voices, [script.language], [...speakers]);
}
