/**
 * Root-cause guard (OM-BL-2026-09-20-01): the MAIN Oracle HTTP server's admission gate
 * (src/server/handlers.ts handleSearch → searchAdmission) is BYPASSED for /api/search when
 * VECTOR_URL is set, because the gateway (mounted at src/server.ts before searchRoutes)
 * auto-synthesizes a proxy route `{ match: '/api/search', service: 'vector' }` and forwards
 * the request upstream in onRequest — the local gated handler never runs.
 *
 * Consequence: ORACLE_SEARCH_MAX_INFLIGHT set on the main server has NO effect on /api/search;
 * the only gate that governs proxied search is the SIDECAR's own process gate (its own env).
 * This test pins that architectural fact so a future change that expects the main gate to bound
 * proxied search is caught. It documents behaviour; it is not itself the fix.
 */
import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Set a self-contained HOME/data-dir BEFORE importing the gateway module, so module-load-time
// validation (real-home checks) passes in a restricted seat. Import dynamically after.
const fixtureHome = fs.mkdtempSync(path.join(os.tmpdir(), 'arra-gw-home-'));
process.env.HOME = fixtureHome;
process.env.ORACLE_DATA_DIR = path.join(fixtureHome, 'data');
process.env.ORACLE_DB_PATH = path.join(fixtureHome, 'data', 'oracle.db');

const { loadGatewayConfig, compileRoutes, matchRoute } = await import('../index.ts');

describe('gateway proxies /api/search past the main-server admission gate', () => {
  test('VECTOR_URL synthesizes an /api/search → vector proxy route (non-local)', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arra-gw-bypass-'));
    try {
      const cfg = loadGatewayConfig(dataDir, 'http://127.0.0.1:47770'); // no config file → synthesize from VECTOR_URL
      expect(cfg).not.toBeNull();

      const searchRoute = cfg!.routes.find((r) => r.match === '/api/search');
      expect(searchRoute).toBeDefined();
      expect(searchRoute!.service).toBe('vector'); // proxied upstream, NOT 'local'

      // The compiled matcher resolves /api/search to a service that has a URL → gateway proxies it,
      // so gatewayPlugin.onRequest short-circuits before the local gated searchRoutes/handleSearch.
      const matched = matchRoute('/api/search', compileRoutes(cfg!.routes));
      expect(matched).not.toBeNull();
      expect(matched!.service).toBe('vector');
      expect(cfg!.services[matched!.service]?.url).toBeTruthy();
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test('no VECTOR_URL and no config → no gateway route, search stays local and gated', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arra-gw-local-'));
    try {
      const cfg = loadGatewayConfig(dataDir, undefined);
      expect(cfg).toBeNull(); // all routes local → main-server handleSearch admission gate governs
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
