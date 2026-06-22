#!/usr/bin/env node
import 'dotenv/config';
import { Command } from 'commander';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { loadConfig } from './config.js';
import { runPipeline } from './pipeline.js';
import { ingest } from './ingest/index.js';
import { parse } from './parse/index.js';
import { createStreamLogger } from './logger.js';
import { parseStyle } from './cli-helpers.js';
import type { Glossary, LanguageCode } from './types.js';

const program = new Command();

program
  .name('lectoria')
  .description('Turn documents into multilingual podcast episodes.')
  .version('0.0.1');

program
  .command('run')
  .description('Run the full pipeline on a source file or folder.')
  .argument('<source>', 'Path to a document or a folder of documents.')
  .option('--lang <list>', 'Comma-separated target languages (e.g. en,es).')
  .option('--out <dir>', 'Output directory (overrides LECTORIA_OUT_DIR).')
  .option(
    '--style <style>',
    'Script style: podcast | conversational | verbatim | dialogue.',
    'conversational'
  )
  .option(
    '--speakers <list>',
    'Dialogue cast as id:Name pairs, comma-separated. ' +
      'Example: --speakers host:Ava,guest:Jorge. ' +
      'Only used when --style dialogue. Defaults to host:Ava,guest:Jorge.'
  )
  .option(
    '--no-recursive',
    'When the source is a folder, scan only its top level instead of walking subdirectories.'
  )
  .option(
    '--no-distribute',
    'Skip RSS feed + episodes.json generation. Produce audio files only.'
  )
  .option(
    '--glossary <path>',
    'Path to a JSON glossary file: { "terms": ["MCP", { "term": "DA", "meaning": "Domain Admin" }] }. ' +
      'Listed terms keep English pronunciation in non-English narrations. ' +
      'Overrides LECTORIA_GLOSSARY_FILE.'
  )
  .action(
    async (
      source: string,
      opts: {
        lang?: string;
        out?: string;
        style?: string;
        speakers?: string;
        recursive?: boolean;
        distribute?: boolean;
        glossary?: string;
      }
    ) => {
      const config = loadConfig();
      if (opts.out) (config as { outDir: string }).outDir = opts.out;
      const targetLanguages = opts.lang
        ? (opts.lang.split(',').map((s) => s.trim()).filter(Boolean) as LanguageCode[])
        : undefined;
      const style = parseStyle(opts.style, opts.speakers);
      const glossary = opts.glossary ? await loadGlossaryFromFile(opts.glossary) : undefined;

      const episodes = await runPipeline(config, {
        source,
        targetLanguages,
        style,
        recursive: opts.recursive,
        distribute: opts.distribute,
        glossary,
        logger: createStreamLogger(process.stderr),
      });
      for (const ep of episodes) {
        console.log(`[ok] ${ep.language}\t${ep.title}\t${ep.audioPath}`);
      }
    }
  );

program
  .command('parse')
  .description('Parse a document and print the normalized Document JSON.')
  .argument('<source>', 'Path to a single document.')
  .action(async (source: string) => {
    const files = await ingest(source);
    for (const file of files) {
      const doc = await parse(file);
      console.log(JSON.stringify(doc, null, 2));
    }
  });

program
  .command('list')
  .description('List episodes currently in the local feed index(es).')
  .option('--out <dir>', 'Output directory containing one or more episodes.json files.', './out')
  .action(async (opts: { out: string }) => {
    const root = resolve(opts.out);
    const indexes = await findEpisodeIndexes(root);
    if (!indexes.length) {
      console.log('(no episodes yet)');
      return;
    }
    let total = 0;
    for (const indexPath of indexes) {
      try {
        const raw = await readFile(indexPath, 'utf-8');
        const data = JSON.parse(raw) as {
          episodes: Array<{ title: string; language: string; durationSec: number }>;
        };
        const feedDir = relative(root, dirname(indexPath)) || '.';
        for (const ep of data.episodes) {
          console.log(
            `${feedDir}\t${ep.language}\t${Math.round(ep.durationSec)}s\t${ep.title}`
          );
          total++;
        }
      } catch {
        // Skip unreadable / malformed indexes silently — `list` should never
        // fail just because one feed is corrupt.
      }
    }
    if (!total) console.log('(no episodes yet)');
  });

program.parseAsync(process.argv).catch((err: Error) => {
  console.error(`lectoria: ${err.message}`);
  process.exitCode = 1;
});

/**
 * Recursively finds every `episodes.json` under `root`. Returns absolute
 * paths sorted for stable output across runs. Used by `lectoria list` to
 * aggregate per-folder feeds into a single view.
 */
async function findEpisodeIndexes(root: string): Promise<string[]> {
  const found: string[] = [];
  await walk(root);
  found.sort();
  return found;

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name === 'episodes.json') {
        found.push(full);
      }
    }
  }
}

/**
 * Reads a glossary JSON file. Throws a readable error if the file is
 * unreadable or malformed so the CLI can surface it instead of producing
 * a confusing schema-validation message at pipeline start.
 *
 * Accepted shape (matches the `Glossary` interface):
 *   { "terms": ["MCP", "HubSpot", { "term": "DA", "meaning": "Domain Admin" }] }
 */
async function loadGlossaryFromFile(path: string): Promise<Glossary> {
  const absolute = resolve(path);
  let raw: string;
  try {
    raw = await readFile(absolute, 'utf-8');
  } catch (err) {
    throw new Error(`--glossary "${path}" could not be read: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`--glossary "${path}" is not valid JSON: ${(err as Error).message}`);
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !Array.isArray((parsed as { terms?: unknown }).terms)
  ) {
    throw new Error(
      `--glossary "${path}" must have shape { "terms": [...] }. Found: ${typeof parsed}.`
    );
  }
  return parsed as Glossary;
}
