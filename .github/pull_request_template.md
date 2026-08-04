# Summary

<!-- What changes, and why. Link any related issue. -->

## Verification

<!-- How you know it works. Paste the relevant command output, redacted. -->

```
npm run validate
```

## Checklist

- [ ] `npm run validate` passes (type-check, lint, tests, build, packaged smoke test, production audit).
- [ ] Behavior changes have regression tests.
- [ ] No credentials, Azure subscription or resource IDs, endpoint host names, private document content, or complete model responses appear in the diff, tests, fixtures, or this description.
- [ ] No new runtime dependency, or the PR explains why it is needed and what it pulls in.
- [ ] Errors and logs do not leak source document text or full model output.
- [ ] Fail-fast defaults are preserved unless the caller explicitly opts into partial success.
- [ ] `CHANGELOG.md` is updated for user-visible changes.
- [ ] Public API changes are typed and documented in `README.md`.

> Do not report a security vulnerability in a pull request. Use
> [Security Advisories](https://github.com/RubenSaucedo/lectoria/security/advisories/new).
