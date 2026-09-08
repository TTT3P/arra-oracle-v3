/**
 * OM-BL-2026-09-08-03: writes made while a request that claimed a seat is in flight are
 * attributed to that seat in audit_log.who; requests without a seat stay 'http', and
 * out-of-request writes stay 'system'.
 */
import { afterEach, expect, test } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { settings } from '../../src/db/schema.ts';
import { createDbContextFetch, runWithDbRequestContext } from '../../src/middleware/db-context.ts';
import { SEAT_HEADER } from '../../src/middleware/seat-identity.ts';
import { auditLog } from '../../src/storage/audit-log.ts';
import { createStorageBackend } from '../../src/storage/registry.ts';
import type { StorageBackend } from '../../src/storage/types.ts';

let tempDir = '';
let backend: StorageBackend | undefined;
afterEach(() => {
  backend?.close();
  backend = undefined;
  if (tempDir && fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true });
  tempDir = '';
});

test('audit_log.who is the seat named by the request, else http, else system', async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arra-audit-seat-'));
  backend = createStorageBackend({ dbPath: path.join(tempDir, 'oracle.db') });
  const storage = backend;
  let n = 0;
  const write = () => storage.db.insert(settings).values({ key: `k${++n}`, value: 'v', updatedAt: n }).run();

  const fetch = createDbContextFetch(async () => { write(); return new Response('ok'); });
  await fetch(new Request('http://local/api/learn', { method: 'POST', headers: { [SEAT_HEADER]: 'erpproject' } }));
  await fetch(new Request('http://local/api/learn', { method: 'POST' }));
  runWithDbRequestContext('req-explicit', write, 'croo');
  write();

  const rows = storage.db.select().from(auditLog).orderBy(auditLog.id).all();
  expect(rows.map((row) => row.who)).toEqual(['erpproject', 'http', 'croo', 'system']);
  expect(rows[0]?.requestId).toBeTruthy();
  expect(rows[3]?.requestId).toBeNull();
});
