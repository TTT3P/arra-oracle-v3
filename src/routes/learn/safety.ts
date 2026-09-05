import fs from 'fs';
import path from 'path';
import { ORACLE_DATA_DIR, REPO_ROOT } from '../../config.ts';

const repoRoot = () => process.env.ORACLE_REPO_ROOT || REPO_ROOT;

export const INVALID_LEARNING_ID = 'Invalid learning id';
export const INVALID_LEARNING_SOURCE_FILE = 'Invalid learning sourceFile';
export const INVALID_MEMORY_OWNER_ROOT = 'Invalid memoryOwnerRoot';

function realpathOrNull(target: string): string | null {
  try { return fs.realpathSync(path.resolve(target)); } catch { return null; }
}

/**
 * Root the learning file is written under. With `memoryOwnerRoot` (sent by a
 * proxied MCP seat from its ORACLE_MEMORY_OWNER_ROOT) the file lands in the
 * caller's memory tree; without it the server's own REPO_ROOT is used, which
 * on the owner core resolves to the data dir — the pre-2026-09-05 behaviour.
 * Fail-closed: an explicit root must be absolute, exist, contain `ψ/`, and
 * must not be the Oracle data dir (TINE 2026-08-19: not a memory tree).
 */
export function resolveLearningRoot(memoryOwnerRoot?: string | null): string {
  const requested = memoryOwnerRoot?.trim();
  if (!requested) return repoRoot();
  if (!path.isAbsolute(requested) || requested.includes('\0')) throw new Error(INVALID_MEMORY_OWNER_ROOT);
  const real = realpathOrNull(requested);
  if (!real || !fs.statSync(real).isDirectory() || !fs.existsSync(path.join(real, 'ψ'))) throw new Error(INVALID_MEMORY_OWNER_ROOT);
  const dataDir = realpathOrNull(process.env.ORACLE_DATA_DIR?.trim() || ORACLE_DATA_DIR);
  if (dataDir && real === dataDir) throw new Error(INVALID_MEMORY_OWNER_ROOT);
  return real;
}

/** Create the learning file (never overwrite). Returns false when it already exists. */
export function writeLearningFile(sourceFile: string, content: string, root: string = repoRoot()): boolean {
  const filePath = learningSourcePath(sourceFile, root);
  if (!filePath) throw new Error(INVALID_LEARNING_SOURCE_FILE);
  if (fs.existsSync(filePath)) return false;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  try {
    fs.writeFileSync(filePath, content, { encoding: 'utf-8', flag: 'wx' });
  } catch (error) {
    if ((error as { code?: string }).code === 'EEXIST') return false;
    throw error;
  }
  return true;
}

export function safeLearningId(id: string): boolean {
  return /^[A-Za-z0-9._:-]{1,160}$/.test(id);
}

export function safeLearningSourceFile(sourceFile: string): string | null {
  const trimmed = sourceFile.trim();
  if (!trimmed || trimmed.includes('\0')) return null;
  const normalized = path.posix.normalize(trimmed.replaceAll('\\', '/'));
  if (path.posix.isAbsolute(normalized) || normalized === '.' || normalized === '..') return null;
  if (normalized.startsWith('../')) return null;
  return normalized;
}

export function learningSourcePath(sourceFile: string, rootDir: string = repoRoot()): string | null {
  const safeSourceFile = safeLearningSourceFile(sourceFile);
  if (!safeSourceFile) return null;
  const root = path.resolve(rootDir);
  const filePath = path.resolve(root, safeSourceFile);
  return filePath.startsWith(root + path.sep) ? filePath : null;
}
