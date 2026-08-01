import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const installDir = await mkdtemp(join(tmpdir(), 'lectoria-package-smoke-'));
let tarballPath;

try {
  const { stdout } = await exec('npm', ['pack', '--json'], {
    cwd: repoRoot,
    maxBuffer: 10 * 1024 * 1024,
  });
  const packResult = JSON.parse(stdout);
  const filename = packResult[0]?.filename;
  if (!filename) throw new Error('npm pack did not return a tarball filename.');
  tarballPath = join(repoRoot, filename);

  await writeFile(
    join(installDir, 'package.json'),
    JSON.stringify({ name: 'lectoria-package-smoke', private: true, type: 'module' })
  );
  await exec(
    'npm',
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', tarballPath],
    { cwd: installDir, maxBuffer: 10 * 1024 * 1024 }
  );
  await exec(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      [
        "const api = await import('lectoria');",
        "for (const name of ['runPipeline', 'createTTS', 'estimateCost']) {",
        "  if (typeof api[name] !== 'function') throw new Error(`Missing export: ${name}`);",
        '}',
      ].join('\n'),
    ],
    { cwd: installDir }
  );
  await exec(
    process.execPath,
    [join(installDir, 'node_modules', 'lectoria', 'dist', 'cli.js'), '--help'],
    { cwd: installDir }
  );
} finally {
  if (tarballPath) await rm(tarballPath, { force: true });
  await rm(installDir, { recursive: true, force: true });
}
