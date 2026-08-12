# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

### Added

- **`lectoria speak` — one piece of text in, one audio file and a measured
  duration out.** The library has always been able to do this (`createTTS()`
  returns Azure's own `audioDuration`), but the CLI only exposed `run`, the full
  document-to-podcast pipeline. Callers who already have the words they want
  spoken had no way in, and routing them through `run` would pay an LLM to
  rewrite text they authored.

  The motivating consumer places narration against a video recording, where the
  measured duration is the whole point: without it, speech has to be stretched
  or guessed at.

  - `--json` on stdout with human output on stderr, so it composes in a script.
  - `--text-file` alongside `--text`, because a line containing quotes or
    newlines does not survive cmd.exe or PowerShell quoting.
  - `--estimate-only`, which projects cost and duration **without contacting
    Azure**, so a consent prompt can be shown before anyone is billed. It does
    not reuse `estimateCost()`, which is document-shaped and prices script
    generation and translation this command never performs.
  - Distinct exit codes — `1` usage, `2` not-configured, `3` synthesis-failed —
    mirrored as `error.reason` in `--json`. The line between 2 and 3 is the
    useful one: the first is a human setting a variable and nothing was billed;
    the second may be transient.
  - **Retries default to 0**, unlike `run`. A retry is a second paid synthesis,
    and a client that saw a timeout cannot tell whether the first call also
    produced audio. Opt in with `--retries`.

  The estimate reports `estimatedDurationSec` and deliberately never
  `durationSec`. Sharing the key would let a caller read `.durationSec` and
  silently receive a ±20% guess where it expected a measurement; a different key
  makes that an immediate failure instead of a subtly wrong result.

- **Tests for the PDF parser**, which previously had none: text extraction,
  page count, `/Title` preference over file name, file-name fallback, page
  separator suppression, and empty-document rejection, against a committed
  824-byte hand-built PDF fixture.

### Changed

- `createTTS()` now forwards `timeoutMs`, `maxRetries` and `retryDelayMs` to the
  Azure Speech provider. They were already supported one layer down but
  unreachable through the factory, so no factory consumer could decline a
  retry — which `speak` must do to avoid billing twice for one request.

- **Raised the supported Node.js range to `^22.22.2 || ^24.15.0 || >=26.0.0`.**
  Required by jsdom 30; the previous `>=22.13` floor would have installed a
  jsdom that does not support the declared range.
- Upgraded `openai` to 7.x and `jsdom` to 30.x. The Azure OpenAI client surface
  used here (the `AzureOpenAI` constructor with `azureADTokenProvider` and
  `chat.completions.create` with `response_format: json_object`) is unchanged.
- Upgraded `zod` to 4.x. Model-output validation errors keep the same shape;
  the per-issue messages are slightly reworded by zod itself.
- Upgraded `pdf-parse` to 2.x and rewrote `PdfParser` for its class-based API.
  Removed the now-obsolete `@types/pdf-parse`, since v2 ships its own types.
- Upgraded `actions/checkout` to v7 and `actions/setup-node` to v7, still
  pinned to commit SHAs.

### Fixed

- **PDF text no longer contains `-- N of M --` page separators.** pdf-parse 2
  inserts them by default; left alone they would have been sent to the model
  and read aloud in the generated audio.
- `PdfParser` now releases the pdf.js worker and document on every exit path,
  so a batch run over many PDFs does not leak one document per file.

## [0.1.0] - 2026-07-30

### Added

- Strict runtime validation and one bounded repair attempt for Azure OpenAI script output.
- Content-addressed checkpoints for scripts, translations, raw Speech audio, and episodes.
- Speech request deadlines, transient retries, and active cancellation.
- Atomic output writes, RSS locking, collision-safe filenames, and source-local batch errors.
- Plain-text parsing, richer Markdown/HTML/DOCX extraction, source-language detection and override.
- Ingest and parser overrides in `runPipeline`.
- Installed-package smoke tests, ESLint, production dependency auditing, and privacy documentation.
- Default-on cost preflight with configurable warning thresholds, hard USD ceilings, structured assessments, and explicit approval mode.

### Changed

- Podcast scripts now retain an explicit `documentId`; IDs are no longer parsed from strings.
- RSS generation requires an explicit public audio base URL and preserves nested output paths.
- Production and development dependencies were upgraded to patched versions.
