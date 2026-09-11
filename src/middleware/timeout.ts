import { REQUEST_ID_HEADER, requestIdFor } from './correlation.ts';
import type { StructuredErrorResponse } from './errors.ts';

const DEFAULT_TIMEOUT_MS = 30_000;

type FetchHandler = (request: Request) => Response | Promise<Response>;

export function requestTimeoutMsFromEnv(value = process.env.ARRA_REQUEST_TIMEOUT_MS): number {
  return safeTimeoutMs(value);
}

function safeTimeoutMs(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_TIMEOUT_MS;
}

function timeoutBody(request: Request, timeoutMs: number): StructuredErrorResponse {
  return {
    success: false,
    error: 'Request Timeout',
    message: `Request exceeded ${timeoutMs}ms timeout`,
    statusCode: 408,
    correlationId: requestIdFor(request),
  };
}

function timeoutResponse(request: Request, timeoutMs: number): Response {
  const body = timeoutBody(request, timeoutMs);
  return Response.json(body, {
    status: 408,
    headers: {
      [REQUEST_ID_HEADER]: body.correlationId,
      'x-correlation-id': body.correlationId,
    },
  });
}

function requestWithSignal(request: Request, signal: AbortSignal): Request {
  return new Request(request, { signal });
}

export async function handleRequestTimeout(
  request: Request,
  next: FetchHandler,
  timeoutMs = requestTimeoutMsFromEnv(),
): Promise<Response> {
  const effectiveTimeoutMs = safeTimeoutMs(timeoutMs);
  const controller = new AbortController();
  const timedRequest = requestWithSignal(request, controller.signal);
  const response = Promise.resolve(next(timedRequest));
  response.catch(() => {});

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Response>((resolve) => {
    timer = setTimeout(() => {
      controller.abort(new Error('request timeout'));
      resolve(timeoutResponse(request, effectiveTimeoutMs));
    }, effectiveTimeoutMs);
  });

  try {
    return await Promise.race([response, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function createRequestTimeoutFetch(next: FetchHandler, timeoutMs = requestTimeoutMsFromEnv()): FetchHandler {
  return (request) => handleRequestTimeout(request, next, timeoutMs);
}

/**
 * HTTP idle timeout for Bun.serve (OM-BL-2026-09-09-01). Bun closes a connection that has sent no bytes
 * for `idleTimeout` seconds — default 10 s. A synchronous FTS5 scan on the single event loop can exceed
 * that, so clients saw `socket closed unexpectedly` (http=000 at ~12 s) while the server finished the
 * work. Bun caps the value at 255 s.
 */
export const HTTP_IDLE_TIMEOUT_ENV = 'ORACLE_HTTP_IDLE_TIMEOUT_S';
export const BUN_MAX_IDLE_TIMEOUT_S = 255;
export const DEFAULT_HTTP_IDLE_TIMEOUT_S = BUN_MAX_IDLE_TIMEOUT_S;

export function httpIdleTimeoutSeconds(raw = process.env[HTTP_IDLE_TIMEOUT_ENV]): number {
  const value = raw?.trim();
  if (!value) return DEFAULT_HTTP_IDLE_TIMEOUT_S;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_HTTP_IDLE_TIMEOUT_S;
  return Math.min(BUN_MAX_IDLE_TIMEOUT_S, Math.floor(n));
}
