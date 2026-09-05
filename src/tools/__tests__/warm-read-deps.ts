/**
 * Warm the modules `oracle_read` imports lazily on its first call — server/logging.ts (opens the
 * default storage and runs its migrations) and vault/handler.ts. Under `bun test --isolate` each
 * file is a fresh process; on the PR-gate runner that cold import + transpile landed inside the
 * first read test's 5 s budget and timed out (runs 33971035968 / 33972148969) while passing
 * locally. Import this from a test file's top level so the cost is paid before any test starts.
 * No timeout is raised anywhere; tests measure the read, not the runtime's cold start.
 */
await import('../../server/logging.ts');
await import('../../vault/handler.ts');
