import { z } from 'zod';
import { readFileSync } from 'node:fs';
import type { Glossary, VoiceMap, VoiceValue } from './types.js';
import { resolveVoicePreset } from './voices/presets.js';

const GlossaryEntrySchema = z.union([
  z.string(),
  z.object({
    term: z.string().min(1),
    meaning: z.string().optional(),
    caseSensitive: z.boolean().optional(),
  }),
]);

const GlossarySchema = z.object({
  terms: z.array(GlossaryEntrySchema),
});

const VoiceSpecSchema = z.object({
  name: z.string().min(1),
  rate: z.string().optional(),
  pitch: z.string().optional(),
  style: z.string().optional(),
  styleDegree: z.number().optional(),
});

const VoiceValueSchema = z.union([z.string().min(1), VoiceSpecSchema]);

const ConfigSchema = z.object({
  azure: z.object({
    speech: z.object({
      region: z.string().min(1, 'AZURE_SPEECH_REGION is required'),
      /**
       * Full Azure resource ID of the Speech resource, used when minting an
       * Entra ID authorization token. Find via:
       *   az cognitiveservices account show -n <name> -g <rg> --query id -o tsv
       */
      resourceId: z.string().min(1, 'AZURE_SPEECH_RESOURCE_ID is required'),
    }),
    openai: z.object({
      endpoint: z.string().url('AZURE_OPENAI_ENDPOINT must be a URL'),
      deployment: z.string().min(1, 'AZURE_OPENAI_DEPLOYMENT is required'),
      apiVersion: z.string().min(1),
    }),
  }),
  voices: z.record(z.string(), z.record(z.string(), VoiceValueSchema)),
  targetLanguages: z.array(z.string()).min(1),
  outDir: z.string().min(1),
  feed: z.object({
    title: z.string().min(1),
    description: z.string().min(1),
    author: z.string(),
    siteUrl: z.string().url(),
    imageUrl: z.string().url(),
  }),
  /**
   * Optional project glossary of terms that must keep English pronunciation
   * across translations. CLI loads it from `LECTORIA_GLOSSARY_FILE` or the
   * `--glossary` flag; library callers can pass it through `defineConfig`.
   */
  glossary: GlossarySchema.optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

/**
 * Build a Config from process.env. Throws a readable error if any required
 * variable is missing or malformed. Call once at startup.
 *
 * NOTE: This function is intended for the CLI. Library consumers should
 * prefer `defineConfig()` so their host process doesn't need lectoria-shaped
 * environment variables. `loadConfig` does NOT load `.env` files itself —
 * the CLI imports `dotenv/config` at its own entry point.
 *
 * Auth: Azure credentials are NOT in config. Sign in with `az login` and the
 * Azure SDK's DefaultAzureCredential will pick that up automatically, or pass
 * a `LectoriaAuth` into the adapters explicitly.
 *
 * `requireResources: false` lets non-pipeline commands (like `lectoria parse`)
 * load partial config without needing the Azure endpoints present.
 */
export function loadConfig(opts: { requireResources?: boolean } = {}): Config {
  const requireResources = opts.requireResources ?? true;
  const placeholder = (envValue: string | undefined, fallback: string) =>
    envValue ?? (requireResources ? '' : fallback);

  const raw = {
    azure: {
      speech: {
        region: process.env.AZURE_SPEECH_REGION ?? 'eastus',
        resourceId: placeholder(process.env.AZURE_SPEECH_RESOURCE_ID, 'unset'),
      },
      openai: {
        endpoint: process.env.AZURE_OPENAI_ENDPOINT ?? 'https://unset.invalid',
        deployment: process.env.AZURE_OPENAI_DEPLOYMENT ?? 'gpt-4o',
        apiVersion: process.env.AZURE_OPENAI_API_VERSION ?? '2024-08-01-preview',
      },
    },
    voices: buildVoices(),
    targetLanguages: (process.env.LECTORIA_TARGET_LANGS ?? 'en,es')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    outDir: process.env.LECTORIA_OUT_DIR ?? './out',
    feed: {
      title: process.env.LECTORIA_FEED_TITLE ?? 'Lectoria',
      description: process.env.LECTORIA_FEED_DESCRIPTION ?? 'Written learning content, narrated.',
      author: process.env.LECTORIA_FEED_AUTHOR ?? '',
      siteUrl: process.env.LECTORIA_FEED_SITE_URL ?? 'https://example.com',
      imageUrl: process.env.LECTORIA_FEED_IMAGE_URL ?? 'https://example.com/cover.jpg',
    },
    glossary: loadGlossaryFromEnv(),
  };

  return ConfigSchema.parse(raw);
}

/**
 * Reads `LECTORIA_GLOSSARY_FILE` (when set) and returns its parsed JSON.
 * Validation happens later via `ConfigSchema.parse`. Returns undefined when
 * the env var isn't set so the field stays optional.
 */
function loadGlossaryFromEnv(): unknown {
  const path = process.env.LECTORIA_GLOSSARY_FILE;
  if (!path) return undefined;
  try {
    const raw = readFileSync(path, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Failed to read LECTORIA_GLOSSARY_FILE="${path}": ${(err as Error).message}`
    );
  }
}

/**
 * Build the VoiceMap for the CLI: start from the selected preset
 * (`LECTORIA_VOICE_PRESET`, default `espana`), then layer per-role env
 * overrides on top. An override sets a bare voice id, replacing that slot's
 * preset delivery tuning — set it only when you want a specific voice.
 */
function buildVoices(): VoiceMap {
  const { voices } = resolveVoicePreset(process.env.LECTORIA_VOICE_PRESET);
  const override = (role: string, lang: string, value: string | undefined) => {
    if (!value) return;
    (voices[role] ??= {})[lang] = value as VoiceValue;
  };
  override('host', 'en', process.env.LECTORIA_VOICE_EN);
  override('host', 'es', process.env.LECTORIA_VOICE_ES);
  override('guest', 'en', process.env.LECTORIA_VOICE_EN_GUEST);
  override('guest', 'es', process.env.LECTORIA_VOICE_ES_GUEST);
  return voices;
}

/**
 * Programmatic config builder for library consumers.
 *
 * Pass only what you care about; the rest gets reasonable defaults so a
 * caller that overrides every adapter (their own scriptModel / tts /
 * distributor) doesn't need real Azure endpoints in config at all.
 *
 * Validation still runs — so if you're using the default Azure adapters
 * you'll get a typed error at config-build time rather than a 401 mid-run.
 */
export function defineConfig(input: DeepPartial<Config>): Config {
  const merged = mergeWithDefaults(input);
  return ConfigSchema.parse(merged);
}

type DeepPartial<T> = T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;

function mergeWithDefaults(input: DeepPartial<Config>): Config {
  return {
    azure: {
      speech: {
        region: input.azure?.speech?.region ?? 'eastus',
        resourceId: input.azure?.speech?.resourceId ?? 'unset',
      },
      openai: {
        endpoint: input.azure?.openai?.endpoint ?? 'https://unset.invalid',
        deployment: input.azure?.openai?.deployment ?? 'gpt-4o',
        apiVersion: input.azure?.openai?.apiVersion ?? '2024-08-01-preview',
      },
    },
    voices: (input.voices as Config['voices']) ?? resolveVoicePreset().voices,
    targetLanguages: (input.targetLanguages as string[]) ?? ['en', 'es'],
    outDir: input.outDir ?? './out',
    feed: {
      title: input.feed?.title ?? 'Lectoria',
      description: input.feed?.description ?? 'Written learning content, narrated.',
      author: input.feed?.author ?? '',
      siteUrl: input.feed?.siteUrl ?? 'https://example.com',
      imageUrl: input.feed?.imageUrl ?? 'https://example.com/cover.jpg',
    },
    glossary: input.glossary as Glossary | undefined,
  };
}
