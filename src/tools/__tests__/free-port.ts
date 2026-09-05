/**
 * An OS-allocated free TCP port for a test that spawns `bun src/server.ts`.
 *
 * The five MCP proxy tests used to pick a random port in a fixed 300–500 wide range
 * (48600–50900), which sits inside Linux's ephemeral range (32768–60999). On the PR-gate
 * runner one of them drew a port that was already taken, the server never bound, and the
 * test failed as "server did not become healthy" after 15 s while its siblings booted in
 * 0.8 s (PR #25 run 33981471153). Binding port 0 asks the kernel for a port nobody holds.
 */
export async function freePort(): Promise<number> {
  const probe = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const { port } = probe;
  probe.stop(true);
  return port;
}
