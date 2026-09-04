import type { EmbeddingProvider, EmbedType } from './types.ts';

export interface FallbackProviderStats {
  attempts: number;
  failures: number;
  successes: number;
  lastError?: string;
}

export interface FallbackChainStats {
  attempts: number;
  failures: number;
  successes: number;
  activeProvider?: string;
  lastProvider?: string;
  providers: Record<string, FallbackProviderStats>;
}

export interface FallbackChainEvent {
  from: string;
  to?: string;
  error: string;
}

export interface EmbeddingFallbackChainOptions {
  backoffFactor?: number;
  /** After a provider fails, skip it for this long (0 = disabled, the default). */
  cooldownMs?: number;
  /** Budget for re-trying a provider that failed before (half-open probe). */
  halfOpenTimeoutMs?: number;
  initialBackoffMs?: number;
  logger?: (message: string) => void;
  maxBackoffMs?: number;
  onFallback?: (event: FallbackChainEvent) => void;
  sleep?: (ms: number) => Promise<void>;
  sticky?: boolean;
}

export class EmbeddingFallbackChain implements EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;
  private readonly backoffFactor: number;
  private readonly cooldownMs: number;
  private readonly halfOpenTimeoutMs: number;
  private readonly skipUntil: number[];
  /** Single-flight guard: at most ONE half-open probe per provider at a time. */
  private readonly halfOpenBusy: boolean[];
  private readonly initialBackoffMs: number;
  private readonly logger: (message: string) => void;
  private readonly maxBackoffMs: number;
  private readonly onFallback?: (event: FallbackChainEvent) => void;
  private readonly providerStats: Record<string, FallbackProviderStats>;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly sticky: boolean;
  private activeIndex = 0;
  private attempts = 0;
  private failures = 0;
  private successes = 0;
  private lastProvider: string | undefined;

  constructor(
    private readonly providers: readonly EmbeddingProvider[],
    options: EmbeddingFallbackChainOptions = {},
  ) {
    if (providers.length === 0) throw new Error('EmbeddingFallbackChain requires at least one provider');
    this.name = providers.map((provider) => provider.name).join('>');
    this.dimensions = providers[0].dimensions;
    this.backoffFactor = options.backoffFactor ?? 2;
    this.cooldownMs = options.cooldownMs ?? 0;
    this.halfOpenTimeoutMs = options.halfOpenTimeoutMs ?? 2_500;
    this.skipUntil = providers.map(() => 0);
    this.halfOpenBusy = providers.map(() => false);
    this.initialBackoffMs = options.initialBackoffMs ?? 100;
    this.logger = options.logger ?? ((message) => console.info(message));
    this.maxBackoffMs = options.maxBackoffMs ?? 2_000;
    this.onFallback = options.onFallback;
    this.sleep = options.sleep ?? defaultSleep;
    this.sticky = options.sticky ?? true;
    this.providerStats = Object.fromEntries(providers.map((provider) => [
      provider.name,
      { attempts: 0, failures: 0, successes: 0 },
    ]));
  }

  async embed(texts: string[], type?: EmbedType): Promise<number[][]> {
    this.attempts += 1;
    let lastError: unknown;
    const order = this.tryOrder();
    for (let attemptIndex = 0; attemptIndex < order.length; attemptIndex += 1) {
      const index = order[attemptIndex];
      const provider = this.providers[index];
      // A provider that failed before gets a bounded half-open re-try so a
      // still-dead endpoint cannot re-amplify latency once per cooldown —
      // and only ONE caller probes it at a time (no thundering herd).
      const halfOpen = this.cooldownMs > 0 && this.skipUntil[index] > 0;
      if (halfOpen && this.halfOpenBusy[index]) {
        lastError = lastError ?? new Error(`provider '${provider.name}' half-open probe already in flight`);
        continue;
      }
      const stats = this.statsFor(provider.name);
      stats.attempts += 1;
      if (halfOpen) this.halfOpenBusy[index] = true;
      try {
        const vectors = halfOpen
          ? await this.halfOpenProbe(provider, texts, type)
          : await provider.embed(texts, type);
        this.skipUntil[index] = 0;
        stats.successes += 1;
        this.successes += 1;
        if (this.sticky) this.activeIndex = index;
        this.lastProvider = provider.name;
        this.logger(`[EmbeddingFallbackChain] provider '${provider.name}' succeeded`);
        return vectors;
      } catch (error) {
        lastError = error;
        const message = errorMessage(error);
        stats.failures += 1;
        stats.lastError = message;
        this.failures += 1;
        if (this.cooldownMs > 0) this.skipUntil[index] = Date.now() + this.cooldownMs;
        const next = this.providers[order[attemptIndex + 1]];
        this.logFallback({ from: provider.name, to: next?.name, error: message });
        if (next) await this.sleep(this.delayFor(attemptIndex));
      } finally {
        if (halfOpen) this.halfOpenBusy[index] = false;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  getStats(): FallbackChainStats {
    return {
      attempts: this.attempts,
      failures: this.failures,
      successes: this.successes,
      activeProvider: this.providers[this.activeIndex]?.name,
      lastProvider: this.lastProvider,
      providers: structuredClone(this.providerStats),
    };
  }

  private logFallback(event: FallbackChainEvent): void {
    this.onFallback?.(event);
    if (event.to) {
      this.logger(`[EmbeddingFallbackChain] provider '${event.from}' failed (${event.error}); falling back to '${event.to}'`);
      return;
    }
    this.logger(`[EmbeddingFallbackChain] provider '${event.from}' failed (${event.error}); no fallback provider remains`);
  }

  private providerOrder(): number[] {
    return this.providers.map((_, offset) => (this.activeIndex + offset) % this.providers.length);
  }

  /** providerOrder minus providers in cooldown — unless that empties the list. */
  private tryOrder(): number[] {
    const order = this.providerOrder();
    if (this.cooldownMs <= 0) return order;
    const now = Date.now();
    const open = order.filter((index) => this.skipUntil[index] <= now);
    return open.length > 0 ? open : order;
  }

  private delayFor(failureIndex: number): number {
    return Math.min(
      this.initialBackoffMs * this.backoffFactor ** failureIndex,
      this.maxBackoffMs,
    );
  }

  /** Bounded half-open re-try that ABORTS the underlying request on timeout. */
  private halfOpenProbe(provider: EmbeddingProvider, texts: string[], type?: EmbedType): Promise<number[][]> {
    const controller = new AbortController();
    return raceTimeout(
      provider.embed(texts, type, controller.signal),
      this.halfOpenTimeoutMs,
      provider.name,
      () => controller.abort(),
    );
  }

  private statsFor(provider: string): FallbackProviderStats {
    return this.providerStats[provider] ??= { attempts: 0, failures: 0, successes: 0 };
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function raceTimeout(
  pending: Promise<number[][]>,
  ms: number,
  provider: string,
  onTimeout?: () => void,
): Promise<number[][]> {
  pending.catch(() => undefined);
  return new Promise<number[][]>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout?.(); // abort the underlying request — don't just abandon it
      reject(new Error(`half-open probe of '${provider}' timed out after ${ms}ms`));
    }, ms);
    pending.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
