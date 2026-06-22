import { describe, it, expect } from 'vitest';
import { renderUtteranceText } from './azure-speech.js';

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
