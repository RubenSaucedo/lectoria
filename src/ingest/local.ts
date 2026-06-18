import { readFile, stat, readdir } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { IngestSource, SourceFile, SourceFormat } from '../types.js';

const FORMAT_BY_EXT: Record<string, SourceFormat> = {
  '.pdf': 'pdf',
  '.docx': 'docx',
  '.md': 'md',
  '.markdown': 'md',
  '.html': 'html',
  '.htm': 'html',
  '.txt': 'txt',
};

export interface LocalFileSystemIngestOptions {
  /**
   * Whether to walk subdirectories when the input is a folder. Default true.
   * Set to false to keep the legacy flat-folder behavior.
   */
  recursive?: boolean;
}

/**
 * Reads source documents from the local filesystem.
 *
 * Accepts either a single file path or a directory. Directories are walked
 * recursively by default; pass `{ recursive: false }` to scan only the
 * top level.
 *
 * Each emitted `SourceFile` carries a `sourcePath` (POSIX-style, no
 * extension) representing its location relative to the ingest root. The
 * pipeline uses this to mirror input structure into the output directory
 * and to scope per-folder podcast feeds.
 */
export class LocalFileSystemIngest implements IngestSource {
  #recursive: boolean;

  constructor(opts: LocalFileSystemIngestOptions = {}) {
    this.#recursive = opts.recursive ?? true;
  }

  supports(uri: string): boolean {
    if (uri.startsWith('http://') || uri.startsWith('https://')) return false;
    if (uri.startsWith('onedrive:')) return false;
    return true;
  }

  async fetch(uri: string): Promise<SourceFile[]> {
    const absolute = isAbsolute(uri) ? uri : resolve(process.cwd(), uri);
    const info = await stat(absolute);

    if (info.isDirectory()) {
      // Walk the tree rooted at `absolute`. Files at the root level get
      // sourcePath = '<stem>'; files in subdirs get '<subdir>/<stem>'.
      return this.#walkDirectory(absolute, absolute);
    }

    // Single-file ingest. The relative root is the file's own directory so
    // the sourcePath collapses to just the file's stem — matches the legacy
    // behavior single-file consumers expect.
    return [await this.#loadFile(absolute, dirname(absolute))];
  }

  async #walkDirectory(root: string, dir: string): Promise<SourceFile[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    const results: SourceFile[] = [];
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (this.#recursive) {
          const nested = await this.#walkDirectory(root, fullPath);
          results.push(...nested);
        }
        continue;
      }
      if (entry.isFile() && FORMAT_BY_EXT[extname(entry.name).toLowerCase()]) {
        results.push(await this.#loadFile(fullPath, root));
      }
    }
    // Sort for stable, predictable ordering across runs.
    results.sort((a, b) => a.sourcePath.localeCompare(b.sourcePath));
    return results;
  }

  async #loadFile(absolutePath: string, root: string): Promise<SourceFile> {
    const ext = extname(absolutePath).toLowerCase();
    const format = FORMAT_BY_EXT[ext];
    if (!format) {
      throw new Error(`Unsupported source format for "${absolutePath}" (extension "${ext}").`);
    }
    const bytes = await readFile(absolutePath);
    const stem = basename(absolutePath, ext);

    // Build sourcePath = "<subdir>/<stem>" with POSIX slashes regardless of
    // host OS. relative() may emit Windows backslashes; normalize them.
    const relativeFromRoot = relative(root, absolutePath);
    const relativeDir = dirname(relativeFromRoot);
    const sourcePath =
      relativeDir === '.' || relativeDir === ''
        ? stem
        : `${relativeDir.split(sep).join('/')}/${stem}`;

    return {
      id: stem,
      uri: pathToFileURL(absolutePath).toString(),
      format,
      bytes,
      fetchedAt: new Date().toISOString(),
      sourcePath,
    };
  }
}
