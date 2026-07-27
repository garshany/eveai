import type { FastifyInstance } from 'fastify';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * Public showcase: real questions with the system's real answers, captured by
 * the operator against the production runtime. Content lives in
 * data/examples.json on disk so a fresh capture is just a file upload — no
 * rebuild, no restart. The screen degrades to an empty list until the first
 * capture lands.
 *
 * Shape of the file: { "examples": [{ "id", "category", "question", "answer",
 * "tools"?: string[] }] }. Everything is validated defensively — a malformed
 * file yields an empty list and a log line, never a 500.
 */

export type ShowcaseExample = {
  id: string;
  category: string;
  question: string;
  answer: string;
  tools: string[];
};

const EXAMPLES_PATH = resolve(process.cwd(), 'data/examples.json');
const CACHE_TTL_MS = 5 * 60_000;

let cached: { examples: ShowcaseExample[]; mtimeMs: number; readAtMs: number } | null = null;

function parseExamples(raw: string): ShowcaseExample[] {
  const parsed = JSON.parse(raw) as { examples?: unknown };
  if (!Array.isArray(parsed.examples)) return [];
  const out: ShowcaseExample[] = [];
  for (const entry of parsed.examples.slice(0, 50)) {
    const row = entry as Record<string, unknown>;
    if (typeof row.id !== 'string' || typeof row.question !== 'string' || typeof row.answer !== 'string') continue;
    out.push({
      id: row.id.slice(0, 64),
      category: typeof row.category === 'string' ? row.category.slice(0, 64) : 'general',
      question: row.question.slice(0, 2_000),
      answer: row.answer.slice(0, 20_000),
      tools: Array.isArray(row.tools)
        ? row.tools.filter((tool): tool is string => typeof tool === 'string').slice(0, 12)
        : [],
    });
  }
  return out;
}

async function loadExamples(): Promise<ShowcaseExample[]> {
  const now = Date.now();
  try {
    const meta = await stat(EXAMPLES_PATH);
    if (cached && cached.mtimeMs === meta.mtimeMs && now - cached.readAtMs < CACHE_TTL_MS) {
      return cached.examples;
    }
    const examples = parseExamples(await readFile(EXAMPLES_PATH, 'utf8'));
    cached = { examples, mtimeMs: meta.mtimeMs, readAtMs: now };
    return examples;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('[examples] failed to read %s: %s', EXAMPLES_PATH, err instanceof Error ? err.message : err);
    }
    return [];
  }
}

export function resetExamplesCacheForTests(): void {
  cached = null;
}

export function registerExamplesRoutes(app: FastifyInstance): void {
  // Public on purpose: this is the shop window. Short shared cache — the
  // content changes only when the operator uploads a new capture.
  app.get('/api/web/examples', async (_request, reply) => {
    reply.header('Cache-Control', 'public, max-age=300');
    return { examples: await loadExamples() };
  });
}
