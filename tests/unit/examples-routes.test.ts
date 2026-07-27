import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { registerExamplesRoutes, resetExamplesCacheForTests } from '../../src/web/examples-routes.js';

const EXAMPLES_PATH = resolve(process.cwd(), 'data/examples.json');
const BACKUP_PATH = resolve(process.cwd(), 'data/examples.json.test-backup');

let app: ReturnType<typeof Fastify>;
let hadFile = false;

beforeEach(async () => {
  resetExamplesCacheForTests();
  mkdirSync(resolve(process.cwd(), 'data'), { recursive: true });
  try {
    // Preserve an operator's real file if one exists on this machine.
    writeFileSync(BACKUP_PATH, await import('node:fs/promises').then((fs) => fs.readFile(EXAMPLES_PATH)));
    hadFile = true;
  } catch {
    hadFile = false;
  }
  app = Fastify();
  registerExamplesRoutes(app);
});

afterEach(async () => {
  await app.close();
  if (hadFile) {
    writeFileSync(EXAMPLES_PATH, await import('node:fs/promises').then((fs) => fs.readFile(BACKUP_PATH)));
  } else {
    rmSync(EXAMPLES_PATH, { force: true });
  }
  rmSync(BACKUP_PATH, { force: true });
  resetExamplesCacheForTests();
});

describe('GET /api/web/examples', () => {
  it('serves a valid capture with a public cache header', async () => {
    writeFileSync(EXAMPLES_PATH, JSON.stringify({
      examples: [
        { id: 'route-1', category: 'Маршруты', question: 'Как долететь?', answer: '**Безопасно**: 12 прыжков.', tools: ['plan_route'] },
      ],
    }));
    resetExamplesCacheForTests();
    const response = await app.inject({ method: 'GET', url: '/api/web/examples' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('public, max-age=300');
    const body = response.json();
    expect(body.examples).toHaveLength(1);
    expect(body.examples[0]).toMatchObject({ id: 'route-1', category: 'Маршруты', tools: ['plan_route'] });
  });

  it('answers an empty list when the capture file does not exist', async () => {
    rmSync(EXAMPLES_PATH, { force: true });
    resetExamplesCacheForTests();
    const response = await app.inject({ method: 'GET', url: '/api/web/examples' });
    expect(response.statusCode).toBe(200);
    expect(response.json().examples).toEqual([]);
  });

  it('degrades a malformed file to an empty list instead of a 500', async () => {
    writeFileSync(EXAMPLES_PATH, '{broken json');
    resetExamplesCacheForTests();
    const response = await app.inject({ method: 'GET', url: '/api/web/examples' });
    expect(response.statusCode).toBe(200);
    expect(response.json().examples).toEqual([]);
  });

  it('drops rows without required fields and caps list size', async () => {
    writeFileSync(EXAMPLES_PATH, JSON.stringify({
      examples: [
        { id: 'ok', category: 'c', question: 'q', answer: 'a' },
        { id: 42, question: 'no-id', answer: 'x' },
        { category: 'no-question', answer: 'x', id: 'y' },
      ],
    }));
    resetExamplesCacheForTests();
    const body = (await app.inject({ method: 'GET', url: '/api/web/examples' })).json();
    expect(body.examples).toHaveLength(1);
    expect(body.examples[0].id).toBe('ok');
    expect(body.examples[0].tools).toEqual([]);
  });
});
