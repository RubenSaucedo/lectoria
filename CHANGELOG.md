# Changelog

All notable changes to this project are documented in this file.

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
