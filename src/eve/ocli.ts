import { spawn } from 'node:child_process';
import { getProfile, PROFILE_NAMES } from './profiles.js';
import { getAccessToken } from './sso.js';
import type { Db } from '../db/sqlite.js';

/**
 * Path to the ocli binary.
 * When installed via npm, it's available as npx openapi-to-cli
 * or directly via node_modules/.bin/ocli
 */
const OCLI_BIN = 'npx';
const OCLI_CMD = 'openapi-to-cli';
const TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 64 * 1024; // 64 KB

const ESI_USER_AGENT = 'eve-agent/0.1.0 (+https://github.com/eve-agent)';
const ESI_COMPATIBILITY_DATE = '2026-03-14';

export type OcliMode = 'search' | 'help' | 'run';

export interface OcliRequest {
  profile: string;
  mode: OcliMode;
  query: string | null;
  command: string | null;
  args: string[] | null;
}

export interface OcliResult {
  ok: boolean;
  output: string;
  error: string | null;
  truncated: boolean;
}

/**
 * safe_exec_ocli -- the main tool for ESI access.
 *
 * Real ocli CLI syntax (openapi-to-cli v0.1.8):
 *   - Search: npx openapi-to-cli commands --query "..."
 *   - Help:   npx openapi-to-cli <command> --help
 *   - Run:    npx openapi-to-cli <command> [--param value ...]
 *   - Auth:   --api-bearer-token <token>
 *   - Headers: --custom-headers '{"X-Compatibility-Date":"2026-03-14","User-Agent":"..."}'
 *
 * Profiles are pre-configured via `ocli onboard` with --include-endpoints filters.
 * We switch profiles using the OCLI_PROFILE env var or --profile flag.
 */
export async function safeExecOcli(db: Db, req: OcliRequest): Promise<OcliResult> {
  // Validate profile
  if (!PROFILE_NAMES.includes(req.profile)) {
    return {
      ok: false,
      output: '',
      error: `Unknown profile: ${req.profile}. Allowed: ${PROFILE_NAMES.join(', ')}`,
      truncated: false,
    };
  }

  const profile = getProfile(req.profile)!;

  // Build argv -- never use shell
  const argv: string[] = [OCLI_CMD, '--profile', req.profile];

  // Custom headers for ESI: User-Agent + X-Compatibility-Date
  const customHeaders: Record<string, string> = {
    'User-Agent': ESI_USER_AGENT,
    'X-Compatibility-Date': ESI_COMPATIBILITY_DATE,
  };
  argv.push('--custom-headers', JSON.stringify(customHeaders));

  // Add auth token if profile requires it
  if (profile.requiresAuth) {
    const auth = await getAccessToken(db);
    if (!auth) {
      return {
        ok: false,
        output: '',
        error: 'No EVE character linked or token expired. Use /eve-login first.',
        truncated: false,
      };
    }
    argv.push('--api-bearer-token', auth.token);
  }

  // Build mode-specific arguments
  switch (req.mode) {
    case 'search':
      argv.push('commands');
      if (req.query) {
        argv.push('--query', req.query);
      }
      break;

    case 'help':
      if (!req.command) {
        return { ok: false, output: '', error: 'mode=help requires a command name', truncated: false };
      }
      argv.push(req.command, '--help');
      break;

    case 'run':
      if (!req.command) {
        return { ok: false, output: '', error: 'mode=run requires a command name', truncated: false };
      }
      argv.push(req.command);
      if (req.args) {
        argv.push(...req.args);
      }
      break;
  }

  return execProcess(OCLI_BIN, argv);
}

function execProcess(bin: string, argv: string[]): Promise<OcliResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let totalBytes = 0;
    let truncated = false;

    const proc = spawn(bin, argv, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: TIMEOUT_MS,
      shell: false, // NEVER use shell -- prevents injection
      env: { ...process.env, NO_COLOR: '1' },
    });

    proc.stdout.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes <= MAX_OUTPUT_BYTES) {
        chunks.push(chunk);
      } else {
        truncated = true;
      }
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      errChunks.push(chunk);
    });

    proc.on('close', (code) => {
      const stdout = redactSecrets(Buffer.concat(chunks).toString('utf-8'));
      const stderr = Buffer.concat(errChunks).toString('utf-8');

      if (code === 0) {
        resolve({ ok: true, output: stdout, error: null, truncated });
      } else {
        resolve({
          ok: false,
          output: stdout,
          error: redactSecrets(stderr) || `ocli exited with code ${code}`,
          truncated,
        });
      }
    });

    proc.on('error', (err) => {
      resolve({
        ok: false,
        output: '',
        error: `Failed to spawn ocli: ${err.message}. Is openapi-to-cli installed? Run: npm install -g openapi-to-cli`,
        truncated: false,
      });
    });
  });
}

/** Remove any leaked tokens/secrets from output */
function redactSecrets(text: string): string {
  return text
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer [REDACTED]')
    .replace(/--api-bearer-token\s+[A-Za-z0-9._-]+/g, '--api-bearer-token [REDACTED]');
}
