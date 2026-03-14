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

import { createWriteStream, mkdirSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';
import { config } from '../config.js';

const SDE_URL = 'https://developers.eveonline.com/static-data/eve-online-static-data-latest-jsonl.zip';

async function downloadFile(url: string, dest: string): Promise<void> {
  console.log(`[sde-download] Downloading ${url}...`);
  const res = await fetch(url);
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

async function extractZip(zipPath: string, destDir: string): Promise<void> {
  console.log(`[sde-download] Extracting to ${destDir}...`);

  // Use node's built-in unzip via child_process since node:zlib doesn't handle zip archives
  const { execFileSync } = await import('node:child_process');
  try {
    execFileSync('unzip', ['-o', zipPath, '-d', destDir], { stdio: 'inherit' });
  } catch {
    // Fallback: try with python3 (paths passed via sys.argv, not string interpolation)
    console.log('[sde-download] unzip not found, trying python3...');
    execFileSync('python3', [
      '-c',
      'import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); z.extractall(sys.argv[2]); print("Extracted",len(z.namelist()),"files")',
      zipPath,
      destDir,
    ], { stdio: 'inherit' });
  }
}

async function main() {
  const sdeDir = config.sde.dataDir;
  mkdirSync(sdeDir, { recursive: true });

  const zipPath = join(sdeDir, 'sde-latest.zip');

  // Download
  await downloadFile(SDE_URL, zipPath);

  // Extract
  await extractZip(zipPath, sdeDir);

  console.log('[sde-download] Done. Now run: npm run sde:load');
}

main().catch((err) => {
  console.error('[sde-download] Error:', err);
  process.exit(1);
});
