import type { IngestSource, SourceFile } from '../types.js';
import { LocalFileSystemIngest } from './local.js';

const defaultLocal = new LocalFileSystemIngest();

const adapters: IngestSource[] = [
  defaultLocal,
  // v1: new OneDriveIngest(),
  // v1: new UrlIngest(),
];

export interface IngestOptions {
  /** Walk subdirectories when the input is a folder. Default true. */
  recursive?: boolean;
}

export async function ingest(uri: string, opts: IngestOptions = {}): Promise<SourceFile[]> {
  // If a non-default recursive setting was requested, use a one-off
  // LocalFileSystemIngest with that flag instead of the cached default.
  if (opts.recursive === false) {
    const adapter = new LocalFileSystemIngest({ recursive: false });
    if (adapter.supports(uri)) return adapter.fetch(uri);
  }
  const adapter = adapters.find((a) => a.supports(uri));
  if (!adapter) {
    throw new Error(`No ingest adapter supports the URI "${uri}".`);
  }
  return adapter.fetch(uri);
}

export { LocalFileSystemIngest };
export type { LocalFileSystemIngestOptions } from './local.js';
