/**
 * SDE Downloader -- downloads EVE static data in JSONL format from CCP.
 *
 * Usage: npm run sde:download
 *
 * Downloads from: https://developers.eveonline.com/static-data/eve-online-static-data-latest-jsonl.zip
 * Extracts JSONL files to SDE_DATA_DIR (default: ./data/sde/)
 *
 * CCP provides the SDE in two formats:
 *   - JSON Lines (.jsonl) -- preferred for streaming, lower memory
 *   - YAML (.yaml) -- alternative, can be slow for large files
 *
 * The SDE was reworked in September 2025. New format:
 *   - name fields are localized objects: {en: "Tritanium", ru: "Тританиум", ...}
 *   - some fields renamed (nameID → name)
 *   - bsd/universe folders removed
 */

import 'dotenv/config';
import { createWriteStream, mkdirSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Deliberately no src/config.js import: setup must work before the operator
// has filled in the rest of .env (bot tokens, OpenAI key, EVE credentials).
const SDE_DATA_DIR = process.env.SDE_DATA_DIR || './data/sde';

const SDE_URL = 'https://developers.eveonline.com/static-data/eve-online-static-data-latest-jsonl.zip';

const SDE_DOWNLOAD_TIMEOUT_MS = 5 * 60_000; // 5 minutes for ~100MB download

async function downloadFile(url: string, dest: string): Promise<void> {
  console.log(`[sde-download] Downloading ${url}...`);
  const res = await fetch(url, { signal: AbortSignal.timeout(SDE_DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok) {
    throw new Error(`Failed to download SDE: HTTP ${res.status} ${res.statusText}`);
  }
  if (!res.body) {
    throw new Error('No response body');
  }

  const fileStream = createWriteStream(dest);
  await pipeline(res.body as unknown as NodeJS.ReadableStream, fileStream);
  console.log(`[sde-download] Saved to ${dest}`);
}

export type ExtractZipOptions = {
  // Overridable binaries so tests can simulate a missing unzip.
  unzipBin?: string;
  pythonBin?: string;
};

export async function extractZip(
  zipPath: string,
  destDir: string,
  options: ExtractZipOptions = {},
): Promise<void> {
  console.log(`[sde-download] Extracting to ${destDir}...`);
  const unzipBin = options.unzipBin ?? 'unzip';
  const pythonBin = options.pythonBin ?? 'python3';

  // Use node's built-in unzip via child_process since node:zlib doesn't handle zip archives
  const { execFileSync } = await import('node:child_process');
  const EXTRACT_TIMEOUT_MS = 5 * 60_000; // bound extraction so a hung/corrupt archive can't block forever
  try {
    execFileSync(unzipBin, ['-o', zipPath, '-d', destDir], { stdio: 'inherit', timeout: EXTRACT_TIMEOUT_MS });
  } catch (err) {
    // Only ENOENT (unzip not installed) falls back to python3. Anything else —
    // a non-zero exit (which carries `status`, not `code`), a timeout, a
    // signal — means the archive itself is bad: don't silently fall through
    // to a confusing Python trace.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(`unzip failed (archive may be corrupt): ${(err as Error).message}`, { cause: err });
    }
    // Fallback: try with python3 (paths passed via sys.argv, not string interpolation)
    console.log('[sde-download] unzip not found, trying python3...');
    execFileSync(pythonBin, [
      '-c',
      'import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); z.extractall(sys.argv[2]); print("Extracted",len(z.namelist()),"files")',
      zipPath,
      destDir,
    ], { stdio: 'inherit', timeout: EXTRACT_TIMEOUT_MS });
  }
}

async function main() {
  const sdeDir = SDE_DATA_DIR;
  mkdirSync(sdeDir, { recursive: true });

  const zipPath = join(sdeDir, 'sde-latest.zip');

  // Download
  await downloadFile(SDE_URL, zipPath);

  // Extract
  await extractZip(zipPath, sdeDir);

  console.log('[sde-download] Done. Now run: npm run sde:load');
}

// Only run the download when executed directly (npm run sde:download) —
// importing this module (e.g. for extractZip in tests) must not trigger a
// network download or a process.exit. Same guard as sde-loader.ts.
const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isMain) {
  main().catch((err) => {
    console.error('[sde-download] Error:', err);
    process.exit(1);
  });
}
