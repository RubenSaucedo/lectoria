import { Podcast } from 'podcast';
import { writeFile, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { Distributor, Episode } from '../types.js';

export interface RssDistributorOptions {
  outDir: string;
  feed: {
    title: string;
    description: string;
    author: string;
    siteUrl: string;
    imageUrl: string;
  };
  /** Base URL where audio files will be hosted. Used to build episode enclosure URLs. */
  audioBaseUrl?: string;
}

interface EpisodeIndex {
  episodes: Episode[];
}

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
    const index = await loadIndex(this.#options.outDir);

    const existingIdx = index.episodes.findIndex((e) => e.id === episode.id);
    if (existingIdx >= 0) index.episodes[existingIdx] = episode;
    else index.episodes.push(episode);

    await saveIndex(this.#options.outDir, index);
    await writeFeed(this.#options, index);
  }
}

async function loadIndex(outDir: string): Promise<EpisodeIndex> {
  try {
    const buf = await readFile(join(outDir, 'episodes.json'), 'utf-8');
    return JSON.parse(buf) as EpisodeIndex;
  } catch {
    return { episodes: [] };
  }
}

async function saveIndex(outDir: string, index: EpisodeIndex): Promise<void> {
  await writeFile(join(outDir, 'episodes.json'), JSON.stringify(index, null, 2), 'utf-8');
}

async function writeFeed(opts: RssDistributorOptions, index: EpisodeIndex): Promise<void> {
  const base = opts.audioBaseUrl?.replace(/\/$/, '') ?? opts.feed.siteUrl.replace(/\/$/, '');
  const feed = new Podcast({
    title: opts.feed.title,
    description: opts.feed.description,
    feedUrl: `${base}/feed.xml`,
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

    const audioUrl = `${base}/${basename(ep.audioPath)}`;
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

  await writeFile(join(opts.outDir, 'feed.xml'), feed.buildXml(), 'utf-8');
}
