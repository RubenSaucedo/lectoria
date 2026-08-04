import { mkdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { atomicWriteFile } from './fs-safe.js';
import { createBufferHash, createFingerprint } from './identity.js';
import type { Episode, PodcastScript, SynthesizedAudio } from './types.js';

const UtteranceSchema = z.object({
  voice: z.string().optional(),
  text: z.string(),
  pauseAfterMs: z.number().optional(),
});
const SegmentSchema = z.object({
  kind: z.enum(['intro', 'body', 'outro', 'chapter']),
  heading: z.string().optional(),
  utterances: z.array(UtteranceSchema),
});
const SpeakerSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  persona: z.string().optional(),
});
const StyleSchema = z.union([
  z.object({ kind: z.literal('podcast') }),
  z.object({ kind: z.literal('conversational') }),
  z.object({ kind: z.literal('verbatim') }),
  z.object({ kind: z.literal('dialogue'), speakers: z.array(SpeakerSchema) }),
]);
const PodcastScriptSchema = z.object({
  id: z.string(),
  documentId: z.string(),
  episodeTitle: z.string(),
  language: z.string(),
  summary: z.string(),
  segments: z.array(SegmentSchema).min(1),
  style: StyleSchema.optional(),
  estimatedDurationSec: z.number().optional(),
});
const AudioMetadataSchema = z.object({
  durationSec: z.number().nonnegative(),
  segmentOffsetsSec: z.array(z.number().nonnegative()),
  audioSha256: z.string().regex(/^[a-f0-9]{64}$/),
  scriptFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});
const EpisodeSchema = z.object({
  id: z.string(),
  scriptId: z.string(),
  documentId: z.string(),
  language: z.string(),
  title: z.string(),
  description: z.string(),
  audioPath: z.string(),
  audioSizeBytes: z.number().nonnegative(),
  audioSha256: z.string().regex(/^[a-f0-9]{64}$/),
  durationSec: z.number().nonnegative(),
  chapters: z.array(z.object({ startSec: z.number().nonnegative(), title: z.string() })),
  publishedAt: z.string(),
});

export class PipelineCheckpointStore {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  async ensure(): Promise<void> {
    await mkdir(this.root, { recursive: true });
  }

  audioPath(language: string): string {
    return join(this.root, `audio-${safeName(language)}.mp3`);
  }

  async loadScript(language: string): Promise<PodcastScript | undefined> {
    return this.#loadJson(
      join(this.root, `script-${safeName(language)}.json`),
      PodcastScriptSchema,
      'script checkpoint'
    );
  }

  async saveScript(script: PodcastScript): Promise<void> {
    await this.ensure();
    await atomicWriteFile(
      join(this.root, `script-${safeName(script.language)}.json`),
      JSON.stringify(script, null, 2)
    );
  }

  async loadAudio(
    language: string,
    script: PodcastScript
  ): Promise<SynthesizedAudio | undefined> {
    const audioPath = this.audioPath(language);
    const metadata = await this.#loadJson(
      join(this.root, `audio-${safeName(language)}.json`),
      AudioMetadataSchema,
      'audio checkpoint'
    );
    if (!metadata) return undefined;
    if (metadata.scriptFingerprint !== createFingerprint(script)) return undefined;
    try {
      await stat(audioPath);
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return undefined;
      throw error;
    }
    const actualHash = createBufferHash(await readFile(audioPath));
    if (actualHash !== metadata.audioSha256) return undefined;
    return {
      path: audioPath,
      durationSec: metadata.durationSec,
      segmentOffsetsSec: metadata.segmentOffsetsSec,
    };
  }

  async saveAudio(
    language: string,
    audio: SynthesizedAudio,
    script: PodcastScript
  ): Promise<void> {
    await this.ensure();
    await atomicWriteFile(
      join(this.root, `audio-${safeName(language)}.json`),
      JSON.stringify(
        {
          durationSec: audio.durationSec,
          segmentOffsetsSec: audio.segmentOffsetsSec,
          audioSha256: createBufferHash(await readFile(audio.path)),
          scriptFingerprint: createFingerprint(script),
        },
        null,
        2
      )
    );
  }

  async loadEpisode(language: string): Promise<Episode | undefined> {
    return this.#loadJson(
      join(this.root, `episode-${safeName(language)}.json`),
      EpisodeSchema,
      'episode checkpoint'
    );
  }

  async saveEpisode(episode: Episode): Promise<void> {
    await this.ensure();
    await atomicWriteFile(
      join(this.root, `episode-${safeName(episode.language)}.json`),
      JSON.stringify(episode, null, 2)
    );
  }

  async #loadJson<T>(
    path: string,
    schema: z.ZodType<T>,
    label: string
  ): Promise<T | undefined> {
    let raw: string;
    try {
      raw = await readFile(path, 'utf-8');
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return undefined;
      throw error;
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new Error(`Corrupt ${label} at "${path}": invalid JSON.`);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new Error(`Corrupt ${label} at "${path}": ${parsed.error.issues[0]?.message ?? 'invalid data'}.`);
    }
    return parsed.data;
  }
}

function safeName(value: string): string {
  return value.replace(/[^a-z0-9.-]+/gi, '_');
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
