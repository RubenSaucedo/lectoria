import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EXIT,
  SpeakError,
  asSynthesisFailure,
  estimateSpeak,
  formatEstimate,
  resolveSpeechEnv,
  resolveText,
  resolveVoice,
} from './speak.js';

async function tempFileWith(contents: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'lectoria-speak-'));
  const path = join(dir, 'line.txt');
  await writeFile(path, contents, 'utf-8');
  return path;
}

async function reasonOf(fn: () => unknown | Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof SpeakError) return err.reason;
    return `not-a-SpeakError: ${(err as Error).message}`;
  }
  return 'nothing-thrown';
}

describe('resolveText', () => {
  it('reads the text from a file, which is the only form that survives a Windows shell', async () => {
    const path = await tempFileWith('He said "no", then left.\nTwice.');
    await expect(resolveText({ textFile: path })).resolves.toBe('He said "no", then left.\nTwice.');
  });

  it('takes text inline', async () => {
    await expect(resolveText({ text: 'Hello.' })).resolves.toBe('Hello.');
  });

  it('trims surrounding whitespace, so a trailing newline in a file is not billed as content', async () => {
    const path = await tempFileWith('  Create an issue.\n\n');
    await expect(resolveText({ textFile: path })).resolves.toBe('Create an issue.');
  });

  it('refuses both sources at once rather than silently preferring one', async () => {
    expect(await reasonOf(() => resolveText({ text: 'a', textFile: 'b.txt' }))).toBe('usage');
  });

  it('refuses when neither source is given', async () => {
    expect(await reasonOf(() => resolveText({}))).toBe('usage');
  });

  it('refuses empty text: an empty request still costs a call and returns a zero duration that downstream would place as a real beat', async () => {
    const path = await tempFileWith('   \n  ');
    expect(await reasonOf(() => resolveText({ textFile: path }))).toBe('usage');
    expect(await reasonOf(() => resolveText({ text: '' }))).toBe('usage');
  });

  it('reports an unreadable file as usage, not as a synthesis failure', async () => {
    expect(await reasonOf(() => resolveText({ textFile: join(tmpdir(), 'definitely-not-here.txt') }))).toBe('usage');
  });
});

describe('resolveVoice', () => {
  it('accepts a raw Azure voice id', () => {
    expect(resolveVoice('en-US-AvaMultilingualNeural', {})).toBe('en-US-AvaMultilingualNeural');
  });

  it('falls back to LECTORIA_SPEAK_VOICE', () => {
    expect(resolveVoice(undefined, { LECTORIA_SPEAK_VOICE: 'es-ES-ElviraNeural' })).toBe('es-ES-ElviraNeural');
  });

  it('refuses a preset name, because `run --voice` takes presets and the shared flag name invites the mistake', () => {
    let message = '';
    try {
      resolveVoice('espana', {});
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('preset');
    // It must name a concrete voice from that preset, so the fix is obvious
    // rather than another lookup.
    expect(message).toMatch(/[a-z]{2}-[A-Z]{2}-\w+Neural/);
  });

  it('says how to supply a voice when none is given', () => {
    expect(() => resolveVoice(undefined, {})).toThrow(/LECTORIA_SPEAK_VOICE/);
  });
});

describe('resolveSpeechEnv', () => {
  it('prefers an API key when one is present', () => {
    const env = resolveSpeechEnv({ AZURE_SPEECH_REGION: 'eastus', AZURE_SPEECH_KEY: 'k' });
    expect(env.authKind).toBe('apiKey');
    expect(env.region).toBe('eastus');
  });

  it('does not require a resource id for key auth, because the key path never uses one', () => {
    expect(() => resolveSpeechEnv({ AZURE_SPEECH_REGION: 'eastus', AZURE_SPEECH_KEY: 'k' })).not.toThrow();
  });

  it('falls back to DefaultAzureCredential when a resource id is set', () => {
    const env = resolveSpeechEnv({ AZURE_SPEECH_REGION: 'eastus', AZURE_SPEECH_RESOURCE_ID: '/subscriptions/x' });
    expect(env.authKind).toBe('default');
    expect(env.resourceId).toBe('/subscriptions/x');
  });

  it('reports a missing region as not-configured, which is distinct from a failed call', async () => {
    expect(await reasonOf(() => resolveSpeechEnv({}))).toBe('not-configured');
  });

  it('reports missing credentials as not-configured and states that nothing was billed', () => {
    try {
      resolveSpeechEnv({ AZURE_SPEECH_REGION: 'eastus' });
      throw new Error('expected a refusal');
    } catch (err) {
      expect((err as SpeakError).reason).toBe('not-configured');
      expect((err as Error).message).toContain('nothing was billed');
    }
  });

  it('treats whitespace-only variables as unset rather than trying to authenticate with them', async () => {
    expect(await reasonOf(() => resolveSpeechEnv({ AZURE_SPEECH_REGION: '   ' }))).toBe('not-configured');
  });

  it('maps each reason to its own exit code so a caller can branch without parsing prose', () => {
    expect(new SpeakError('usage', 'x').exitCode).toBe(EXIT.usage);
    expect(new SpeakError('not-configured', 'x').exitCode).toBe(EXIT.notConfigured);
    expect(new SpeakError('synthesis-failed', 'x').exitCode).toBe(EXIT.failed);
  });
});

describe('estimateSpeak', () => {
  const text = 'Create an issue directly from the repository page.';

  it('never emits durationSec, so a caller reading that field cannot silently receive a guess', () => {
    const estimate = estimateSpeak(text, 'en-US-AvaMultilingualNeural');
    expect(estimate).not.toHaveProperty('durationSec');
    expect(estimate.estimatedDurationSec).toBeGreaterThan(0);
    expect(estimate.estimated).toBe(true);
  });

  it('counts the characters it would be billed for', () => {
    expect(estimateSpeak(text, 'v').characters).toBe(text.length);
  });

  it('scales cost linearly with length, because Azure Speech bills per character', () => {
    const one = estimateSpeak('a'.repeat(1000), 'v');
    const two = estimateSpeak('a'.repeat(2000), 'v');
    expect(two.estimatedUsd).toBeCloseTo(one.estimatedUsd * 2, 10);
  });

  it('accepts a pricing override, since the built-in table is a dated snapshot rather than a quote', () => {
    const overridden = estimateSpeak('a'.repeat(1_000_000), 'v', { pricing: { azureSpeechPer1M: 30 } });
    expect(overridden.estimatedUsd).toBeCloseTo(30, 6);
    expect(overridden.pricing.azureSpeechPer1M).toBe(30);
  });

  it('carries the date its prices were verified, because Azure changes them', () => {
    expect(estimateSpeak(text, 'v').pricing.lastVerified).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('states that the duration is a projection and that only synthesis knows the real one', () => {
    const assumptions = estimateSpeak(text, 'v').assumptions.join(' ');
    expect(assumptions).toContain('durationSec');
    expect(assumptions).toMatch(/projection/i);
  });

  it('says plainly that nothing was billed', () => {
    expect(formatEstimate(estimateSpeak(text, 'v'))).toContain('nothing was billed');
  });
});

describe('asSynthesisFailure', () => {
  it('classifies a rejected credential as a failure, not as an unconfigured machine', () => {
    // The variables are set and were used; the service said no. Calling that
    // "not configured" would send someone to set what is already set.
    const err = asSynthesisFailure(new Error('WebSocket upgrade failed: 401 Unauthorized'));
    expect(err.reason).toBe('synthesis-failed');
    expect(err.exitCode).toBe(EXIT.failed);
    expect(err.message).toMatch(/Cognitive Services User|region|resource/);
  });

  it('preserves the original message for anything else', () => {
    expect(asSynthesisFailure(new Error('socket hang up')).message).toContain('socket hang up');
  });

  it('explains a WebSocket 1006, which is what a rejected key actually looks like from the Speech SDK', () => {
    // Verified against the live service with a deliberately invalid key: Azure
    // closes the socket with 1006 "Unable to contact server" rather than
    // returning a 401, so the 401 branch above never fires for the commonest
    // auth failure. Taken at face value the message sends people to debug their
    // network instead of their key.
    const err = asSynthesisFailure(
      new Error('Azure Speech synthesis failed: Unable to contact server. StatusCode: 1006, wss://eastus.tts.speech.microsoft.com/... Reason:  ')
    );
    expect(err.reason).toBe('synthesis-failed');
    expect(err.message).toMatch(/key|region/i);
  });

  it('does not claim to know whether a 1006 was a bad key or an unreachable host, because the error does not say', () => {
    const err = asSynthesisFailure(new Error('Unable to contact server. StatusCode: 1006'));
    expect(err.message).toMatch(/does not say which/i);
    expect(err.message).toMatch(/unreachable network/i);
  });

  it('keeps the cause, so a caller can inspect the original error', () => {
    const cause = new Error('boom');
    expect(asSynthesisFailure(cause).cause).toBe(cause);
  });

  it('survives a non-Error being thrown', () => {
    expect(asSynthesisFailure('plain string').reason).toBe('synthesis-failed');
  });
});
