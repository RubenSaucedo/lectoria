import { Podcast } from 'podcast';
import { readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { z } from 'zod';
import type { Distributor, Episode } from '../types.js';
import { atomicWriteFile, withFileLock } from '../fs-safe.js';

export interface RssDistributorOptions {
  outDir: string;
  feed: {
    title: string;
    description: string;
    author: string;
    siteUrl: string;
    imageUrl: string;
  };
  /** Public root URL where the output tree will be hosted. */
  audioBaseUrl: string;
  /** POSIX path from the public root to this feed directory. */
  publicPath?: string;
}

type StoredEpisode = Omit<Episode, 'audioSha256'> & { audioSha256?: string };

interface EpisodeIndex {
  episodes: StoredEpisode[];
}

const EpisodeSchema = z.object({
  id: z.string(),
  scriptId: z.string(),
  documentId: z.string(),
  language: z.string(),
  title: z.string(),
  description: z.string(),
  audioPath: z.string(),
  audioSizeBytes: z.number().nonnegative(),
  audioSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  durationSec: z.number().nonnegative(),
  chapters: z.array(z.object({ startSec: z.number().nonnegative(), title: z.string() })),
  publishedAt: z.string(),
});
const EpisodeIndexSchema = z.object({ episodes: z.array(EpisodeSchema) });

/**
 * Writes the episode index to disk and emits a podcast RSS 2.0 feed
 * (with iTunes namespace) into the output directory.
 *
 * v0 just writes feed.xml next to the MP3s. v1 will upload both to blob
 * storage and emit a public URL.
 */
export class RssDistributor implements Distributor {
  #options: RssDistributorOptions;

  constructor(options: RssDistributorOptions) {
    this.#options = options;
  }

  async publish(episode: Episode): Promise<void> {
    await withFileLock(this.#options.outDir, async () => {
      const index = await loadIndex(this.#options.outDir);
      const existingIdx = index.episodes.findIndex((candidate) => candidate.id === episode.id);
      if (existingIdx >= 0) index.episodes[existingIdx] = episode;
      else index.episodes.push(episode);
      await saveIndex(this.#options.outDir, index);
      await writeFeed(this.#options, index);
    });
  }
}

async function loadIndex(outDir: string): Promise<EpisodeIndex> {
  try {
    const buf = await readFile(join(outDir, 'episodes.json'), 'utf-8');
    let json: unknown;
    try {
      json = JSON.parse(buf);
    } catch {
      throw new Error(`Corrupt episode index at "${join(outDir, 'episodes.json')}": invalid JSON.`);
    }
    const parsed = EpisodeIndexSchema.safeParse(json);
    if (!parsed.success) {
      throw new Error(
        `Corrupt episode index at "${join(outDir, 'episodes.json')}": ${parsed.error.issues[0]?.message ?? 'invalid data'}.`
      );
    }
    return parsed.data;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return { episodes: [] };
    throw error;
  }
}

async function saveIndex(outDir: string, index: EpisodeIndex): Promise<void> {
  await atomicWriteFile(join(outDir, 'episodes.json'), JSON.stringify(index, null, 2));
}

async function writeFeed(opts: RssDistributorOptions, index: EpisodeIndex): Promise<void> {
  const publicPath = opts.publicPath?.split('/').filter(Boolean) ?? [];
  const feedUrl = publicUrl(opts.audioBaseUrl, ...publicPath, 'feed.xml');
  const feed = new Podcast({
    title: opts.feed.title,
    description: opts.feed.description,
    feedUrl,
    siteUrl: opts.feed.siteUrl,
    author: opts.feed.author || opts.feed.title,
    imageUrl: opts.feed.imageUrl,
    itunesAuthor: opts.feed.author || opts.feed.title,
    itunesSummary: opts.feed.description,
    itunesExplicit: false,
  });

  for (const ep of index.episodes) {
    // Skip episodes whose audio file no longer exists on disk.
    const exists = await stat(ep.audioPath).then(() => true, () => false);
    if (!exists) continue;

    const audioUrl = publicUrl(opts.audioBaseUrl, ...publicPath, basename(ep.audioPath));
    feed.addItem({
      title: ep.title,
      description: ep.description,
      url: audioUrl,
      guid: ep.id,
      date: ep.publishedAt,
      itunesDuration: Math.round(ep.durationSec),
      enclosure: {
        url: audioUrl,
        file: ep.audioPath,
      },
    });
  }

  await atomicWriteFile(join(opts.outDir, 'feed.xml'), feed.buildXml());
}

function publicUrl(baseUrl: string, ...parts: string[]): string {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return new URL(parts.map(encodeURIComponent).join('/'), base).toString();
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
