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
  DocumentParser,
  IngestSource,
} from './types.js';
import type { Logger } from './logger.js';

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
    voices: { host: { en: 'en-US-AvaMultilingualNeural' } },
    feed: {
      title: 'Fallback Title',
      description: 'd',
      author: 'a',
      siteUrl: 'https://example.com',
      imageUrl: 'https://example.com/cover.png',
      audioBaseUrl: 'https://cdn.example.com/lectoria',
    },
    azure: {
      openai: { endpoint: 'x', deployment: 'x', apiVersion: 'x', auth: { kind: 'apiKey', apiKey: 'x' } },
      speech: { region: 'x', auth: { kind: 'apiKey', apiKey: 'x' } },
    },
  } as unknown as Config;
}

const testPricing = {
  openAiInputPer1M: 2.5,
  openAiOutputPer1M: 10,
  azureSpeechPer1M: 16,
};

const stubScriptModel: ScriptModel = {
  async generateScript(doc: Document, opts: { targetLanguage: string; style: ScriptStyle }): Promise<PodcastScript> {
    return {
      id: `${doc.id}--${opts.targetLanguage}`,
      documentId: doc.id,
      episodeTitle: doc.title,
      language: opts.targetLanguage,
      summary: doc.title,
      segments: [
        { kind: 'body', utterances: [{ voice: 'host', text: doc.title }] },
      ],
      style: opts.style,
    };
  },
  async translateScript(script: PodcastScript, targetLanguage): Promise<PodcastScript> {
    return { ...script, id: `${script.documentId}--${targetLanguage}`, language: targetLanguage };
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
      documentId: script.documentId,
      language: script.language,
      title: script.episodeTitle,
      description: script.summary,
      audioPath: opts.outputPath,
      audioSizeBytes: 4,
      audioSha256: '0'.repeat(64),
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

    expect(calls).toHaveLength(3);
    expect(calls.every((id) => id.endsWith('--en'))).toBe(true);
    const rootName = inputDir.split(/[\\/]/).pop()!;
    const tree = await listTree(join(outDir, rootName));
    // No RssDistributor was instantiated, so no feed files should exist.
    expect(tree.filter((p) => p.endsWith('feed.xml'))).toEqual([]);
    expect(tree.filter((p) => p.endsWith('episodes.json'))).toEqual([]);
  });

  it('enables a custom distributor by default without RSS-specific configuration', async () => {
    await writeFile(join(inputDir, 'doc.md'), '# Doc\n\nbody.');
    const config = makeConfig();
    config.feed.audioBaseUrl = undefined;
    const calls: string[] = [];
    const distributor: Distributor = {
      async publish(episode) {
        calls.push(episode.id);
      },
    };
    await runPipeline(
      config,
      { source: join(inputDir, 'doc.md') },
      {
        scriptModel: stubScriptModel,
        tts: stubTts,
        packager: stubPackager,
        distributor,
      }
    );
    expect(calls).toHaveLength(1);
  });
});

describe('runPipeline — multi-language', () => {
  it('emits one audio file per requested language', async () => {
    await writeFile(join(inputDir, 'doc.md'), '# Doc\n\nbody.');
    const config = makeConfig();
    config.targetLanguages = ['en', 'es'];
    config.voices = { host: { en: 'v-en', es: 'v-es' } };

    const eps = await runPipeline(
      config,
      { source: join(inputDir, 'doc.md') },
      { scriptModel: stubScriptModel, tts: stubTts, packager: stubPackager }
    );

    expect(eps.map((e) => e.language).sort()).toEqual(['en', 'es']);
  });

  it('normalizes and deduplicates BCP-47 language codes before doing work', async () => {
    await writeFile(join(inputDir, 'doc.md'), '# Doc\n\nbody.');
    const config = makeConfig();
    config.voices = { host: { en: 'v-en', es: 'v-es' } };

    const eps = await runPipeline(
      config,
      { source: join(inputDir, 'doc.md'), targetLanguages: ['en', 'EN', 'es'], distribute: false },
      { scriptModel: stubScriptModel, tts: stubTts, packager: stubPackager }
    );

    expect(eps.map((episode) => episode.language).sort()).toEqual(['en', 'es']);
  });
});

describe('runPipeline — reliability', () => {
  it('reuses script, raw audio, and episode checkpoints on an identical rerun', async () => {
    await writeFile(join(inputDir, 'doc.md'), '# Doc\n\nbody.');
    let scriptCalls = 0;
    let ttsCalls = 0;
    let packageCalls = 0;
    const countingScript: ScriptModel = {
      ...stubScriptModel,
      async generateScript(doc, opts) {
        scriptCalls++;
        return stubScriptModel.generateScript(doc, opts);
      },
    };
    const countingTts: TtsProvider = {
      async synthesize(script, opts) {
        ttsCalls++;
        return stubTts.synthesize(script, opts);
      },
    };
    const countingPackager: Packager = {
      async package(script, audio, opts) {
        packageCalls++;
        return stubPackager.package(script, audio, opts);
      },
    };
    const run = () =>
      runPipeline(
        makeConfig(),
        {
          source: join(inputDir, 'doc.md'),
          distribute: false,
          checkpointKey: 'test-adapters-v1',
        },
        { scriptModel: countingScript, tts: countingTts, packager: countingPackager }
      );

    const first = await run();
    const second = await run();
    expect(scriptCalls).toBe(1);
    expect(ttsCalls).toBe(1);
    expect(packageCalls).toBe(1);
    expect(second[0]!.publishedAt).toBe(first[0]!.publishedAt);
  });

  it('serializes concurrent runs that share a checkpoint before paid stages', async () => {
    await writeFile(join(inputDir, 'doc.md'), '# Doc\n\nbody.');
    let scriptCalls = 0;
    let ttsCalls = 0;
    let packageCalls = 0;
    const slowScriptModel: ScriptModel = {
      ...stubScriptModel,
      async generateScript(doc, opts) {
        scriptCalls++;
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
        return stubScriptModel.generateScript(doc, opts);
      },
    };
    const countingTts: TtsProvider = {
      async synthesize(script, opts) {
        ttsCalls++;
        return stubTts.synthesize(script, opts);
      },
    };
    const countingPackager: Packager = {
      async package(script, audio, opts) {
        packageCalls++;
        return stubPackager.package(script, audio, opts);
      },
    };
    const run = () =>
      runPipeline(
        makeConfig(),
        {
          source: join(inputDir, 'doc.md'),
          distribute: false,
          checkpointKey: 'concurrent-runs-v1',
        },
        {
          scriptModel: slowScriptModel,
          tts: countingTts,
          packager: countingPackager,
        }
      );

    const [first, second] = await Promise.all([run(), run()]);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(scriptCalls).toBe(1);
    expect(ttsCalls).toBe(1);
    expect(packageCalls).toBe(1);
  });

  it('disambiguates same-stem inputs before synthesis while preserving readable names otherwise', async () => {
    await writeFile(join(inputDir, 'Lesson.md'), '# Markdown\n\nbody.');
    await writeFile(join(inputDir, 'lesson.txt'), 'plain text body');

    const eps = await runPipeline(
      makeConfig(),
      { source: inputDir, distribute: false },
      { scriptModel: stubScriptModel, tts: stubTts, packager: stubPackager }
    );
    const names = eps.map((episode) => episode.audioPath.split(/[\\/]/).pop()!).sort();
    expect(names).toHaveLength(2);
    expect(names.some((name) => /^Lesson-md-[a-f0-9]{8}-en\.mp3$/.test(name))).toBe(true);
    expect(names.some((name) => /^lesson-txt-[a-f0-9]{8}-en\.mp3$/.test(name))).toBe(true);
  });

  it('restores the matching checkpoint when another run configuration overwrites the final path', async () => {
    await writeFile(join(inputDir, 'doc.md'), '# Doc\n\nbody.');
    let ttsCalls = 0;
    const styleTts: TtsProvider = {
      async synthesize(script, opts) {
        ttsCalls++;
        const marker = script.style?.kind === 'verbatim' ? 0x56 : 0x43;
        await writeFile(opts.outputPath, Buffer.from([marker]));
        return { path: opts.outputPath, durationSec: 1, segmentOffsetsSec: [0] };
      },
    };
    const runStyle = (kind: 'conversational' | 'verbatim') =>
      runPipeline(
        makeConfig(),
        {
          source: join(inputDir, 'doc.md'),
          style: { kind },
          distribute: false,
          checkpointKey: 'style-audio-v1',
        },
        { scriptModel: stubScriptModel, tts: styleTts, packager: stubPackager }
      );

    const [conversational] = await runStyle('conversational');
    expect(await readFile(conversational!.audioPath)).toEqual(Buffer.from([0x43]));
    const [verbatim] = await runStyle('verbatim');
    expect(await readFile(verbatim!.audioPath)).toEqual(Buffer.from([0x56]));
    const [restored] = await runStyle('conversational');
    expect(await readFile(restored!.audioPath)).toEqual(Buffer.from([0x43]));
    expect(ttsCalls).toBe(2);
  });

  it('keeps one RSS episode when source content is revised in place', async () => {
    const source = join(inputDir, 'lesson.md');
    await writeFile(source, '# Lesson\n\nfirst revision.');
    const config = makeConfig();
    await runPipeline(
      config,
      { source, checkpointKey: 'revision-v1' },
      { scriptModel: stubScriptModel, tts: stubTts, packager: stubPackager }
    );
    await writeFile(source, '# Lesson\n\nsecond revision.');
    await runPipeline(
      config,
      { source, checkpointKey: 'revision-v1' },
      { scriptModel: stubScriptModel, tts: stubTts, packager: stubPackager }
    );

    const index = JSON.parse(
      await readFile(join(outDir, 'lesson', 'episodes.json'), 'utf-8')
    ) as { episodes: Episode[] };
    expect(index.episodes).toHaveLength(1);
  });

  it('can continue after a source parse failure and reports the failed item', async () => {
    await writeFile(join(inputDir, 'good.md'), '# Good\n\nbody.');
    await writeFile(join(inputDir, 'empty.md'), '# Empty');
    const failures: Error[] = [];

    const eps = await runPipeline(
      makeConfig(),
      {
        source: inputDir,
        distribute: false,
        continueOnError: true,
        onItemError: (error) => failures.push(error),
      },
      { scriptModel: stubScriptModel, tts: stubTts, packager: stubPackager }
    );

    expect(eps).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.message).toContain('empty.md');
  });

  it('never converts cancellation into a partial-success result', async () => {
    await writeFile(join(inputDir, 'doc.md'), '# Doc\n\nbody.');
    const controller = new AbortController();
    const failures: Error[] = [];
    const abortingTts: TtsProvider = {
      async synthesize() {
        controller.abort(new DOMException('stop', 'AbortError'));
        throw controller.signal.reason;
      },
    };
    await expect(
      runPipeline(
        makeConfig(),
        {
          source: join(inputDir, 'doc.md'),
          distribute: false,
          continueOnError: true,
          signal: controller.signal,
          onItemError: (error) => failures.push(error),
        },
        { scriptModel: stubScriptModel, tts: abortingTts, packager: stubPackager }
      )
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(failures).toEqual([]);
  });

  it('accepts custom ingest and parser adapters through RunOverrides', async () => {
    const customIngest: IngestSource = {
      supports: () => true,
      async fetch() {
        return [{
          id: 'custom-doc',
          contentHash: '1'.repeat(64),
          uri: 'memory://lesson.custom',
          format: 'txt',
          bytes: Buffer.from('custom'),
          fetchedAt: '2026-07-30T00:00:00.000Z',
          sourcePath: 'custom',
        }];
      },
    };
    const customParser: DocumentParser = {
      format: 'txt',
      async parse(file) {
        return {
          id: file.id,
          contentHash: file.contentHash,
          title: 'Custom lesson',
          language: 'en',
          sections: [{ paragraphs: ['Custom body'] }],
          sourcePath: file.sourcePath,
          metadata: {
            sourceUri: file.uri,
            sourceFormat: file.format,
            fetchedAt: file.fetchedAt,
          },
        };
      },
    };

    const eps = await runPipeline(
      makeConfig(),
      { source: 'memory://lesson.custom', distribute: false },
      {
        ingestSource: customIngest,
        parsers: [customParser],
        scriptModel: stubScriptModel,
        tts: stubTts,
        packager: stubPackager,
      }
    );
    expect(eps[0]!.title).toBe('Custom lesson');
  });
});

describe('runPipeline — cost awareness', () => {
  it('emits a structured warning assessment before paid adapters run', async () => {
    await writeFile(join(inputDir, 'large.md'), `# Large\n\n${'content '.repeat(8_000)}`);
    const assessments: number[] = [];
    const warnings: string[] = [];
    const logger: Logger = {
      debug() {},
      info() {},
      warn(message) {
        warnings.push(message);
      },
      error() {},
    };

    await runPipeline(
      makeConfig(),
      {
        source: join(inputDir, 'large.md'),
        distribute: false,
        costPolicy: {
          mode: 'warn',
          warnAboveSourceCharacters: 1,
          warnAboveAudioMinutes: 10_000,
          warnAboveUsd: 10_000,
          pricing: testPricing,
        },
        onCostAssessment: (assessment) =>
          assessments.push(assessment.totals.sourceCharacters),
        logger,
      },
      { scriptModel: stubScriptModel, tts: stubTts, packager: stubPackager }
    );

    expect(assessments[0]).toBeGreaterThan(50_000);
    expect(warnings.some((message) => message.startsWith('[cost]'))).toBe(true);
  });

  it('enforces a hard cost ceiling before invoking script generation', async () => {
    await writeFile(join(inputDir, 'large.md'), `# Large\n\n${'content '.repeat(8_000)}`);
    let scriptCalls = 0;
    const scriptModel: ScriptModel = {
      ...stubScriptModel,
      async generateScript(doc, opts) {
        scriptCalls++;
        return stubScriptModel.generateScript(doc, opts);
      },
    };

    await expect(
      runPipeline(
        makeConfig(),
        {
          source: join(inputDir, 'large.md'),
          distribute: false,
          costPolicy: { maxEstimatedUsd: 0.01, pricing: testPricing },
        },
        { scriptModel, tts: stubTts, packager: stubPackager }
      )
    ).rejects.toThrow(/exceeds the configured maximum/);
    expect(scriptCalls).toBe(0);
  });

  it('continues only when a required cost approval callback accepts', async () => {
    await writeFile(join(inputDir, 'doc.md'), '# Doc\n\nbody.');
    const accepted = await runPipeline(
      makeConfig(),
      {
        source: join(inputDir, 'doc.md'),
        distribute: false,
        costPolicy: {
          mode: 'require-approval',
          warnAboveSourceCharacters: 1,
          approve: () => true,
          pricing: testPricing,
        },
      },
      { scriptModel: stubScriptModel, tts: stubTts, packager: stubPackager }
    );
    expect(accepted).toHaveLength(1);

    await expect(
      runPipeline(
        makeConfig(),
        {
          source: join(inputDir, 'doc.md'),
          distribute: false,
          costPolicy: {
            mode: 'require-approval',
            warnAboveSourceCharacters: 1,
            approve: () => false,
            pricing: testPricing,
          },
        },
        { scriptModel: stubScriptModel, tts: stubTts, packager: stubPackager }
      )
    ).rejects.toThrow(/approval was declined/);
  });

  it('excludes fully cached work from resumed-run cost assessments', async () => {
    await writeFile(join(inputDir, 'doc.md'), '# Doc\n\nbody.');
    const runOptions = {
      source: join(inputDir, 'doc.md'),
      distribute: false,
      checkpointKey: 'cost-cache-v1',
    };
    await runPipeline(
      makeConfig(),
      { ...runOptions, costPolicy: false },
      { scriptModel: stubScriptModel, tts: stubTts, packager: stubPackager }
    );
    let assessedDocuments = -1;
    const episodes = await runPipeline(
      makeConfig(),
      {
        ...runOptions,
        costPolicy: { pricing: testPricing },
        onCostAssessment: (assessment) => {
          assessedDocuments = assessment.totals.documents;
          expect(assessment.totals.usd.total).toBe(0);
          expect(assessment.warnings).toEqual([]);
        },
      },
      { scriptModel: stubScriptModel, tts: stubTts, packager: stubPackager }
    );
    expect(episodes).toHaveLength(1);
    expect(assessedDocuments).toBe(0);
  });

  it('requires explicit pricing when custom paid adapters opt into cost awareness', async () => {
    await writeFile(join(inputDir, 'doc.md'), '# Doc\n\nbody.');
    await expect(
      runPipeline(
        makeConfig(),
        {
          source: join(inputDir, 'doc.md'),
          distribute: false,
          costPolicy: { mode: 'warn' },
        },
        { scriptModel: stubScriptModel, tts: stubTts, packager: stubPackager }
      )
    ).rejects.toThrow(/requires explicit costPolicy.pricing/);
  });

  it('charges missing base-script regeneration even when its episode is complete', async () => {
    const source = join(inputDir, 'doc.md');
    await writeFile(source, `# Doc\n\n${'body '.repeat(2_000)}`);
    const config = makeConfig();
    config.targetLanguages = ['en', 'es'];
    config.voices = { host: { en: 'v-en', es: 'v-es' } };
    const first = await runPipeline(
      config,
      {
        source,
        distribute: false,
        checkpointKey: 'missing-base-script-v1',
        costPolicy: false,
      },
      { scriptModel: stubScriptModel, tts: stubTts, packager: stubPackager }
    );
    await rm(first.find((episode) => episode.language === 'es')!.audioPath);
    const cachedFiles = await listTree(outDir);
    const baseScriptRelative = cachedFiles.find((path) => path.endsWith('/script-en.json'));
    if (!baseScriptRelative) throw new Error('expected script-en.json checkpoint');
    await rm(join(outDir, ...baseScriptRelative.split('/')));

    let scriptCalls = 0;
    const countingScript: ScriptModel = {
      ...stubScriptModel,
      async generateScript(doc, opts) {
        scriptCalls++;
        return stubScriptModel.generateScript(doc, opts);
      },
    };
    await expect(
      runPipeline(
        config,
        {
          source,
          distribute: false,
          checkpointKey: 'missing-base-script-v1',
          costPolicy: {
            maxEstimatedUsd: 0.0001,
            pricing: testPricing,
          },
        },
        { scriptModel: countingScript, tts: stubTts, packager: stubPackager }
      )
    ).rejects.toThrow(/exceeds the configured maximum/);
    expect(scriptCalls).toBe(0);
  });
});
