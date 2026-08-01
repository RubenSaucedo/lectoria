# Security policy

## Supported versions

Before 1.0, only the latest published minor release receives security fixes.

## Reporting

Please report vulnerabilities through GitHub's private vulnerability
reporting for this repository. Do not open a public issue containing an
exploit, credential, private document, Azure resource identifier, or model
response derived from sensitive input.

## Data handling

Lectoria sends parsed document text to the Azure OpenAI resource configured
by the user and generated utterance text to the configured Azure AI Speech
resource. Local checkpoints may contain generated scripts and raw audio.
Users are responsible for Azure tenant policy, region, retention settings,
access control, and protection of local output directories.
