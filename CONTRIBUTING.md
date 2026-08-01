# Contributing

Lectoria is an Azure-first TypeScript library. Keep changes focused on
document-to-learning-audio reliability; additional providers should be
introduced only when they solve a demonstrated use case without weakening
the default path.

## Development

```bash
npm ci
npm run validate
```

`npm run validate` type-checks, lints, runs the test suite, builds the
package, installs the generated tarball with lifecycle scripts disabled,
smoke-tests its API and CLI, and audits production dependencies.

Add regression tests for every behavior change. Provider integrations should
be tested through deterministic contract tests; live Azure smoke tests must
use dedicated resources and must never run for untrusted pull requests.

## Pull requests

- Keep public API changes typed and documented.
- Do not log source documents, complete model responses, credentials, or Azure resource IDs.
- Preserve fail-fast defaults unless the caller explicitly opts into partial success.
- Update `CHANGELOG.md` for user-visible changes.
- Keep default cost estimates local and clearly labeled as approximations;
  update the pricing verification date when changing default rates.

## Releases

1. Run `npm ci && npm run validate`.
2. Confirm the package version and changelog agree.
3. Inspect `npm pack --dry-run`.
4. Publish from a protected GitHub environment with npm provenance enabled.
5. If verification fails, deprecate the broken npm version and publish a corrected patch; npm versions are immutable.
