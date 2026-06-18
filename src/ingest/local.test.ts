import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalFileSystemIngest } from './local.js';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'lectoria-ingest-'));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('LocalFileSystemIngest.supports', () => {
  it('accepts plain paths', () => {
    expect(new LocalFileSystemIngest().supports('./samples/foo.md')).toBe(true);
  });

  it('rejects http and onedrive URIs', () => {
    const adapter = new LocalFileSystemIngest();
    expect(adapter.supports('https://example.com/foo.md')).toBe(false);
    expect(adapter.supports('http://example.com/foo.md')).toBe(false);
    expect(adapter.supports('onedrive:abc123')).toBe(false);
  });
});

describe('LocalFileSystemIngest.fetch (single file)', () => {
  it('returns one SourceFile whose sourcePath is the stem', async () => {
    const path = join(tmpRoot, 'lesson.md');
    await writeFile(path, '# Lesson\nbody');

    const files = await new LocalFileSystemIngest().fetch(path);

    expect(files).toHaveLength(1);
    expect(files[0]!.sourcePath).toBe('lesson');
    expect(files[0]!.format).toBe('md');
    expect(files[0]!.id).toBe('lesson');
    expect(files[0]!.bytes.toString('utf-8')).toContain('# Lesson');
  });

  it('throws on an unsupported extension', async () => {
    const path = join(tmpRoot, 'notes.xyz');
    await writeFile(path, 'hello');
    await expect(new LocalFileSystemIngest().fetch(path)).rejects.toThrow(/Unsupported source format/);
  });
});

describe('LocalFileSystemIngest.fetch (folder)', () => {
  beforeEach(async () => {
    await writeFile(join(tmpRoot, 'overview.md'), '# Overview');
    await mkdir(join(tmpRoot, 'python'));
    await writeFile(join(tmpRoot, 'python', 'lesson-1.md'), '# Lesson 1');
    await mkdir(join(tmpRoot, 'rust'));
    await writeFile(join(tmpRoot, 'rust', 'intro.md'), '# Intro');
    // Sneak in an unsupported file to prove it gets filtered.
    await writeFile(join(tmpRoot, 'ignore.bin'), 'ignored');
  });

  it('walks recursively by default and emits POSIX sourcePaths sorted', async () => {
    const files = await new LocalFileSystemIngest().fetch(tmpRoot);
    expect(files.map((f) => f.sourcePath)).toEqual([
      'overview',
      'python/lesson-1',
      'rust/intro',
    ]);
  });

  it('uses forward slashes regardless of host OS path separator', async () => {
    const files = await new LocalFileSystemIngest().fetch(tmpRoot);
    for (const f of files) {
      expect(f.sourcePath).not.toContain('\\');
    }
  });

  it('skips subdirectories when recursive is false', async () => {
    const files = await new LocalFileSystemIngest({ recursive: false }).fetch(tmpRoot);
    expect(files.map((f) => f.sourcePath)).toEqual(['overview']);
  });

  it('returns an empty array for an empty folder', async () => {
    const empty = join(tmpRoot, 'empty');
    await mkdir(empty);
    const files = await new LocalFileSystemIngest().fetch(empty);
    expect(files).toEqual([]);
  });
});
