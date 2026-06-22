# lectoria

> Turn written learning content into multilingual podcast audio.
> _Lectoria_ — from Spanish *lectura* (reading) — narrated so you can learn while you move.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![CI](https://github.com/RubenSaucedo/lectoria/actions/workflows/ci.yml/badge.svg)](https://github.com/RubenSaucedo/lectoria/actions/workflows/ci.yml)

`lectoria` is a TypeScript CLI + library that takes documents (PDF, DOCX,
Markdown, HTML) and produces audio episodes in **English and Spanish** —
as podcast-style shows, natural read-alongs, or near-verbatim narration —
packaged as MP3s with a standard RSS feed you can publish to Spotify,
Apple Podcasts, or anywhere else that ingests RSS.

## Why

Reading dense documentation or course material takes focused time. Listening
doesn't — you can do it on a walk, a commute, or during chores. `lectoria`
exists so the content you _want_ to learn can travel with you in audio form,
in the language you prefer.

## Pipeline

```
┌─────────┐   ┌────────┐   ┌─────────┐   ┌──────────┐   ┌────────┐   ┌──────────┐   ┌──────────┐
│ Ingest  │ → │ Parse  │ → │ Script  │ → │Translate │ → │  TTS   │ → │ Package  │ → │Distribute│
└─────────┘   └────────┘   └─────────┘   └──────────┘   └────────┘   └──────────┘   └──────────┘
 OneDrive,    PDF/DOCX/   LLM produces    LLM EN↔ES    Azure TTS    MP3 + ID3 +    RSS feed +
 URL, local   MD/HTML →   spoken script   (per epi-    (SSML,       chapter        Blob /
 FS, GitHub   normalized  in chosen       sode lang)   multi-       markers        Pages /
              Document    style                        voice)                       Spotify
```

Each stage is an adapter behind a typed interface. Swap providers (TTS, LLM,
storage) without rewriting the pipeline.

> 📊 **Visual version:** open [`assets/pipeline.html`](./assets/pipeline.html) in a browser for a color-coded diagram with contracts.
> 📐 **Full reference:** see [`ARCHITECTURE.md`](./ARCHITECTURE.md) for stage-by-stage details.

## Quickstart

```bash
# 1. Install
npm install

# 2. Configure (copy then edit)
cp .env.example .env

# 3. Drop a doc in samples/
cp ~/Downloads/some-course.pdf samples/

# 4. Run the pipeline
npx tsx src/cli.ts run samples/some-course.pdf --lang en,es --out ./out
```

You'll get `out/some-course/some-course-en.mp3`,
`out/some-course/some-course-es.mp3`, plus `out/some-course/feed.xml` and
`out/some-course/episodes.json` next to them. Every folder that ends up
containing audio gets its own podcast feed — see [Output layout](#output-layout)
for the multi-podcast model.

## Provisioning Azure resources

`lectoria` talks to **Azure OpenAI** (for the script + translation stages)
and **Azure AI Speech** (for TTS). If you already have both, skip to
[Configuration](#configuration). Otherwise the repo ships two PowerShell
scripts that stand everything up and tear it back down.

### What you need first

- The [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli) (`az`) installed.
- An Azure subscription where you can create resources. The provisioning
  script needs either **Owner**, or **Contributor + User Access Administrator**
  on the subscription (the second role is what lets it assign RBAC roles
  to your user).
- `az login` completed once on the machine.

### Provision (creates the resource group + everything in it)

```powershell
az login
./scripts/provision.ps1 -SubscriptionId <your-subscription-id>
```

What gets created (in a single resource group, default name `lectoria-rg`):

| Resource                  | SKU | Notes                                                          |
| ------------------------- | --- | -------------------------------------------------------------- |
| Resource group            | —   | Holds everything below so teardown is one command.             |
| Azure AI Speech account   | S0  | Standard neural TTS tier.                                      |
| Azure OpenAI account      | S0  | Custom-domain enabled (required for Entra ID auth).            |
| GPT-4o model deployment   | —   | 10 TPM units by default; tune with `-OpenAICapacity`.          |
| RBAC role assignments     | —   | `Cognitive Services User` + `Cognitive Services OpenAI User` assigned to your signed-in user, scoped to each account. |

When it finishes, the script prints the exact `.env` lines to paste:

```text
AZURE_SPEECH_REGION=eastus
AZURE_SPEECH_RESOURCE_ID=/subscriptions/.../speech-resource
AZURE_OPENAI_ENDPOINT=https://lectoria-openai-1234.openai.azure.com/
AZURE_OPENAI_DEPLOYMENT=gpt-4o
AZURE_OPENAI_API_VERSION=2024-08-01-preview
```

Common overrides:

```powershell
# Different region or resource group name
./scripts/provision.ps1 -SubscriptionId <id> -Location eastus2 -ResourceGroup my-rg

# Custom OpenAI deployment name / capacity
./scripts/provision.ps1 -SubscriptionId <id> -OpenAIDeployment gpt-4o-prod -OpenAICapacity 50
```

### Teardown (deletes the resource group + purges soft-deleted accounts)

```powershell
./scripts/teardown.ps1 -SubscriptionId <your-subscription-id>
```

Two things to know:

- **It asks for the resource group name as confirmation** before deleting
  anything. Pass `-Force` to skip the prompt in CI.
- **Azure OpenAI accounts soft-delete by default** — the name stays
  reserved for ~48 hours, which blocks you from re-running provision with
  the same names. The teardown script purges them automatically so you
  can re-provision immediately. Pass `-PurgeSoftDeleted:$false` to leave
  them in the 48 h recovery window.

## Configuration

All config lives in `.env`. See [`.env.example`](.env.example) for the full
catalog. Required for v0:

| Variable                   | Purpose                                                       |
| -------------------------- | ------------------------------------------------------------- |
| `AZURE_SPEECH_REGION`      | e.g. `eastus`                                                 |
| `AZURE_SPEECH_RESOURCE_ID` | Full Azure resource ID of the Speech resource (see below)     |
| `AZURE_OPENAI_ENDPOINT`    | Your Azure OpenAI resource endpoint                           |
| `AZURE_OPENAI_DEPLOYMENT`  | Deployed model name (e.g. `gpt-4o`)                           |
| `LECTORIA_VOICE_EN`        | Azure neural voice id for English                             |
| `LECTORIA_VOICE_ES`        | Azure neural voice id for Spanish                             |
| `LECTORIA_GLOSSARY_FILE`   | (optional) Path to a JSON glossary. See [Glossaries](#glossaries-english-pronunciation-across-translations). |

### Auth: Microsoft Entra ID (no API keys)

`lectoria` authenticates to both Azure services using **Microsoft Entra ID**
via `DefaultAzureCredential` — no static API keys for the CLI. If you used
[`scripts/provision.ps1`](#provision-creates-the-resource-group--everything-in-it)
above, the RBAC roles are already assigned to your user and `az login` is
enough.

**Manual path** — if you already have the resources but need to add the
RBAC roles yourself:

```bash
# 1. Sign in once on this machine.
az login

# 2. Assign yourself the right RBAC roles on each resource.
az role assignment create \
  --assignee <your-upn-or-object-id> \
  --role "Cognitive Services User" \
  --scope $AZURE_SPEECH_RESOURCE_ID

az role assignment create \
  --assignee <your-upn-or-object-id> \
  --role "Cognitive Services OpenAI User" \
  --scope <your-azure-openai-resource-id>

# 3. Find your Speech resource ID for the .env file:
az cognitiveservices account show -n <name> -g <rg> --query id -o tsv
```

> Library consumers (importing `lectoria` as an npm package) can also use
> API keys — pass `auth: { kind: 'apiKey', apiKey }` to the adapter
> constructor. See [Using lectoria as a library](#using-lectoria-as-a-library).

## CLI

```
lectoria run <source>          Run the full pipeline on a file or folder.
  --lang <list>                Comma-separated target languages (default: en,es).
  --out <dir>                  Output directory (default: ./out).
  --style <style>              podcast | conversational | verbatim | dialogue
                               (default: conversational).
  --speakers <list>            Dialogue cast as id:Name pairs (only with
                               --style dialogue). Default: host:Ava,guest:Jorge.
  --glossary <path>            Path to a JSON glossary file. Terms listed
                               there keep English pronunciation in non-English
                               narrations (e.g. "MCP" stays "em-see-pee" inside
                               a Spanish episode instead of "eme-ce-pe"). See
                               "Glossaries" below. Overrides
                               LECTORIA_GLOSSARY_FILE.
  --no-recursive               When the source is a folder, scan only its
                               top level instead of walking subdirectories.
  --no-distribute              Skip RSS feed + episodes.json generation.
                               Produce audio files only.

lectoria parse <source>        Parse a doc and print the normalized Document JSON.
lectoria list                  List episodes across every feed under ./out.
```

### Output layout

Lectoria mirrors the input structure under `outDir`, and every directory
that ends up containing audio becomes its own podcast (with its own
`feed.xml` and `episodes.json`). Given:

```
samples/courses/
├── overview.md
├── python/
│   └── lesson-1.md
└── rust/
    └── intro.md
```

…`lectoria run samples/courses/ --lang en` produces:

```
out/courses/
├── feed.xml             # "Courses" feed — overview only
├── episodes.json
├── overview-en.mp3
├── python/
│   ├── feed.xml         # "Python" feed — lesson-1 only
│   ├── episodes.json
│   └── lesson-1-en.mp3
└── rust/
    ├── feed.xml         # "Rust" feed — intro only
    ├── episodes.json
    └── intro-en.mp3
```

A single-file input gets the same shape: `lectoria run lesson.md` lands
at `out/lesson/lesson-en.mp3` with `out/lesson/feed.xml` next to it.
Pass `--no-distribute` to skip the feeds and produce audio only, or
`--no-recursive` to scan only the top level of a folder.

### Script styles

Four styles, ordered from most adapted (left) to most faithful (right),
with `dialogue` as a separate two-voice mode.

> 🎨 **Visual version:** open [`assets/script-styles.html`](./assets/script-styles.html) in a browser for a side-by-side card layout.

| Style              | Voices  | Fidelity | What it does                                                                                                                          |
| ------------------ | ------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 🎙️ `podcast`       | single  | lowest   | Friendly host show with welcome, 3–7 chapters, recap, sign-off. Most "produced" feel.                                                  |
| 💬 `conversational` *(default)* | single  | ~70%     | Natural read-along. No welcome/sign-off, but the model restructures lists, merges short paragraphs, adds spoken signposts so it flows. |
| 📖 `verbatim`      | single  | ~95%     | Read the doc essentially as-is. No invented intro/outro, no banter — just the content, lightly cleaned for spoken delivery.            |
| 👥 `dialogue`      | two+    | —        | Two named speakers discuss the material NotebookLM-style. Each utterance dispatches to its own voice per language.                     |

Notes:

- **`podcast`** rewrites the document into a podcast episode end-to-end.
  Best when you want the material to feel like a show. (This was previously
  named `conversational`.)
- **`conversational`** *(default)* aims for ~70% fidelity: the missing 30%
  is visual scaffolding that doesn't carry meaning when spoken, plus the
  small connective tissue needed for a smooth listen.
- **`verbatim`** narrates tables, lists, images, and code blocks like a
  calm person walking you through the doc (not like a screen reader saying
  "row one, column one"). Use it when you want to listen now and dig back
  into the doc later. Translations stay as faithful as possible.
- **`dialogue`** uses a default cast of `host` + `guest`; each speaker id
  keys into your `VoiceMap`, so a dialogue script in English can be
  re-synthesised in Spanish without changing the script. Pass
  `--speakers host:Ava,guest:Jorge` to name the cast (the names show up in
  the prompt so the model writes for the right voice), and set
  `LECTORIA_VOICE_EN_GUEST` / `LECTORIA_VOICE_ES_GUEST` (or any other
  speaker id) in your `.env` to map each speaker to a concrete Azure voice.

  ```bash
  npx tsx src/cli.ts run samples/spec.md --lang en --style dialogue \
    --speakers host:Ava,guest:Andrew
  ```

  Or from your own code:

  ```ts
  await runPipeline(config, {
    source: './spec.md',
    style: {
      kind: 'dialogue',
      speakers: [
        { id: 'host', name: 'Ava' },
        { id: 'guest', name: 'Andrew', persona: 'a curious learner' },
      ],
    },
  });
  ```

### Long documents and Azure OpenAI TPM (429s)

For `conversational`, `verbatim`, and `dialogue` styles, lectoria generates
the script **one source section per API call** instead of one giant request. This
matches what those prompts already promise ("each source section maps to
one body segment") and is the only reliable way around Azure OpenAI's
per-minute token cap (TPM). A 12k-token document that exceeds your
deployment's TPM in a single request will keep 429-ing no matter how
long you wait — the cap is per-minute, so each retry trips the same
ceiling. Splitting the work into ~1k-token chunks fixes that.

Translation works the same way: scripts with more than one segment are
translated one segment at a time.

Progress is printed to stderr (`[script] section 3/47 ✓`) so you can see
the run advance. The `podcast` style still uses a single call because its
prompt produces one host show (welcome / chapters / outro) that doesn't
decompose section-by-section.

Example:

```bash
npx tsx src/cli.ts run samples/spec.md --lang en,es --style verbatim --out ./out
```

## Glossaries: English pronunciation across translations

Lectoria translates scripts into the target language, but every project has
proper nouns, brand names, and acronyms that should keep their original
pronunciation — `MCP`, `CCA`, `HubSpot`, `ADO 5417982`, `Channel Agent`.
Without help, a Spanish narrator will read `MCP` as "eme-ce-pe" instead of
"em-see-pee", which sounds wrong and breaks comprehension for bilingual
listeners.

A **glossary** is a per-project list of terms that should always be
pronounced in English (Latin letter names) even when the surrounding
narration is in another language. Lectoria enforces it in two layers:

1. The script-generation prompt enumerates the glossary so the LLM wraps
   every occurrence in a `[[en]]…[[/en]]` marker.
2. A deterministic post-processor scans the finished script and wraps any
   occurrence the model missed — so terms that slip past the LLM still get
   the right pronunciation. This is the safety net.

The synthesis stage rewrites the marker into SSML
`<lang xml:lang="en-US">…</lang>` so Azure Neural TTS pronounces the
wrapped span with English phonetics inside the non-English voice. In English
scripts the marker is stripped — no impact.

### Glossary file format

```json
{
  "terms": [
    "MCP",
    "CCA",
    "HubSpot",
    "Asana",
    "ADO 5417982",
    { "term": "DA", "meaning": "Domain Admin" },
    { "term": "asana", "caseSensitive": false }
  ]
}
```

Each entry is either a bare string or an object. Bare ALL-CAPS terms
(`"MCP"`) are matched case-sensitively so the wrap never fires inside
identifiers like `compositeMcpClient`. Mixed-case terms (`"HubSpot"`) are
matched case-insensitively by default. Override either with the explicit
`caseSensitive` field. The optional `meaning` field is sent to the script
model as a hint so it doesn't expand the acronym.

### How to apply a glossary

```bash
# CLI flag (highest precedence)
npx tsx src/cli.ts run samples/spec.md --lang en,es --glossary ./glossary.json

# Or via env var, picked up automatically
LECTORIA_GLOSSARY_FILE=./glossary.json npx tsx src/cli.ts run samples/spec.md --lang en,es
```

```ts
// Library form
import { runPipeline, defineConfig } from 'lectoria';

const config = defineConfig({
  glossary: { terms: ['MCP', 'HubSpot', { term: 'DA', meaning: 'Domain Admin' }] },
  // …azure, voices, etc.
});

await runPipeline(config, { source: './spec.md' });

// Or pass it per-run, overriding any glossary on config:
await runPipeline(config, {
  source: './spec.md',
  glossary: { terms: ['Channel Agent', 'ADO 5417982'] },
});
```

## Using lectoria as a library

`lectoria` is published as an ESM npm module with full TypeScript types. The
CLI above is just one consumer of the library — you can also drive the
pipeline from your own code (a Copilot plugin, a backend job, another CLI,
a test fixture). Pick the auth mode that fits your host and, optionally,
override any pipeline stage with your own adapter.

### Auth modes

Three ways to authenticate against Azure OpenAI + Azure Speech, from most
explicit to most magical:

```ts
import { AzureCliCredential } from '@azure/identity';
import { runPipeline, defineConfig, AzureOpenAIScriptModel, AzureSpeechTts } from 'lectoria';

// 1. Bring your own TokenCredential (recommended for plugins / services).
//    Works with AzureCliCredential, ManagedIdentityCredential,
//    WorkloadIdentityCredential, InteractiveBrowserCredential, etc.
const config = defineConfig({
  azure: {
    openai: { endpoint: 'https://my.openai.azure.com', deployment: 'gpt-4o', apiVersion: '2024-08-01-preview' },
    speech: { region: 'eastus', resourceId: '/subscriptions/.../speech-resource' },
  },
});
const credential = new AzureCliCredential();
await runPipeline(config, { source: './doc.md' }, {
  scriptModel: new AzureOpenAIScriptModel({
    ...config.azure.openai,
    auth: { kind: 'credential', credential },
  }),
  tts: new AzureSpeechTts({
    region: config.azure.speech.region,
    resourceId: config.azure.speech.resourceId,
    auth: { kind: 'credential', credential },
  }),
});

// 2. API key — for hosts that don't speak Entra ID.
const apiKeyModel = new AzureOpenAIScriptModel({
  endpoint: 'https://my.openai.azure.com',
  deployment: 'gpt-4o',
  apiVersion: '2024-08-01-preview',
  auth: { kind: 'apiKey', apiKey: process.env.AZURE_OPENAI_KEY! },
});

// 3. Default — falls back to DefaultAzureCredential (env / MI / az login).
//    This is what the CLI uses so `az login` "just works" locally.
const defaultModel = new AzureOpenAIScriptModel({
  endpoint: 'https://my.openai.azure.com',
  deployment: 'gpt-4o',
  apiVersion: '2024-08-01-preview',
  // auth omitted → { kind: 'default' }
});
```

### Adapter overrides

Every pipeline stage is behind a typed interface (`ScriptModel`,
`TtsProvider`, `Packager`, `Distributor`). Pass your own implementation
for any subset; the rest fall back to the default Azure-backed adapters:

```ts
import { runPipeline, defineConfig, type ScriptModel } from 'lectoria';

const myModel: ScriptModel = {
  async generateScript(doc, opts) { /* ... */ },
  async translateScript(script, targetLanguage, opts) { /* ... */ },
};

await runPipeline(
  defineConfig({ /* ... */ }),
  { source: './doc.md', targetLanguages: ['en'] },
  { scriptModel: myModel }, // tts/packager/distributor still default
);
```

### Logging and cancellation

Library code stays silent by default — no `console.log`, no stderr writes.
Pass a `Logger` to see progress, and an `AbortSignal` to cancel mid-run:

```ts
import { runPipeline, createStreamLogger } from 'lectoria';

const controller = new AbortController();
setTimeout(() => controller.abort(), 30_000); // cancel after 30s

await runPipeline(config, {
  source: './doc.md',
  logger: createStreamLogger(process.stderr),
  signal: controller.signal,
});
```

### Progress events

For programmatic consumers — a progress bar, a UI, a telemetry pipe — pass
`onProgress` instead of (or alongside) `logger`. You get structured events
per stage: `parse:start`, `script:section`, `translate:segment`,
`tts:segment`, `episode:complete`, `run:complete`:

```ts
import { runPipeline } from 'lectoria';

await runPipeline(config, {
  source: './doc.md',
  onProgress: (event) => {
    switch (event.phase) {
      case 'script:section':
        console.log(`script: ${event.sectionIndex + 1}/${event.sectionTotal}`);
        break;
      case 'tts:segment':
        console.log(`tts (${event.language}): ${event.segmentIndex + 1}/${event.segmentTotal}`);
        break;
      case 'episode:complete':
        console.log(`✓ ${event.audioPath} (${event.durationSec.toFixed(0)}s)`);
        break;
    }
  },
});
```

Each event is a discriminated union — TypeScript narrows on `event.phase`,
so the IDE shows you what other fields each variant carries (segment counts,
language, durations, etc.).

### Estimating cost before a run

`estimateCost()` previews the API spend of a run without calling Azure.
Useful for UI cost previews, budget caps, or a quick sanity check before
running a 12k-token doc:

```ts
import { estimateCost } from 'lectoria';

const est = await estimateCost({
  source: './lesson.md',
  languages: ['en', 'es'],
  style: { kind: 'conversational' },
});

console.log(`Estimated total: $${est.total.usd.total.toFixed(2)}`);
console.log(`Audio length: ~${est.total.audioMinutes.toFixed(0)} min`);
for (const lang of est.languages) {
  console.log(`  ${lang.language}: $${lang.usd.total.toFixed(2)}`);
}
// Always show the assumptions next to the dollar figure:
for (const note of est.assumptions) console.log(`  ⓘ ${note}`);
```

The numbers are **rough heuristics**, not a quote — token counts are
approximated as chars/4, output expansion is a per-style multiplier, and
the default `pricing` table is a snapshot of Azure list prices. Pass
`opts.pricing` to override with your own rates:

```ts
const est = await estimateCost(
  { source: './lesson.md', languages: ['en'] },
  { pricing: { openAiInputPer1M: 5.0 } }, // partial override; rest default
);
```

The `assumptions` array on the result spells out every heuristic so you
can surface them verbatim alongside the number.

### Plain text-to-speech with `createTTS()`

When you already have the text you want spoken — an LLM response, a
notification message, a generated chapter — skip the pipeline and use
the lightweight `createTTS()` factory:

```ts
import { createTTS } from 'lectoria';

const tts = createTTS({
  region: 'westus',
  auth: { kind: 'apiKey', apiKey: process.env.AZURE_SPEECH_KEY! },
  defaultVoice: 'en-US-AvaMultilingualNeural',
  defaultLanguage: 'en',
});

// Raw text → MP3 file
await tts.speakToFile('Welcome to the lesson on leverage.', './intro.mp3');

// Raw text → in-memory buffer (e.g. to stream to a client)
const { bytes, durationSec } = await tts.speak('Hola mundo', {
  voice: 'es-MX-DaliaNeural',
  language: 'es',
});

// Already-built PodcastScript → MP3 (multi-segment, multi-voice)
await tts.synthesizeScript(myScript, {
  outputPath: './out.mp3',
  voices: { host: { en: 'en-US-AvaMultilingualNeural' } },
});
```

`createTTS()` is a thin wrapper around `AzureSpeechTts` — for full
multi-speaker dialogue or chunked-by-section narration, drive the whole
pipeline with `runPipeline()` instead.

### Subpath imports

For tree-shaking, every adapter is reachable via a subpath import:

```ts
import { AzureOpenAIScriptModel } from 'lectoria/script';
import { AzureSpeechTts } from 'lectoria/synthesize';
import { RssDistributor } from 'lectoria/distribute';
import { Id3Packager } from 'lectoria/package';
import { MarkdownParser } from 'lectoria/parse';
import { createTTS } from 'lectoria/factory';
import { estimateCost } from 'lectoria/estimate';
import type { ScriptModel, TtsProvider, PodcastScript, ProgressEvent } from 'lectoria/types';
```

## Architecture

For the full stage-by-stage reference (contracts, cross-cutting concerns,
pluggable surfaces, design choices) see [`ARCHITECTURE.md`](./ARCHITECTURE.md).
For a visual diagram, open [`assets/pipeline.html`](./assets/pipeline.html)
in a browser.

Quick mental model:

```
src/
├── types.ts          Document, PodcastScript, Episode, ProgressEvent
├── pipeline.ts       runPipeline orchestrator
├── factory.ts        createTTS() — lightweight text-to-speech client
├── estimate.ts       estimateCost() — preview API spend
├── ingest/ parse/ script/ translate/ synthesize/ package/ distribute/
└── cli.ts            CLI entry (commander)
```

## Roadmap

- **v0 (this scaffold)** — local FS ingest, all stage interfaces, Azure
  Speech + Azure OpenAI adapters stubbed, local MP3 + RSS output.
- **v1** — full parser implementations, OneDrive ingest (Microsoft Graph),
  Azure Blob upload for hosted RSS.
- **v2** — watch mode, multi-voice dialog scripts, optional ElevenLabs
  adapter, optional thin Copilot CLI plugin wrapper.

## Contributing

```bash
# 1. Install deps
npm install

# 2. Type-check + compile
npm run build

# 3. Run the test suite (no Azure credentials needed)
npm test

# Watch mode for tight iteration
npm run test:watch
```

Tests are co-located as `src/**/*.test.ts` and powered by
[vitest](https://vitest.dev). The pipeline integration test stubs the
Azure script + TTS adapters so you can run the full orchestrator
end-to-end without spending a cent.

CI runs on every push and pull request against `main` (Node 20 + 22).
See [`.github/workflows/ci.yml`](./.github/workflows/ci.yml).

## License

MIT
