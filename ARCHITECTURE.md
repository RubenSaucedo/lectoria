# Architecture

This document explains how lectoria turns a document into multilingual
podcast audio, what each stage is responsible for, and where you can plug
your own implementation in.

For a polished visual version of the same diagram, open
[`assets/pipeline.html`](./assets/pipeline.html) in a browser.

## Pipeline at a glance

```mermaid
flowchart LR
    A[ingest] -->|SourceFile| B[parse]
    B -->|Document| C[script]
    C -->|PodcastScript| D[translate]
    D -->|PodcastScript[]| E[synthesize]
    E -->|SynthesizedAudio| F[package]
    F -->|Episode| G[distribute]

    classDef input  fill:#e3f0fb,stroke:#1e88e5,color:#0d3b6a;
    classDef llm    fill:#ece8ff,stroke:#5b3df5,color:#2b1a82;
    classDef audio  fill:#e0f4ec,stroke:#1f9d6e,color:#0e4b35;
    classDef output fill:#fbe9e0,stroke:#d97757,color:#5a2c14;

    class A,B input;
    class C,D llm;
    class E,F audio;
    class G output;
```

`runPipeline()` orchestrates the seven stages above, fanning out per target
language at the script stage and emitting `ProgressEvent`s along the way.
Each stage is a small interface in `src/types.ts`; the orchestrator never
touches a provider SDK directly.

## Stage reference

| # | Stage          | Input          | Output            | Default adapter              | Lives in           |
|---|----------------|----------------|-------------------|------------------------------|--------------------|
| 1 | **ingest**     | URI (path/URL) | `SourceFile[]`    | `LocalFileSystemIngest`      | `src/ingest/`      |
| 2 | **parse**      | `SourceFile`   | `Document`        | `Pdf/Docx/Markdown/Html`     | `src/parse/`       |
| 3 | **script**     | `Document`     | `PodcastScript`   | `AzureOpenAIScriptModel`     | `src/script/`      |
| 4 | **translate**  | `PodcastScript` | `PodcastScript[]` | (same `ScriptModel`)        | `src/translate/`   |
| 5 | **synthesize** | `PodcastScript` | `SynthesizedAudio` | `AzureSpeechTts`           | `src/synthesize/`  |
| 6 | **package**    | script + audio | `Episode`         | `Id3Packager`                | `src/package/`     |
| 7 | **distribute** | `Episode`      | (writes feed)     | `RssDistributor`             | `src/distribute/`  |

### 1. ingest

Pulls raw bytes from a URI. Today only `LocalFileSystemIngest` ships —
it accepts a file path or a folder. Folders are walked recursively by
default; pass `recursive: false` (or `--no-recursive` on the CLI) to
scan only the top level. Every emitted `SourceFile` carries a
`sourcePath` (POSIX-style, no extension) that records its location
relative to the ingest root — the pipeline uses it to mirror input
structure into `outDir`. The `IngestSource` interface is intentionally
URL shaped so a future Microsoft Graph (OneDrive) or HTTPS adapter
slots in without changing the orchestrator.

### 2. parse

Routes the `SourceFile` to the parser matching its `format`. Each parser
emits a normalized `Document` with `title`, `language`, and a list of
sections (each holding paragraphs). Markdown and HTML parsers preserve
heading hierarchy so the script stage can chunk by section.

### 3. script

The heart of the library. `AzureOpenAIScriptModel.generateScript()`
selects one of four prompt families based on `ScriptStyle`:

- `podcast` — single call (the prompt produces one host show end-to-end).
- `conversational` / `verbatim` / `dialogue` — **chunked one call per
  source section**. This is the only reliable way around Azure OpenAI's
  per-minute token cap (TPM) on long documents; a single 12 k-token
  request will keep returning 429s no matter how long you wait, because
  the cap is per minute, not per day.

The chunked path emits a `script:section` `ProgressEvent` after each
section so consumers can drive a progress bar.

### 4. translate

Thin wrapper over `ScriptModel.translateScript`. For each target language
that isn't the source language, it asks the model to re-render the script
preserving style and speaker tags. Scripts with >1 segment translate one
segment per call (same TPM reasoning as generation).

### 5. synthesize

`AzureSpeechTts.synthesize()` walks the segments, builds SSML per segment,
and dispatches each utterance to the right voice based on the `voice` id
on the utterance plus the `VoiceMap`. Consecutive same-voice utterances
are merged into a single `<voice>` block for cleaner audio. The Entra
auth path refreshes the token before every segment so long runs don't
expire mid-flight.

A parallel `synthesizeToBuffer()` returns the merged MP3 bytes in memory
instead of writing to disk — used by the `createTTS()` factory.

### 6. package

`Id3Packager` writes ID3 tags (title, artist, album = feed title) and
chapter markers derived from `SynthesizedAudio.segmentOffsetsSec`. Output
stays in place at the path the synthesize stage chose.

### 7. distribute

Optional — controlled by `RunOptions.distribute` (default `true`;
`--no-distribute` on the CLI). When enabled, the orchestrator instantiates
one `RssDistributor` per output directory: every folder that ends up
containing audio files becomes its own podcast feed, with its own
`feed.xml` and `episodes.json`. Feed titles are derived from the folder
name (title-cased: `data-science` → "Data Science"); description, author,
and image URL inherit from `config.feed`.

Replace this stage to upload to S3, Azure Blob, or post to a webhook —
when an override is passed in `RunOverrides.distributor`, the orchestrator
funnels every episode through that single instance instead of building
per-folder feeds, so test fakes and custom multi-feed routers stay simple.

## Output structure (multi-podcast layout)

Lectoria mirrors the input structure under `outDir` and treats every
directory that contains audio as its own podcast feed. Given:

```
samples/courses/
├── overview.md
├── python/
│   └── lesson-1.md
└── rust/
    └── intro.md
```

…running `lectoria run samples/courses/ --lang en` produces:

```
out/courses/
├── feed.xml             # "Courses" feed — just overview
├── episodes.json
├── overview-en.mp3
├── python/
│   ├── feed.xml         # "Python" feed — just lesson-1
│   ├── episodes.json
│   └── lesson-1-en.mp3
└── rust/
    ├── feed.xml         # "Rust" feed — just intro
    ├── episodes.json
    └── intro-en.mp3
```

A single-file input gets the same shape: `lectoria run lesson.md` lands
at `out/lesson/lesson-en.mp3` with `out/lesson/feed.xml` next to it. To
get audio only and skip the feeds, pass `--no-distribute`.

## Cross-cutting concerns

These are threaded through `RunOptions` rather than living on any single
stage:

- **`Logger`** — human-readable progress + warnings. Default is no-op;
  the CLI passes `createStreamLogger(process.stderr)`.
- **`onProgress`** — structured `ProgressEvent` callback. Use for
  progress bars, telemetry, or any programmatic consumer. Runs alongside
  the logger; pick one or both.
- **`AbortSignal`** — cancellation. Honored at every stage boundary plus
  inside the chunked script + TTS loops, so a long run cancels promptly.
- **`LectoriaAuth`** — discriminated union (`credential` / `apiKey` /
  `default`) passed independently to the script model and TTS provider.
  Lets a single host use, e.g., a `ManagedIdentityCredential` for OpenAI
  and an API key for Speech.

## Pluggability

Every stage is behind a typed interface. To swap a default, build your
own implementation and pass it as a `RunOverrides` entry:

```ts
import { runPipeline, type ScriptModel } from 'lectoria';

const myModel: ScriptModel = {
  async generateScript(doc, opts) { /* ... */ },
  async translateScript(script, lang, opts) { /* ... */ },
};

await runPipeline(config, { source: './doc.md' }, { scriptModel: myModel });
```

| Interface       | What you'd swap it for                                                 |
|-----------------|------------------------------------------------------------------------|
| `IngestSource`  | Microsoft Graph / OneDrive, S3, HTTPS, a stub for tests.               |
| `DocumentParser`| A new format (EPUB, RTF), or a custom Markdown flavor.                 |
| `ScriptModel`   | OpenAI direct, Anthropic, a local model via Ollama, a deterministic stub. |
| `TtsProvider`   | ElevenLabs, OpenAI TTS, Piper/Kokoro served over HTTP.                 |
| `Packager`      | OGG, WAV, chaptered M4A, or strip ID3 entirely.                        |
| `Distributor`   | S3 upload, Azure Blob upload, webhook POST, no-op for tests.           |

## What lives where

```
src/
├── types.ts          Document, PodcastScript, Episode, ProgressEvent contracts
├── config.ts         zod-validated env config + defineConfig() for programmatic use
├── pipeline.ts       runPipeline orchestrator — composes stages, fans out per language
├── factory.ts        createTTS() — lightweight text-to-speech client
├── estimate.ts       estimateCost() — preview API spend without calling Azure
├── logger.ts         Logger interface (no-op default, createStreamLogger for CLIs)
├── azure-auth.ts     LectoriaAuth union + credential resolution
├── cli.ts            CLI entry (commander)
├── ingest/           Source adapters
├── parse/            Document parsers
├── script/           LLM script generation
├── translate/        Cross-language rewriting (uses ScriptModel)
├── synthesize/       TTS providers
├── package/          MP3 + ID3 + chapter markers
└── distribute/       Local writer + RSS feed
```

## Design choices worth knowing

- **No state machine.** The pipeline runs straight through. Resume and
  retry are a v1 concern. Failures bubble up so the CLI / host can decide
  how to handle them.
- **ESM only.** `"type": "module"` in package.json; subpath imports work
  via the `exports` map.
- **Adapters know their own auth.** The script model and TTS provider
  each carry their own `LectoriaAuth`. The pipeline doesn't centralize
  credentials so library consumers can mix modes per provider.
- **Progress is push, not pull.** `onProgress` is a callback rather than
  an async iterator so adapters don't have to coordinate yielding. If
  you want an iterator, build one over the callback.
- **Chunking is non-optional for long docs.** The script stage forces
  per-section chunking on `conversational` / `verbatim` / `dialogue`
  because Azure OpenAI's TPM cap makes "one big request + retry" a
  guaranteed failure on documents over ~8 k tokens.
