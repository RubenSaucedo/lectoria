import { z } from 'zod';

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
  voices: z.record(z.string(), z.record(z.string(), z.string())),
  targetLanguages: z.array(z.string()).min(1),
  outDir: z.string().min(1),
  feed: z.object({
    title: z.string().min(1),
    description: z.string().min(1),
    author: z.string(),
    siteUrl: z.string().url(),
    imageUrl: z.string().url(),
  }),
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
    voices: {
      host: {
        en: process.env.LECTORIA_VOICE_EN ?? 'en-US-AvaMultilingualNeural',
        es: process.env.LECTORIA_VOICE_ES ?? 'es-MX-DaliaNeural',
      },
      guest: {
        en: process.env.LECTORIA_VOICE_EN_GUEST ?? 'en-US-AndrewMultilingualNeural',
        es: process.env.LECTORIA_VOICE_ES_GUEST ?? 'es-MX-JorgeNeural',
      },
    },
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
  };

  return ConfigSchema.parse(raw);
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
    voices: (input.voices as Config['voices']) ?? {
      host: { en: 'en-US-AvaMultilingualNeural', es: 'es-MX-DaliaNeural' },
      guest: { en: 'en-US-AndrewMultilingualNeural', es: 'es-MX-JorgeNeural' },
    },
    targetLanguages: (input.targetLanguages as string[]) ?? ['en', 'es'],
    outDir: input.outDir ?? './out',
    feed: {
      title: input.feed?.title ?? 'Lectoria',
      description: input.feed?.description ?? 'Written learning content, narrated.',
      author: input.feed?.author ?? '',
      siteUrl: input.feed?.siteUrl ?? 'https://example.com',
      imageUrl: input.feed?.imageUrl ?? 'https://example.com/cover.jpg',
    },
  };
}
