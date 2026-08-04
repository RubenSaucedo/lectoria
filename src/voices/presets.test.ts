import { describe, it, expect } from 'vitest';
import {
  VOICE_PRESETS,
  DEFAULT_VOICE_PRESET,
  resolveVoicePreset,
} from './presets.js';

describe('resolveVoicePreset', () => {
  it('returns the default preset when no name is given', () => {
    const { name } = resolveVoicePreset();
    expect(name).toBe(DEFAULT_VOICE_PRESET);
  });

  it('treats an empty/whitespace name as the default', () => {
    expect(resolveVoicePreset('  ').name).toBe(DEFAULT_VOICE_PRESET);
  });

  it('resolves a known preset by name', () => {
    const { name, voices } = resolveVoicePreset('latino');
    expect(name).toBe('latino');
    expect(voices.host.es).toMatchObject({ name: 'es-MX-JorgeNeural' });
  });

  it('throws a readable error listing available presets for an unknown name', () => {
    expect(() => resolveVoicePreset('nope')).toThrowError(/Unknown voice preset "nope"/);
    expect(() => resolveVoicePreset('nope')).toThrowError(/espana/);
  });

  it('returns a deep clone so callers can mutate without corrupting the registry', () => {
    const a = resolveVoicePreset('espana').voices;
    (a.host.es as { name: string }).name = 'mutated';
    const b = resolveVoicePreset('espana').voices;
    expect((b.host.es as { name: string }).name).toBe('es-ES-AlvaroNeural');
  });

  it('ships the default espana preset as a measured Castilian male', () => {
    expect(VOICE_PRESETS.espana.host.es).toMatchObject({
      name: 'es-ES-AlvaroNeural',
      rate: '-6%',
    });
  });

  it('ships intermedio-femenino as the measured multilingual female counterpart', () => {
    expect(VOICE_PRESETS['intermedio-femenino'].host.es).toMatchObject({
      name: 'es-ES-XimenaMultilingualNeural',
      rate: '-4%',
    });
  });

  it('every preset voice avoids express-as styles (unsupported styles error the run)', () => {
    for (const map of Object.values(VOICE_PRESETS)) {
      for (const byLang of Object.values(map)) {
        for (const voice of Object.values(byLang)) {
          if (typeof voice !== 'string') expect(voice.style).toBeUndefined();
        }
      }
    }
  });
});
