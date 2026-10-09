/**
 * BL-229 — per-URL embed keep_alive. Residency is desirable on the local Mac CPU (:11434, RAM),
 * but the win GPU tunnel (:11435) must NEVER hold VRAM between calls (ComfyUI priority 1). This holds
 * client-side even if the win server's own OLLAMA_KEEP_ALIVE default is not in force.
 */
import { describe, expect, test } from 'bun:test';
import { isWinGpuTunnel, resolveEmbedKeepAlive, parseKeepAlive } from '../embeddings.ts';

const CPU = 'http://127.0.0.1:11434';
const GPU = 'http://127.0.0.1:11435';

describe('isWinGpuTunnel', () => {
  test('true for the :11435 tunnel (127.0.0.1 and localhost)', () => {
    expect(isWinGpuTunnel(GPU)).toBe(true);
    expect(isWinGpuTunnel('http://localhost:11435')).toBe(true);
    expect(isWinGpuTunnel('http://localhost:11435/')).toBe(true);
  });
  test('false for the Mac CPU :11434 and other ports', () => {
    expect(isWinGpuTunnel(CPU)).toBe(false);
    expect(isWinGpuTunnel('http://localhost:11434')).toBe(false);
    expect(isWinGpuTunnel('http://localhost:11436')).toBe(false);
  });
});

describe('resolveEmbedKeepAlive', () => {
  test('CPU/local keeps the default residency (-1) so the model stays warm in RAM', () => {
    expect(resolveEmbedKeepAlive(CPU, undefined)).toBe(-1);
    expect(parseKeepAlive(undefined)).toBe(-1); // sanity: default is pin
  });
  test('CPU honors an explicit operator keep_alive', () => {
    expect(resolveEmbedKeepAlive(CPU, '30')).toBe(30);
    expect(resolveEmbedKeepAlive(CPU, '0')).toBe(0);
  });
  test('GPU tunnel is forced to 0 by default (never pins VRAM)', () => {
    expect(resolveEmbedKeepAlive(GPU, undefined)).toBe(0);
  });
  test('GPU tunnel coerces a pin (-1) or non-numeric keep_alive to 0', () => {
    expect(resolveEmbedKeepAlive(GPU, '-1')).toBe(0);
    expect(resolveEmbedKeepAlive(GPU, '5m')).toBe(0); // string "5m" would pin-ish → not allowed on GPU
  });
  test('GPU honors an explicit non-negative keep_alive for a deliberate drain burst', () => {
    expect(resolveEmbedKeepAlive(GPU, '30')).toBe(30);
    expect(resolveEmbedKeepAlive(GPU, '0')).toBe(0);
  });
});
