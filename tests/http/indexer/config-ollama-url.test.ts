import { afterAll, expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import { configEndpoint } from '../../../src/routes/indexer/config.ts';

/** 2026-08-30 backlog: GET /indexer/config probed a hardcoded localhost:11434 and ignored OLLAMA_BASE_URL. */
const saved = { base: process.env.OLLAMA_BASE_URL, host: process.env.OLLAMA_HOST };
const stub = Bun.serve({
  port: 0,
  fetch: (req) => new URL(req.url).pathname === '/api/tags'
    ? Response.json({ models: [{ name: 'stub-embed:latest' }] })
    : new Response('nope', { status: 404 }),
});
afterAll(() => {
  stub.stop(true);
  if (saved.base === undefined) delete process.env.OLLAMA_BASE_URL; else process.env.OLLAMA_BASE_URL = saved.base;
  if (saved.host === undefined) delete process.env.OLLAMA_HOST; else process.env.OLLAMA_HOST = saved.host;
});

test('lists models from the Ollama at OLLAMA_BASE_URL, not localhost:11434', async () => {
  process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${stub.port}`;
  delete process.env.OLLAMA_HOST;
  const app = new Elysia().use(configEndpoint);
  const res = await app.handle(new Request('http://localhost/indexer/config'));
  expect(res.status).toBe(200);
  const body = await res.json() as { ollamaModels: string[]; adapters: string[] };
  expect(body.ollamaModels).toEqual(['stub-embed:latest']);
  expect(body.adapters).toContain('lancedb');
});

test('an unreachable Ollama degrades to an empty list instead of failing the route', async () => {
  process.env.OLLAMA_BASE_URL = 'http://127.0.0.1:1';
  const app = new Elysia().use(configEndpoint);
  const res = await app.handle(new Request('http://localhost/indexer/config'));
  expect(res.status).toBe(200);
  expect((await res.json() as { ollamaModels: string[] }).ollamaModels).toEqual([]);
});
