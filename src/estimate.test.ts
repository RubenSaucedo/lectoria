import { describe, it, expect } from 'vitest';
import { estimateCost, DEFAULT_PRICING, pricingLastVerified } from './estimate.js';
import type { Document } from './types.js';

function fakeDoc(charsPerSection: number, sectionCount: number): Document {
  const para = 'x'.repeat(charsPerSection);
  return {
    id: 'fake',
    title: 'Fake',
    language: 'en',
    sourcePath: 'fake',
    sections: Array.from({ length: sectionCount }, (_, i) => ({
      heading: `S${i}`,
      paragraphs: [para],
    })),
    metadata: {
      sourceUri: 'file:///fake.md',
      sourceFormat: 'md',
      fetchedAt: '2026-06-18T00:00:00.000Z',
    },
  };
}

describe('DEFAULT_PRICING', () => {
  it('exposes positive numbers for every billing axis', () => {
    expect(DEFAULT_PRICING.openAiInputPer1M).toBeGreaterThan(0);
    expect(DEFAULT_PRICING.openAiOutputPer1M).toBeGreaterThan(0);
    expect(DEFAULT_PRICING.azureSpeechPer1M).toBeGreaterThan(0);
  });

  it('publishes a verification date so callers know how stale the snapshot is', () => {
    expect(pricingLastVerified).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('estimateCost', () => {
  it('returns positive totals for a non-empty document', async () => {
    const result = await estimateCost({ document: fakeDoc(1000, 3) });
    expect(result.total.scriptInputTokens).toBeGreaterThan(0);
    expect(result.total.scriptOutputTokens).toBeGreaterThan(0);
    expect(result.total.ttsCharacters).toBeGreaterThan(0);
    expect(result.total.audioMinutes).toBeGreaterThan(0);
    expect(result.total.usd.total).toBeGreaterThan(0);
  });

  it('adds cost for each additional target language', async () => {
    const doc = fakeDoc(1000, 3);
    const oneLang = await estimateCost({ document: doc, languages: ['en'] });
    const twoLangs = await estimateCost({ document: doc, languages: ['en', 'es'] });
    expect(twoLangs.total.usd.total).toBeGreaterThan(oneLang.total.usd.total);
    expect(twoLangs.languages).toHaveLength(2);
    expect(oneLang.languages).toHaveLength(1);
  });

  it('marks the source language as reusing the script (no translate call)', async () => {
    const result = await estimateCost({
      document: fakeDoc(500, 2),
      languages: ['en', 'es'],
    });
    const en = result.languages.find((l) => l.language === 'en')!;
    const es = result.languages.find((l) => l.language === 'es')!;
    expect(en.reusesSourceScript).toBe(true);
    expect(es.reusesSourceScript).toBe(false);
  });

  it('produces more TTS characters for podcast style than verbatim', async () => {
    const doc = fakeDoc(1000, 2);
    const verbatim = await estimateCost({ document: doc, style: { kind: 'verbatim' } });
    const podcast = await estimateCost({ document: doc, style: { kind: 'podcast' } });
    expect(podcast.total.ttsCharacters).toBeGreaterThan(verbatim.total.ttsCharacters);
  });

  it('always returns a non-empty assumptions array so callers can show caveats', async () => {
    const result = await estimateCost({ document: fakeDoc(100, 1) });
    expect(result.assumptions.length).toBeGreaterThan(0);
    expect(result.assumptions.every((s) => typeof s === 'string' && s.length > 0)).toBe(true);
  });

  it('honors a custom pricing override', async () => {
    const doc = fakeDoc(1000, 2);
    const cheap = await estimateCost({ document: doc }, { pricing: { azureSpeechPer1M: 1 } });
    const expensive = await estimateCost({ document: doc }, { pricing: { azureSpeechPer1M: 100 } });
    expect(expensive.total.usd.tts).toBeGreaterThan(cheap.total.usd.tts);
  });

  it('throws when neither source nor document is provided', async () => {
    await expect(estimateCost({} as never)).rejects.toThrow();
  });
});
