import { createHash } from 'node:crypto';

/**
 * Builds a stable, filesystem-safe identifier while keeping a readable stem.
 * The hash input should include both source identity and content so files with
 * the same basename cannot overwrite one another.
 */
export function createDocumentId(stem: string, sourceIdentity: string): string {
  const readable = stem
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'document';
  const hash = createHash('sha256')
    .update(sourceIdentity)
    .digest('hex')
    .slice(0, 12);
  return `${readable}-${hash}`;
}

export function createContentHash(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function createBufferHash(bytes: Buffer): string {
  return createContentHash(bytes);
}

/** Script IDs are display identities only; callers must use documentId directly. */
export function createScriptId(documentId: string, language: string): string {
  return `${documentId}--${language}`;
}

/** Stable hash for checkpoint keys and other content-addressed state. */
export function createFingerprint(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
}
