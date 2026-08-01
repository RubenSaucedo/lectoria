import { z } from 'zod';
import type { PodcastSegment } from '../types.js';

const MAX_TITLE_LENGTH = 500;
const MAX_SUMMARY_LENGTH = 10_000;
const MAX_HEADING_LENGTH = 500;
const MAX_UTTERANCE_LENGTH = 30_000;
const MAX_PAUSE_MS = 10_000;

const UtteranceSchema = z
  .object({
    voice: z.string().trim().min(1).max(128).optional(),
    text: z.string().trim().min(1).max(MAX_UTTERANCE_LENGTH),
    pauseAfterMs: z
      .number()
      .finite()
      .int()
      .min(0)
      .max(MAX_PAUSE_MS)
      .nullable()
      .optional()
      .transform((value) => value ?? undefined),
  })
  .strict();

const SegmentSchema = z
  .object({
    kind: z.enum(['intro', 'body', 'outro', 'chapter']),
    heading: z
      .string()
      .trim()
      .min(1)
      .max(MAX_HEADING_LENGTH)
      .nullable()
      .optional()
      .transform((value) => value ?? undefined),
    utterances: z.array(UtteranceSchema).min(1).max(1_000),
  })
  .strict();

const ScriptPayloadSchema = z
  .object({
    episodeTitle: z.string().trim().min(1).max(MAX_TITLE_LENGTH),
    summary: z.string().trim().max(MAX_SUMMARY_LENGTH),
    segments: z.array(SegmentSchema).min(1).max(1_000),
  })
  .strict();

const WrappedScriptPayloadSchema = z
  .object({
    script: ScriptPayloadSchema,
  })
  .strict();

export interface ParsedModelScript {
  episodeTitle: string;
  summary: string;
  segments: PodcastSegment[];
}

export class ModelOutputValidationError extends Error {
  readonly issues: string[];

  constructor(message: string, issues: string[] = []) {
    super(message);
    this.name = 'ModelOutputValidationError';
    this.issues = issues;
  }
}

export function parseModelScript(raw: string, allowedSpeakers: ReadonlySet<string>): ParsedModelScript {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new ModelOutputValidationError('Model output was not valid JSON.');
  }

  const parsed = (
    typeof json === 'object' && json !== null && 'script' in json
      ? WrappedScriptPayloadSchema
      : ScriptPayloadSchema
  ).safeParse(json);

  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 8).map((issue) => {
      const path = issue.path.length ? issue.path.join('.') : '<root>';
      return `${path}: ${issue.message}`;
    });
    throw new ModelOutputValidationError('Model output did not match the script schema.', issues);
  }

  const payload = 'script' in parsed.data ? parsed.data.script : parsed.data;
  const unexpectedSpeakers = new Set<string>();
  for (const segment of payload.segments) {
    for (const utterance of segment.utterances) {
      const speaker = utterance.voice ?? 'host';
      if (!allowedSpeakers.has(speaker)) unexpectedSpeakers.add(speaker);
    }
  }
  if (unexpectedSpeakers.size > 0) {
    throw new ModelOutputValidationError('Model output used unconfigured speaker IDs.', [
      `unexpected speakers: ${[...unexpectedSpeakers].sort().join(', ')}`,
      `allowed speakers: ${[...allowedSpeakers].sort().join(', ')}`,
    ]);
  }

  return payload;
}
