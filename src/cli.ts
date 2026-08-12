#!/usr/bin/env node
import 'dotenv/config';
import { Command } from 'commander';
import { createInterface } from 'node:readline/promises';
import { readFile, readdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { loadConfig } from './config.js';
import { runPipeline } from './pipeline.js';
import { ingest } from './ingest/index.js';
import { parse } from './parse/index.js';
import { createStreamLogger } from './logger.js';
import {
  parseCostAwarenessMode,
  exitCodeForItemFailures,
  parseNonNegativeNumber,
  parseStyle,
} from './cli-helpers.js';
import { VOICE_PRESETS, DEFAULT_VOICE_PRESET } from './voices/presets.js';
import type { Glossary, LanguageCode } from './types.js';
import { createTTS } from './factory.js';
import {
  resolveText,
  resolveVoice,
  resolveSpeechEnv,
  estimateSpeak,
  asSynthesisFailure,
  formatEstimate,
  formatResult,
  SpeakError,
  type SpeakOutput,
} from './speak.js';
import { normalizeLanguageCodes } from './validation.js';
import {
  formatCostAssessment,
  type CostAssessment,
  type CostPolicy,
} from './cost-policy.js';

const program = new Command();
const packageVersion = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf-8')
) as { version: string };

program
  .name('lectoria')
  .description('Turn documents into multilingual podcast episodes.')
  .version(packageVersion.version);

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
  .option('--source-lang <code>', 'Explicit source language (BCP-47), e.g. en, es, or es-MX.')
  .option(
    '--speakers <list>',
    'Dialogue cast as id:Name pairs, comma-separated. ' +
      'Example: --speakers host:Ava,guest:Jorge. ' +
      'Only used when --style dialogue. Defaults to host:Ava,guest:Jorge.'
  )
  .option(
    '--voice <preset>',
    `Voice preset: ${Object.keys(VOICE_PRESETS).join(' | ')}. ` +
      `Sets host/guest voices + pace per language. Overrides LECTORIA_VOICE_PRESET. ` +
      `Default: ${DEFAULT_VOICE_PRESET}. Run \`lectoria voices\` to see them.`
  )
  .option(
    '--no-recursive',
    'When the source is a folder, scan only its top level instead of walking subdirectories.'
  )
  .option(
    '--no-distribute',
    'Skip RSS feed + episodes.json generation. Produce audio files only.'
  )
  .option('--no-resume', 'Ignore reusable checkpoints and repeat every pipeline stage.')
  .option(
    '--continue-on-error',
    'Continue processing other source files when one item fails.'
  )
  .option('--checkpoint-dir <dir>', 'Directory for resumable pipeline checkpoints.')
  .option(
    '--cost-awareness <mode>',
    'Cost preflight: off | warn | require-approval. Default: warn.'
  )
  .option('--warn-above-usd <amount>', 'Warn/confirm at or above this estimated USD cost.')
  .option('--warn-above-chars <count>', 'Warn/confirm at or above this source character count.')
  .option('--warn-above-minutes <minutes>', 'Warn/confirm at or above this estimated audio duration.')
  .option('--max-estimated-usd <amount>', 'Hard estimated-cost ceiling; stops before Azure calls.')
  .option('-y, --yes', 'Approve a cost warning without an interactive prompt.')
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
        voice?: string;
        recursive?: boolean;
        distribute?: boolean;
        glossary?: string;
        sourceLang?: string;
        resume?: boolean;
        continueOnError?: boolean;
        checkpointDir?: string;
        costAwareness?: string;
        warnAboveUsd?: string;
        warnAboveChars?: string;
        warnAboveMinutes?: string;
        maxEstimatedUsd?: string;
        yes?: boolean;
      }
    ) => {
      // Feed --voice through the env the config layer reads, so the preset is
      // resolved (and validated) in one place — loadConfig throws a readable
      // error for an unknown preset name.
      if (opts.voice) process.env.LECTORIA_VOICE_PRESET = opts.voice;
      const config = loadConfig();
      if (opts.out) (config as { outDir: string }).outDir = opts.out;
      const targetLanguages = opts.lang
        ? normalizeLanguageCodes(opts.lang.split(','), '--lang')
        : undefined;
      const style = parseStyle(opts.style, opts.speakers);
      const glossary = opts.glossary ? await loadGlossaryFromFile(opts.glossary) : undefined;
      const costPolicy = buildCliCostPolicy(opts);

      let itemFailures = 0;
      const episodes = await runPipeline(config, {
        source,
        targetLanguages,
        style,
        recursive: opts.recursive,
        distribute: opts.distribute === false ? false : undefined,
        glossary,
        sourceLanguage: opts.sourceLang
          ? normalizeLanguageCodes([opts.sourceLang], '--source-lang')[0]
          : undefined,
        resume: opts.resume,
        continueOnError: opts.continueOnError,
        checkpointDir: opts.checkpointDir,
        costPolicy,
        logger: createStreamLogger(process.stderr),
        onItemError: () => {
          itemFailures++;
        },
      });
      for (const ep of episodes) {
        console.log(`[ok] ${ep.language}\t${ep.title}\t${ep.audioPath}`);
      }
      process.exitCode = exitCodeForItemFailures(itemFailures);
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
  .command('voices')
  .description('List available voice presets (pick one with `run --voice <preset>`).')
  .action(() => {
    for (const [name, map] of Object.entries(VOICE_PRESETS)) {
      const marker = name === DEFAULT_VOICE_PRESET ? ' (default)' : '';
      console.log(`\n${name}${marker}`);
      for (const [role, byLang] of Object.entries(map)) {
        for (const [lang, voice] of Object.entries(byLang)) {
          const spec = typeof voice === 'string' ? { name: voice } : voice;
          const tuning = [
            spec.rate ? `rate ${spec.rate}` : null,
            spec.pitch ? `pitch ${spec.pitch}` : null,
            spec.style ? `style ${spec.style}` : null,
          ]
            .filter(Boolean)
            .join(', ');
          console.log(`  ${role.padEnd(6)} ${lang}  ${spec.name}${tuning ? `  (${tuning})` : ''}`);
        }
      }
    }
  });

program
  .command('speak')
  .description(
    'Synthesise one piece of text to an audio file and report its measured duration.'
  )
  .option('--text <text>', 'Text to speak. Prefer --text-file when it contains quotes or newlines.')
  .option('--text-file <path>', 'Read the text to speak from a file (UTF-8).')
  .option('--out <path>', 'Where to write the audio file.', 'speech.mp3')
  .option(
    '--voice <id>',
    'Azure voice id, e.g. en-US-AvaMultilingualNeural. Not a preset name — `run --voice` takes those. Overrides LECTORIA_SPEAK_VOICE.'
  )
  .option('--lang <code>', 'Language code for the SSML envelope (BCP-47).', 'en')
  .option('--json', 'Print the result as JSON on stdout. Human output goes to stderr.')
  .option(
    '--estimate-only',
    'Print the projected cost and duration without calling Azure. Nothing is billed.'
  )
  .option(
    '--retries <count>',
    'Retries after a failed attempt. Defaults to 0: a retry is a second paid synthesis, ' +
      'and a client that saw a timeout cannot tell whether the first call also produced audio.',
    '0'
  )
  .option('--timeout-ms <ms>', 'Deadline for the synthesis request.', '120000')
  .action(
    async (opts: {
      text?: string;
      textFile?: string;
      out: string;
      voice?: string;
      lang: string;
      json?: boolean;
      estimateOnly?: boolean;
      retries: string;
      timeoutMs: string;
    }) => {
      // Human output goes to stderr throughout so that `--json` stdout stays
      // parseable when piped, and so progress never corrupts the payload.
      const say = (line: string) => process.stderr.write(`${line}\n`);
      try {
        const text = await resolveText(opts);
        const voice = resolveVoice(opts.voice);

        if (opts.estimateOnly) {
          const estimate = estimateSpeak(text, voice);
          if (opts.json) console.log(JSON.stringify(estimate, null, 2));
          say(formatEstimate(estimate));
          return;
        }

        // Resolved before synthesis so a misconfigured machine is told so
        // without a call being attempted.
        const env = resolveSpeechEnv();
        const retries = parseNonNegativeNumber(opts.retries, '--retries') ?? 0;
        const timeoutMs = parseNonNegativeNumber(opts.timeoutMs, '--timeout-ms');

        const tts = createTTS({
          region: env.region,
          resourceId: env.resourceId,
          auth: env.auth,
          defaultVoice: voice,
          defaultLanguage: opts.lang as LanguageCode,
          maxRetries: retries,
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        });

        let audio;
        try {
          audio = await tts.speakToFile(text, resolve(opts.out));
        } catch (err) {
          throw asSynthesisFailure(err);
        }

        const result: SpeakOutput = {
          path: audio.path,
          durationSec: audio.durationSec,
          characters: text.length,
          voice,
          language: opts.lang,
          region: env.region,
          authKind: env.authKind,
          estimated: false,
        };
        if (opts.json) console.log(JSON.stringify(result, null, 2));
        say(formatResult(result));
      } catch (err) {
        const speakError =
          err instanceof SpeakError ? err : new SpeakError('usage', (err as Error).message, { cause: err });
        // A caller that asked for JSON gets JSON even when things fail —
        // otherwise it has to parse prose to find out why, which is exactly
        // the ambiguity between "not set up" and "the call failed" that this
        // command exists to remove.
        if (opts.json) {
          console.log(
            JSON.stringify({ error: { reason: speakError.reason, message: speakError.message } }, null, 2)
          );
        }
        say(`lectoria speak: ${speakError.message}`);
        process.exitCode = speakError.exitCode;
      }
    }
  );

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
    throw new Error(`--glossary "${path}" could not be read: ${(err as Error).message}`, {
      cause: err,
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`--glossary "${path}" is not valid JSON: ${(err as Error).message}`, {
      cause: err,
    });
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

function buildCliCostPolicy(opts: {
  costAwareness?: string;
  warnAboveUsd?: string;
  warnAboveChars?: string;
  warnAboveMinutes?: string;
  maxEstimatedUsd?: string;
  yes?: boolean;
}): CostPolicy | false | undefined {
  const mode = parseCostAwarenessMode(opts.costAwareness);
  if (mode === 'off') return false;
  const warnAboveUsd = parseNonNegativeNumber(opts.warnAboveUsd, '--warn-above-usd');
  const warnAboveSourceCharacters = parseNonNegativeNumber(
    opts.warnAboveChars,
    '--warn-above-chars'
  );
  const warnAboveAudioMinutes = parseNonNegativeNumber(
    opts.warnAboveMinutes,
    '--warn-above-minutes'
  );
  const maxEstimatedUsd = parseNonNegativeNumber(
    opts.maxEstimatedUsd,
    '--max-estimated-usd'
  );
  if (
    mode === undefined &&
    warnAboveUsd === undefined &&
    warnAboveSourceCharacters === undefined &&
    warnAboveAudioMinutes === undefined &&
    maxEstimatedUsd === undefined
  ) {
    return undefined;
  }
  return {
    ...(mode ? { mode } : {}),
    ...(warnAboveUsd !== undefined ? { warnAboveUsd } : {}),
    ...(warnAboveSourceCharacters !== undefined ? { warnAboveSourceCharacters } : {}),
    ...(warnAboveAudioMinutes !== undefined ? { warnAboveAudioMinutes } : {}),
    ...(maxEstimatedUsd !== undefined ? { maxEstimatedUsd } : {}),
    ...(mode === 'require-approval'
      ? { approve: createCliCostApproval(Boolean(opts.yes)) }
      : {}),
  };
}

function createCliCostApproval(
  autoApprove: boolean
): (assessment: CostAssessment) => Promise<boolean> {
  if (autoApprove) return async () => true;
  return async (assessment) => {
    if (!process.stdin.isTTY || !process.stderr.isTTY) return false;
    const readline = createInterface({ input: process.stdin, output: process.stderr });
    try {
      const answer = await readline.question(
        `[cost] ${formatCostAssessment(assessment)}. Continue? [y/N] `
      );
      return /^(y|yes)$/i.test(answer.trim());
    } finally {
      readline.close();
    }
  };
}
