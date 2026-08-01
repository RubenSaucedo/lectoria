import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RssDistributor } from './rss.js';
import type { Episode } from '../types.js';

let outDir: string;

const feedConfig = {
  title: 'Test Podcast',
  description: 'Just a test',
  author: 'Tester',
  siteUrl: 'https://example.com',
  imageUrl: 'https://example.com/cover.png',
};
const audioBaseUrl = 'https://cdn.example.com/lectoria/';

beforeEach(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'lectoria-rss-'));
});

afterEach(async () => {
  await rm(outDir, { recursive: true, force: true });
});

async function makeEpisode(id: string, title: string): Promise<Episode> {
  const audioPath = join(outDir, `${id}.mp3`);
  await writeFile(audioPath, Buffer.from([0xff, 0xfb, 0x90, 0x00]));
  return {
    id,
    scriptId: `${id}-script`,
    documentId: 'doc-1',
    language: 'en',
    title,
    description: `${title} description`,
    audioPath,
    audioSizeBytes: 4,
    audioSha256: '0'.repeat(64),
    durationSec: 42,
    chapters: [],
    publishedAt: '2026-06-18T12:00:00.000Z',
  };
}

describe('RssDistributor.publish', () => {
  it('writes episodes.json + feed.xml containing the episode title', async () => {
    const dist = new RssDistributor({ outDir, feed: feedConfig, audioBaseUrl });
    const ep = await makeEpisode('ep-1', 'Episode One');

    await dist.publish(ep);

    const index = JSON.parse(await readFile(join(outDir, 'episodes.json'), 'utf-8'));
    expect(index.episodes).toHaveLength(1);
    expect(index.episodes[0].id).toBe('ep-1');

    const xml = await readFile(join(outDir, 'feed.xml'), 'utf-8');
    expect(xml).toContain('Test Podcast');
    expect(xml).toContain('Episode One');
  });

  it('upserts: re-publishing the same id replaces the entry instead of duplicating', async () => {
    const dist = new RssDistributor({ outDir, feed: feedConfig, audioBaseUrl });
    const first = await makeEpisode('ep-1', 'Old Title');
    await dist.publish(first);

    const updated = { ...first, title: 'New Title', description: 'updated' };
    await dist.publish(updated);

    const index = JSON.parse(await readFile(join(outDir, 'episodes.json'), 'utf-8'));
    expect(index.episodes).toHaveLength(1);
    expect(index.episodes[0].title).toBe('New Title');

    const xml = await readFile(join(outDir, 'feed.xml'), 'utf-8');
    expect(xml).toContain('New Title');
    expect(xml).not.toContain('Old Title');
  });

  it('appends a second episode to the same feed', async () => {
    const dist = new RssDistributor({ outDir, feed: feedConfig, audioBaseUrl });
    await dist.publish(await makeEpisode('ep-1', 'One'));
    await dist.publish(await makeEpisode('ep-2', 'Two'));

    const index = JSON.parse(await readFile(join(outDir, 'episodes.json'), 'utf-8'));
    expect(index.episodes.map((e: { id: string }) => e.id)).toEqual(['ep-1', 'ep-2']);
  });

  it('omits episodes from feed.xml whose audio file no longer exists', async () => {
    const dist = new RssDistributor({ outDir, feed: feedConfig, audioBaseUrl });
    const ep = await makeEpisode('ep-gone', 'Vanished');
    await dist.publish(ep);
    // Yank the audio out from under the index.
    await rm(ep.audioPath);

    // Re-publish a second episode to trigger feed regeneration.
    await dist.publish(await makeEpisode('ep-alive', 'Still Here'));

    const xml = await readFile(join(outDir, 'feed.xml'), 'utf-8');
    expect(xml).toContain('Still Here');
    expect(xml).not.toContain('Vanished');
  });

  it('includes the output-relative public path in feed and enclosure URLs', async () => {
    const dist = new RssDistributor({
      outDir,
      feed: feedConfig,
      audioBaseUrl,
      publicPath: 'courses/python',
    });
    await dist.publish(await makeEpisode('ep-1', 'One'));
    const xml = await readFile(join(outDir, 'feed.xml'), 'utf-8');
    expect(xml).toContain('https://cdn.example.com/lectoria/courses/python/feed.xml');
    expect(xml).toContain('https://cdn.example.com/lectoria/courses/python/ep-1.mp3');
  });

  it('fails closed when episodes.json is malformed', async () => {
    await writeFile(join(outDir, 'episodes.json'), '{broken');
    const dist = new RssDistributor({ outDir, feed: feedConfig, audioBaseUrl });
    await expect(dist.publish(await makeEpisode('ep-1', 'One'))).rejects.toThrow(/Corrupt episode index/);
  });
});
