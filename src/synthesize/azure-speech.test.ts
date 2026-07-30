import { describe, it, expect } from 'vitest';
import { renderUtteranceText, ssmlForSegment } from './azure-speech.js';
import type { PodcastSegment, VoiceMap } from '../types.js';

describe('renderUtteranceText', () => {
  it('xml-escapes plain text with no markers', () => {
    expect(renderUtteranceText('Tom & Jerry <3', 'es')).toBe('Tom &amp; Jerry &lt;3');
  });

  it('converts [[en]]…[[/en]] markers into <lang xml:lang="en-US"> SSML when narrating in Spanish', () => {
    expect(
      renderUtteranceText('Hoy hablamos de [[en]]MCP[[/en]] y [[en]]HubSpot[[/en]].', 'es')
    ).toBe(
      'Hoy hablamos de <lang xml:lang="en-US">MCP</lang> y <lang xml:lang="en-US">HubSpot</lang>.'
    );
  });

  it('also wraps multi-token spans like "ADO 5417982"', () => {
    expect(renderUtteranceText('El bug [[en]]ADO 5417982[[/en]] sigue abierto.', 'es')).toBe(
      'El bug <lang xml:lang="en-US">ADO 5417982</lang> sigue abierto.'
    );
  });

  it('strips markers (no <lang> wrap) when the script language is already English', () => {
    expect(renderUtteranceText('Today we are talking about [[en]]MCP[[/en]].', 'en')).toBe(
      'Today we are talking about MCP.'
    );
  });

  it('treats en-US, en-GB, etc. as English for the purposes of stripping markers', () => {
    expect(renderUtteranceText('See [[en]]API[[/en]] docs.', 'en-US')).toBe('See API docs.');
  });

  it('xml-escapes inside the marked span too', () => {
    expect(renderUtteranceText('Use [[en]]A & B[[/en]] together.', 'es')).toBe(
      'Use <lang xml:lang="en-US">A &amp; B</lang> together.'
    );
  });

  it('leaves a malformed (unclosed) marker as literal escaped text', () => {
    // Without a matching [[/en]] the marker is meaningless; we must not
    // emit half a <lang> tag.
    expect(renderUtteranceText('Stray [[en]]MCP without close', 'es')).toBe(
      'Stray [[en]]MCP without close'
    );
  });

  it('handles back-to-back markers without losing spacing', () => {
    expect(renderUtteranceText('[[en]]CCA[[/en]] [[en]]DA[[/en]]', 'es')).toBe(
      '<lang xml:lang="en-US">CCA</lang> <lang xml:lang="en-US">DA</lang>'
    );
  });

  it('is idempotent across successive calls (resets regex state)', () => {
    const input = 'Use [[en]]API[[/en]] here.';
    const expected = 'Use <lang xml:lang="en-US">API</lang> here.';
    expect(renderUtteranceText(input, 'es')).toBe(expected);
    expect(renderUtteranceText(input, 'es')).toBe(expected);
    expect(renderUtteranceText(input, 'es')).toBe(expected);
  });
});

describe('ssmlForSegment', () => {
  const seg = (utterances: PodcastSegment['utterances']): PodcastSegment => ({
    kind: 'body',
    utterances,
  });

  it('renders a bare string voice with a neutral prosody and no mstts namespace', () => {
    const voices: VoiceMap = { host: { es: 'es-ES-AlvaroNeural' } };
    const out = ssmlForSegment('es', voices, seg([{ voice: 'host', text: 'Hola' }]));
    expect(out).toContain('xml:lang="es"');
    expect(out).not.toContain('xmlns:mstts');
    expect(out).toContain('<voice name="es-ES-AlvaroNeural"><prosody rate="0%">Hola');
  });

  it('applies rate and pitch from a VoiceSpec', () => {
    const voices: VoiceMap = { host: { es: { name: 'es-ES-AlvaroNeural', rate: '-6%', pitch: '+2%' } } };
    const out = ssmlForSegment('es', voices, seg([{ voice: 'host', text: 'Hola' }]));
    expect(out).toContain('<prosody rate="-6%" pitch="+2%">Hola');
  });

  it('wraps a styled voice in mstts:express-as and declares the namespace', () => {
    const voices: VoiceMap = { host: { en: { name: 'en-US-AriaNeural', style: 'cheerful', styleDegree: 1.5 } } };
    const out = ssmlForSegment('en', voices, seg([{ voice: 'host', text: 'Hi' }]));
    expect(out).toContain('xmlns:mstts="http://www.w3.org/2001/mstts"');
    expect(out).toContain('<mstts:express-as style="cheerful" styledegree="1.5"><prosody rate="0%">Hi');
    expect(out).toContain('</prosody></mstts:express-as></voice>');
  });

  it('merges consecutive utterances that share a voice into one block, splits on change', () => {
    const voices: VoiceMap = {
      host: { es: { name: 'es-ES-AlvaroNeural', rate: '-6%' } },
      guest: { es: { name: 'es-ES-DarioNeural', rate: '-4%' } },
    };
    const out = ssmlForSegment(
      'es',
      voices,
      seg([
        { voice: 'host', text: 'Uno' },
        { voice: 'host', text: 'Dos' },
        { voice: 'guest', text: 'Tres' },
      ])
    );
    expect((out.match(/<voice /g) ?? []).length).toBe(2);
    expect(out).toContain('es-ES-AlvaroNeural');
    expect(out).toContain('es-ES-DarioNeural');
  });

  it('falls back to the host voice for an unmapped speaker id', () => {
    const voices: VoiceMap = { host: { es: 'es-ES-AlvaroNeural' } };
    const out = ssmlForSegment('es', voices, seg([{ voice: 'narrator', text: 'Hola' }]));
    expect(out).toContain('es-ES-AlvaroNeural');
  });
});
