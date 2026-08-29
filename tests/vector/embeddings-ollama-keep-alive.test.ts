import { afterEach, expect, test } from 'bun:test';
import { OllamaEmbeddings } from '../../src/vector/embeddings.ts';
import { startServer } from './helpers.ts';

/**
 * 2026-08-29: Ollama unloaded bge-m3 after its default 5-minute keep-alive; the next
 * embed cold-loaded for seconds, the 2 s boot probe failed and search fell back to
 * FTS-only until warm. Every embed call now pins the model (keep_alive:-1 by default).
 */
const saved = process.env.ORACLE_EMBED_KEEP_ALIVE;
afterEach(() => {
  if (saved === undefined) delete process.env.ORACLE_EMBED_KEEP_ALIVE;
  else process.env.ORACLE_EMBED_KEEP_ALIVE = saved;
});

async function capturedBody(): Promise<Record<string, unknown>> {
  let body: Record<string, unknown> = {};
  const target = startServer(async (req) => {
    body = (await req.json()) as Record<string, unknown>;
    return Response.json({ embeddings: [[1, 2, 3]] });
  });
  const provider = new OllamaEmbeddings({ baseUrl: target, model: 'bge-m3' });
  await provider.embed(['hello'], 'query');
  return body;
}

test('ollama embed calls pin the model with keep_alive:-1 by default', async () => {
  delete process.env.ORACLE_EMBED_KEEP_ALIVE;
  const body = await capturedBody();
  expect(body.model).toBe('bge-m3');
  expect(body.keep_alive).toBe(-1);  // a NUMBER: Ollama rejects the string "-1" (missing unit in duration)
});

test('ORACLE_EMBED_KEEP_ALIVE overrides the keep-alive sent to Ollama', async () => {
  process.env.ORACLE_EMBED_KEEP_ALIVE = '30m';
  expect((await capturedBody()).keep_alive).toBe('30m');
  process.env.ORACLE_EMBED_KEEP_ALIVE = '0';
  expect((await capturedBody()).keep_alive).toBe(0);
  process.env.ORACLE_EMBED_KEEP_ALIVE = '   ';
  expect((await capturedBody()).keep_alive).toBe(-1);
});
