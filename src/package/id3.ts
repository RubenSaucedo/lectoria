import NodeID3 from 'node-id3';
import { readFile, stat } from 'node:fs/promises';
import { createBufferHash } from '../identity.js';
import type {
  Chapter,
  Episode,
  Packager,
  PodcastScript,
  SynthesizedAudio,
} from '../types.js';

/**
 * Writes ID3v2 tags (title, artist, album, lang) and chapter frames (CHAP/CTOC)
 * directly into the synthesized MP3 in-place, then returns a typed Episode.
 */
export class Id3Packager implements Packager {
  async package(
    script: PodcastScript,
    audio: SynthesizedAudio,
    _opts: { outputPath: string }
  ): Promise<Episode> {
    const chapters = buildChapters(script, audio);

    const tags: NodeID3.Tags = {
      title: script.episodeTitle,
      artist: 'lectoria',
      album: 'lectoria',
      language: script.language,
      comment: { language: 'eng', text: script.summary },
      chapter: chapters.map((c, i) => ({
        elementID: `chp${i}`,
        startTimeMs: Math.round(c.startSec * 1000),
        endTimeMs: Math.round((chapters[i + 1]?.startSec ?? audio.durationSec) * 1000),
        tags: { title: c.title, artist: 'lectoria' },
      })),
      tableOfContents: [
        {
          elementID: 'toc',
          isOrdered: true,
          elements: chapters.map((_, i) => `chp${i}`),
          tags: { title: 'Chapters' },
        },
      ],
    };

    const ok = NodeID3.write(tags, audio.path);
    if (ok !== true) throw new Error(`Failed to write ID3 tags to ${audio.path}`);

    const fileInfo = await stat(audio.path);
    const audioSha256 = createBufferHash(await readFile(audio.path));

    return {
      id: script.id,
      scriptId: script.id,
      documentId: script.documentId,
      language: script.language,
      title: script.episodeTitle,
      description: script.summary,
      audioPath: audio.path,
      audioSizeBytes: fileInfo.size,
      audioSha256,
      durationSec: audio.durationSec,
      chapters,
      publishedAt: new Date().toISOString(),
    };
  }
}

function buildChapters(script: PodcastScript, audio: SynthesizedAudio): Chapter[] {
  return script.segments.map((seg, i) => ({
    startSec: audio.segmentOffsetsSec[i] ?? 0,
    title: seg.heading ?? defaultChapterTitle(seg.kind, i),
  }));
}

function defaultChapterTitle(kind: string, index: number): string {
  if (kind === 'intro') return 'Intro';
  if (kind === 'outro') return 'Outro';
  return `Chapter ${index}`;
}
