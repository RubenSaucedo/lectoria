# Security policy

## Supported versions

Lectoria is pre-1.0. Only the latest release receives security fixes; there
are no backports to earlier versions.

## Reporting a vulnerability

Report privately through
[GitHub Security Advisories](https://github.com/RubenSaucedo/lectoria/security/advisories/new).
Private vulnerability reporting is enabled for this repository.

**Do not open a public issue or pull request for a vulnerability.** Do not
include an exploit, credential, Azure subscription or resource identifier,
private document, or model response derived from sensitive input in any public
thread.

A useful report names the affected version, the entry point (for example a
crafted source document, a configuration value, or a checkpoint file), what an
attacker gains, and the smallest reproduction you can share.

This project is maintained by one person in their own time. Expect an
acknowledgement within about 7 days and, once a fix is agreed, a release
followed by a published advisory crediting you unless you ask otherwise.
Please allow the fix to ship before disclosing publicly.

## What counts as a vulnerability here

Lectoria parses documents you may not control and spends money against your
Azure resources, so the interesting boundary is *untrusted input reaching a
privileged effect*. In scope:

- Writing outside the configured output or checkpoint directory through a
  crafted file name, `sourcePath`, or archive entry.
- Leaking credentials, tokens, Azure resource identifiers, or complete model
  responses into logs, thrown errors, MP3 metadata, the RSS feed, or the
  episode index.
- Injection into generated output that a document controls: XML injection into
  `feed.xml` or `episodes.json`, or SSML injection reaching Azure AI Speech.
- Bypassing the cost preflight so that a crafted document causes spend beyond a
  configured `maxEstimatedUsd` ceiling or a declined approval.
- Unsafe parsing of checkpoint, index, or model JSON, including prototype
  pollution or code execution.
- A reachable vulnerability in a default runtime dependency used by the PDF,
  DOCX, HTML, Markdown, or text parsers.
- Checkpoint poisoning: causing a run to reuse audio or scripts that do not
  match the requested configuration.

Out of scope:

- Cost incurred by your own intended runs, or by thresholds you configured.
- Misconfiguration of your Azure tenant, roles, retention, or network policy.
- Quality, accuracy, or bias of model output; hallucinated or mistranslated
  content is a correctness issue, not a vulnerability.
- Anything that already requires write access to the machine, the output
  directory, or the checkpoint directory.
- Results from the example URLs and placeholder values in `.env.example`.

## Data handling

Lectoria sends parsed document text to the Azure OpenAI resource you configure,
and generated utterance text to the Azure AI Speech resource you configure. It
sends your documents nowhere else.

Your Azure tenant, region, logging, abuse-monitoring, and retention settings
still govern that data. Local checkpoints under `<outDir>/.lectoria-cache`
contain generated scripts and raw audio derived from your source, so protect
that directory, or disable checkpointing with `--no-resume`, when the input is
sensitive.

## Hardening guidance

- Prefer Microsoft Entra ID (`az login` and RBAC) over API keys. Keep `.env`
  out of version control; it is already ignored.
- Set `maxEstimatedUsd` for unattended or automated runs so a large or hostile
  document cannot spend without limit.
- Treat documents from untrusted sources as untrusted input, and review the
  generated script before publishing the audio.
- Set `feed.audioBaseUrl` only to a URL you intend to be public. Anything
  published to the feed directory is enumerable by feed consumers.
