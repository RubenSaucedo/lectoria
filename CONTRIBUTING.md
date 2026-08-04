# Contributing

Lectoria is an Azure-first TypeScript library. Keep changes focused on
document-to-learning-audio reliability; additional providers should be
introduced only when they solve a demonstrated use case without weakening
the default path.

By participating you agree to the [Code of Conduct](./CODE_OF_CONDUCT.md).

## Security first

**Never open a public issue or pull request for a vulnerability.** Report it
privately through
[Security Advisories](https://github.com/RubenSaucedo/lectoria/security/advisories/new).
See [SECURITY.md](./SECURITY.md) for what is in scope.

Nothing you contribute — code, tests, fixtures, issue text, or commit
messages — may contain credentials, Azure subscription or resource IDs,
endpoint host names, private document content, or complete model responses.
Secret scanning with push protection is enabled on this repository, but it is
a backstop, not a substitute for checking your own diff.

## Development

```bash
nvm use          # honors .nvmrc (Node 24); any Node in the supported
                 # range works — see "engines" in package.json
npm ci
npm run validate
```

`npm run validate` type-checks, lints, runs the test suite, builds the
package, installs the generated tarball with lifecycle scripts disabled,
smoke-tests its API and CLI, and audits production dependencies.

Add regression tests for every behavior change. Provider integrations should
be tested through deterministic contract tests; live Azure smoke tests must
use dedicated resources and must never run for untrusted pull requests. CI is
triggered by `pull_request`, which does not expose repository secrets to fork
branches — do not change it to `pull_request_target`.

## Dependencies

Every runtime dependency is attack surface, and the parsers already handle
untrusted files. A pull request that adds one must say why it is needed and
what it pulls in; prefer a Node built-in or a small amount of local code.
Workflow actions are pinned to commit SHAs and updated by Dependabot — keep
them pinned.

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
3. Inspect `npm pack --dry-run` and confirm no unintended file is included.
4. Publish and tag the release.
5. If verification fails, deprecate the broken npm version and publish a corrected patch; npm versions are immutable.

Publishing is manual today. Moving it into a GitHub Actions workflow that uses
a protected environment and `--provenance`, so releases are verifiably built
from this repository, is planned before 1.0.
