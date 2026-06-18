import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { runPipeline } from './pipeline.js';
import type { Config } from './config.js';
import type {
  Distributor,
  Document,
  Episode,
  Packager,
  PodcastScript,
  ScriptModel,
  ScriptStyle,
  SynthesizedAudio,
  TtsProvider,
} from './types.js';

let inputDir: string;
let outDir: string;

beforeEach(async () => {
  inputDir = await mkdtemp(join(tmpdir(), 'lectoria-pipe-in-'));
  outDir = await mkdtemp(join(tmpdir(), 'lectoria-pipe-out-'));
});

afterEach(async () => {
  await rm(inputDir, { recursive: true, force: true });
  await rm(outDir, { recursive: true, force: true });
});

function makeConfig(): Config {
  return {
    outDir,
    targetLanguages: ['en'],
    voices: { default: { en: 'en-US-AvaMultilingualNeural' } },
    feed: {
      title: 'Fallback Title',
      description: 'd',
      author: 'a',
      siteUrl: 'https://example.com',
      imageUrl: 'https://example.com/cover.png',
    },
    azure: {
      openai: { endpoint: 'x', deployment: 'x', apiVersion: 'x', auth: { kind: 'apiKey', apiKey: 'x' } },
      speech: { region: 'x', auth: { kind: 'apiKey', apiKey: 'x' } },
    },
  } as unknown as Config;
}

const stubScriptModel: ScriptModel = {
  async generateScript(doc: Document, opts: { targetLanguage: string; style: ScriptStyle }): Promise<PodcastScript> {
    return {
      id: `${doc.id}-${opts.targetLanguage}`,
      episodeTitle: doc.title,
      language: opts.targetLanguage,
      summary: doc.title,
      segments: [
        { kind: 'body', utterances: [{ voice: 'default', text: doc.title }] },
      ],
      style: opts.style,
    };
  },
  async translateScript(script: PodcastScript, targetLanguage): Promise<PodcastScript> {
    return { ...script, language: targetLanguage };
  },
};

const stubTts: TtsProvider = {
  async synthesize(_script, opts): Promise<SynthesizedAudio> {
    await mkdir(dirname(opts.outputPath), { recursive: true });
    // Tiny valid-ish MP3 header so anything reading the file doesn't choke.
    await writeFile(opts.outputPath, Buffer.from([0xff, 0xfb, 0x90, 0x00]));
    return { path: opts.outputPath, durationSec: 1, segmentOffsetsSec: [0] };
  },
};

const stubPackager: Packager = {
  async package(script, audio, opts): Promise<Episode> {
    return {
      id: script.id,
      scriptId: script.id,
      documentId: script.id.replace(/-[^-]+$/, ''),
      language: script.language,
      title: script.episodeTitle,
      description: script.summary,
      audioPath: opts.outputPath,
      audioSizeBytes: 4,
      durationSec: audio.durationSec,
      chapters: [],
      publishedAt: '2026-06-18T12:00:00.000Z',
    };
  },
};

async function seedNested(): Promise<void> {
  await writeFile(join(inputDir, 'overview.md'), '# Overview\n\nintro.');
  await mkdir(join(inputDir, 'python'));
  await writeFile(join(inputDir, 'python', 'lesson-1.md'), '# Lesson 1\n\nbody.');
  await mkdir(join(inputDir, 'rust'));
  await writeFile(join(inputDir, 'rust', 'intro.md'), '# Intro\n\nbody.');
}

async function listTree(root: string): Promise<string[]> {
  const out: string[] = [];
  await walk(root);
  out.sort();
  return out;
  async function walk(dir: string) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else out.push(relative(root, full).split('\\').join('/'));
    }
  }
}

describe('runPipeline — multi-podcast layout', () => {
  it('mirrors the input tree under outDir and emits one feed per folder', async () => {
    await seedNested();

    const eps = await runPipeline(
      makeConfig(),
      { source: inputDir },
      { scriptModel: stubScriptModel, tts: stubTts, packager: stubPackager }
    );

    expect(eps).toHaveLength(3);
    const rootName = inputDir.split(/[\\/]/).pop()!;
    const tree = await listTree(join(outDir, rootName));
    expect(tree).toEqual(
      expect.arrayContaining([
        'episodes.json',
        'feed.xml',
        'overview-en.mp3',
        'python/episodes.json',
        'python/feed.xml',
        'python/lesson-1-en.mp3',
        'rust/episodes.json',
        'rust/feed.xml',
        'rust/intro-en.mp3',
      ])
    );
  });

  it('derives per-folder feed titles by title-casing the directory name', async () => {
    await seedNested();
    await runPipeline(
      makeConfig(),
      { source: inputDir },
      { scriptModel: stubScriptModel, tts: stubTts, packager: stubPackager }
    );
    const rootName = inputDir.split(/[\\/]/).pop()!;
    const pythonFeed = await readFile(join(outDir, rootName, 'python', 'feed.xml'), 'utf-8');
    expect(pythonFeed).toContain('Python');
    const rustFeed = await readFile(join(outDir, rootName, 'rust', 'feed.xml'), 'utf-8');
    expect(rustFeed).toContain('Rust');
  });
});

describe('runPipeline — opt-outs', () => {
  it('skips feed.xml and episodes.json when distribute is false', async () => {
    await seedNested();
    await runPipeline(
      makeConfig(),
      { source: inputDir, distribute: false },
      { scriptModel: stubScriptModel, tts: stubTts, packager: stubPackager }
    );
    const rootName = inputDir.split(/[\\/]/).pop()!;
    const tree = await listTree(join(outDir, rootName));
    expect(tree).not.toContain('feed.xml');
    expect(tree).not.toContain('episodes.json');
    expect(tree).not.toContain('python/feed.xml');
    // But the audio files are still there.
    expect(tree).toEqual(
      expect.arrayContaining(['overview-en.mp3', 'python/lesson-1-en.mp3', 'rust/intro-en.mp3'])
    );
  });

  it('processes only top-level files when recursive is false', async () => {
    await seedNested();
    const eps = await runPipeline(
      makeConfig(),
      { source: inputDir, recursive: false },
      { scriptModel: stubScriptModel, tts: stubTts, packager: stubPackager }
    );
    expect(eps).toHaveLength(1);
    expect(eps[0]!.title).toBe('Overview');
  });
});

describe('runPipeline — single file input', () => {
  it('lands under out/<stem>/<stem>-<lang>.mp3', async () => {
    await writeFile(join(inputDir, 'lesson.md'), '# Lesson\n\nbody.');
    const eps = await runPipeline(
      makeConfig(),
      { source: join(inputDir, 'lesson.md') },
      { scriptModel: stubScriptModel, tts: stubTts, packager: stubPackager }
    );
    expect(eps).toHaveLength(1);
    expect(eps[0]!.audioPath.split(/[\\/]/).slice(-2).join('/')).toBe('lesson/lesson-en.mp3');
  });
});

describe('runPipeline — distributor override', () => {
  it('funnels every episode through the single override instance instead of per-folder feeds', async () => {
    await seedNested();
    const calls: string[] = [];
    const recording: Distributor = {
      async publish(ep) {
        calls.push(ep.id);
      },
    };

    await runPipeline(
      makeConfig(),
      { source: inputDir },
      { scriptModel: stubScriptModel, tts: stubTts, packager: stubPackager, distributor: recording }
    );

    expect(calls.sort()).toEqual(['lesson-1-en', 'intro-en', 'overview-en'].sort());
    const rootName = inputDir.split(/[\\/]/).pop()!;
    const tree = await listTree(join(outDir, rootName));
    // No RssDistributor was instantiated, so no feed files should exist.
    expect(tree.filter((p) => p.endsWith('feed.xml'))).toEqual([]);
    expect(tree.filter((p) => p.endsWith('episodes.json'))).toEqual([]);
  });
});

describe('runPipeline — multi-language', () => {
  it('emits one audio file per requested language', async () => {
    await writeFile(join(inputDir, 'doc.md'), '# Doc\n\nbody.');
    const config = makeConfig();
    config.targetLanguages = ['en', 'es'];
    config.voices = { default: { en: 'v-en', es: 'v-es' } };

    const eps = await runPipeline(
      config,
      { source: join(inputDir, 'doc.md') },
      { scriptModel: stubScriptModel, tts: stubTts, packager: stubPackager }
    );

    expect(eps.map((e) => e.language).sort()).toEqual(['en', 'es']);
  });
});
