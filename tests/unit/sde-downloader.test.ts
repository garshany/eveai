import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractZip } from '../../src/eve/sde-downloader.js';

function hasBinary(bin: string): boolean {
  try {
    execFileSync(bin, ['--version'], { stdio: 'ignore' });
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

const HAS_UNZIP = hasBinary('unzip') || existsSync('/usr/bin/unzip');
const HAS_PYTHON = hasBinary('python3');

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sde-downloader-test-'));
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

function makeValidZip(): string {
  const zipPath = join(dir, 'ok.zip');
  execFileSync('python3', [
    '-c',
    'import zipfile,sys; z=zipfile.ZipFile(sys.argv[1],"w"); z.writestr("types.jsonl","{}\\n"); z.close()',
    zipPath,
  ]);
  return zipPath;
}

describe('extractZip', () => {
  it('importing the module does not run the downloader', () => {
    // The import above would have started a download (and process.exit on
    // failure) if main() ran unguarded; reaching this line is the assertion.
    expect(typeof extractZip).toBe('function');
  });

  it.skipIf(!HAS_UNZIP)('rejects a corrupt archive without falling back to python', async () => {
    const zipPath = join(dir, 'corrupt.zip');
    writeFileSync(zipPath, 'this is not a zip archive');
    // A python fallback that would "succeed" makes a fall-through observable.
    const pythonMarker = join(dir, 'python-ran');
    const fakePython = join(dir, 'fake-python.sh');
    writeFileSync(fakePython, `#!/bin/sh\ntouch "${pythonMarker}"\n`, { mode: 0o755 });

    await expect(extractZip(zipPath, join(dir, 'out'), { pythonBin: fakePython }))
      .rejects.toThrow(/unzip failed \(archive may be corrupt\)/);
    expect(existsSync(pythonMarker)).toBe(false);
  });

  it.skipIf(!HAS_PYTHON)('falls back to python3 only when the unzip binary is missing (ENOENT)', async () => {
    const zipPath = makeValidZip();
    const out = join(dir, 'out');
    await extractZip(zipPath, out, { unzipBin: join(dir, 'no-such-unzip-binary') });
    expect(readFileSync(join(out, 'types.jsonl'), 'utf8')).toBe('{}\n');
  });

  it.skipIf(!HAS_UNZIP || !HAS_PYTHON)('extracts a valid archive with unzip', async () => {
    const zipPath = makeValidZip();
    const out = join(dir, 'out');
    await extractZip(zipPath, out);
    expect(readFileSync(join(out, 'types.jsonl'), 'utf8')).toBe('{}\n');
  });
});
