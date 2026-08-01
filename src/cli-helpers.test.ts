import { describe, it, expect } from 'vitest';
import {
  exitCodeForItemFailures,
  parseCostAwarenessMode,
  parseNonNegativeNumber,
  parseStyle,
  parseSpeakers,
} from './cli-helpers.js';

describe('parseStyle', () => {
  it('defaults to conversational when no style is passed', () => {
    expect(parseStyle(undefined, undefined)).toEqual({ kind: 'conversational' });
  });

  it.each([
    ['podcast'],
    ['verbatim'],
    ['conversational'],
  ] as const)('returns plain style for "%s"', (kind) => {
    expect(parseStyle(kind, undefined)).toEqual({ kind });
  });

  it('returns dialogue with default cast when --style dialogue and no --speakers', () => {
    const result = parseStyle('dialogue', undefined);
    expect(result.kind).toBe('dialogue');
    if (result.kind !== 'dialogue') throw new Error('narrowing');
    expect(result.speakers).toEqual([
      { id: 'host', name: 'Ava' },
      { id: 'guest', name: 'Jorge' },
    ]);
  });

  it('returns dialogue with custom cast when --speakers provided', () => {
    const result = parseStyle('dialogue', 'a:Anna,b:Bert');
    expect(result.kind).toBe('dialogue');
    if (result.kind !== 'dialogue') throw new Error('narrowing');
    expect(result.speakers).toEqual([
      { id: 'a', name: 'Anna' },
      { id: 'b', name: 'Bert' },
    ]);
  });

  it('rejects --speakers without --style dialogue', () => {
    expect(() => parseStyle('conversational', 'a:A,b:B')).toThrow(
      /--speakers is only valid when --style dialogue/
    );
  });

  it('rejects an unknown style', () => {
    expect(() => parseStyle('whisper', undefined)).toThrow(/Unknown --style "whisper"/);
  });
});

describe('parseSpeakers', () => {
  it('returns default cast when input is undefined', () => {
    expect(parseSpeakers(undefined)).toEqual([
      { id: 'host', name: 'Ava' },
      { id: 'guest', name: 'Jorge' },
    ]);
  });

  describe('cost CLI parsing', () => {
    it('accepts supported cost-awareness modes', () => {
      expect(parseCostAwarenessMode('off')).toBe('off');
      expect(parseCostAwarenessMode('warn')).toBe('warn');
      expect(parseCostAwarenessMode('require-approval')).toBe('require-approval');
    });

    it('rejects unknown modes and invalid thresholds', () => {
      expect(() => parseCostAwarenessMode('always')).toThrow(/Unknown cost-awareness mode/);
      expect(() => parseNonNegativeNumber('-1', '--max-estimated-usd')).toThrow(
        /greater than or equal to zero/
      );
      expect(parseNonNegativeNumber('1.25', '--max-estimated-usd')).toBe(1.25);
    });
  });

  describe('exitCodeForItemFailures', () => {
    it('returns failure when a continued item fails', () => {
      expect(exitCodeForItemFailures(0)).toBe(0);
      expect(exitCodeForItemFailures(1)).toBe(1);
    });
  });

  it('accepts id-only entries without a name', () => {
    expect(parseSpeakers('host,guest')).toEqual([{ id: 'host' }, { id: 'guest' }]);
  });

  it('trims whitespace around entries and names', () => {
    expect(parseSpeakers(' host : Ava , guest : Jorge ')).toEqual([
      { id: 'host', name: 'Ava' },
      { id: 'guest', name: 'Jorge' },
    ]);
  });

  it('rejects fewer than two speakers', () => {
    expect(() => parseSpeakers('solo:Ava')).toThrow(/at least two entries/);
  });

  it('rejects an entry with no id', () => {
    expect(() => parseSpeakers('host:Ava,:Jorge')).toThrow(/Invalid --speakers entry/);
  });
});
