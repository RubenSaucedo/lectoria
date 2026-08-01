import type { DialogueSpeaker, ScriptStyle } from './types.js';
import type { CostAwarenessMode } from './cost-policy.js';

/**
 * Maps the CLI `--style` + `--speakers` flags to a `ScriptStyle` discriminated
 * union. Extracted from `cli.ts` so we can unit-test it without spawning
 * the commander program.
 */
export function parseStyle(input: string | undefined, speakers: string | undefined): ScriptStyle {
  const kind = parseStyleKind(input);
  if (kind === 'dialogue') {
    return { kind: 'dialogue', speakers: parseSpeakers(speakers) };
  }
  if (speakers) {
    throw new Error('--speakers is only valid when --style dialogue.');
  }
  return { kind };
}

function parseStyleKind(input: string | undefined): ScriptStyle['kind'] {
  switch (input) {
    case 'podcast':
      return 'podcast';
    case 'verbatim':
      return 'verbatim';
    case 'dialogue':
      return 'dialogue';
    case 'conversational':
    case undefined:
      return 'conversational';
    default:
      throw new Error(
        `Unknown --style "${input}". Expected: podcast | conversational | verbatim | dialogue.`
      );
  }
}

/**
 * Parses `--speakers host:Ava,guest:Jorge` into a `DialogueSpeaker[]`.
 * The id (left of `:`) keys into `VoiceMap`; the name (right) is what the
 * model writes from. Defaults to a 2-speaker host+guest cast when omitted
 * so `--style dialogue` works without any extra flags.
 */
export function parseSpeakers(input: string | undefined): DialogueSpeaker[] {
  if (!input) {
    return [
      { id: 'host', name: 'Ava' },
      { id: 'guest', name: 'Jorge' },
    ];
  }
  const parts = input.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) {
    throw new Error('--speakers needs at least two entries, e.g. host:Ava,guest:Jorge.');
  }
  const parsed = parts.map((part) => {
    const [id, name] = part.split(':').map((s) => s?.trim());
    if (!id) throw new Error(`Invalid --speakers entry "${part}". Use id:Name.`);
    return name ? { id, name } : { id };
  });
  const ids = parsed.map((speaker) => speaker.id);
  if (new Set(ids).size !== ids.length) {
    throw new Error(`--speakers contains duplicate ids: ${ids.join(', ')}.`);
  }
  return parsed;
}

export function parseCostAwarenessMode(
  input: string | undefined
): CostAwarenessMode | undefined {
  if (input === undefined) return undefined;
  if (input === 'off' || input === 'warn' || input === 'require-approval') return input;
  throw new Error(
    `Unknown cost-awareness mode "${input}". Expected: off | warn | require-approval.`
  );
}

export function parseNonNegativeNumber(
  input: string | undefined,
  optionName: string
): number | undefined {
  if (input === undefined) return undefined;
  const parsed = Number(input);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${optionName} must be a finite number greater than or equal to zero.`);
  }
  return parsed;
}

export function exitCodeForItemFailures(failures: number): 0 | 1 {
  return failures > 0 ? 1 : 0;
}
