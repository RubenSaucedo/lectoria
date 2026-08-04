import { rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import lockfile from 'proper-lockfile';

export async function atomicWriteFile(
  targetPath: string,
  data: string | Buffer,
  encoding?: BufferEncoding
): Promise<void> {
  const tempPath = temporarySiblingPath(targetPath);
  try {
    if (typeof data === 'string') await writeFile(tempPath, data, encoding ?? 'utf-8');
    else await writeFile(tempPath, data);
    await rename(tempPath, targetPath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function temporarySiblingPath(targetPath: string): string {
  return join(
    dirname(targetPath),
    `.${basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`
  );
}

export async function withFileLock<T>(
  targetPath: string,
  work: () => Promise<T>,
  opts: { timeoutMs?: number; staleMs?: number } = {}
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const staleMs = opts.staleMs ?? 60_000;
  const release = await lockfile.lock(targetPath, {
    realpath: false,
    stale: staleMs,
    update: Math.max(1_000, Math.floor(staleMs / 2)),
    retries: {
      retries: Math.max(1, Math.ceil(timeoutMs / 100)),
      factor: 1.2,
      minTimeout: 50,
      maxTimeout: 500,
      randomize: true,
    },
  });

  try {
    return await work();
  } finally {
    await release();
  }
}
