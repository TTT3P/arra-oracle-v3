import { expect, test } from 'bun:test';
import { OllamaEmbeddings } from '../../src/vector/embeddings.ts';
import { startServer } from './helpers.ts';

test('ollama embedder prefixes BGE query prompts', async () => {
  let prompt = '';
  const target = startServer(async (req) => {
    prompt = ((await req.json()) as any).input[0];
    return Response.json({ embedding: Array.from({ length: 1024 }, () => 0.1) });
  });
  const provider = new OllamaEmbeddings({ baseUrl: target, model: 'bge-m3' });

  const vectors = await provider.embed(['hello'], 'query');

  expect(prompt).toBe('query: hello');
  expect(vectors).toEqual([Array.from({ length: 1024 }, () => 0.1)]);
  expect(provider.dimensions).toBe(1024); // declared dims stay authoritative (dimension guard)
});
