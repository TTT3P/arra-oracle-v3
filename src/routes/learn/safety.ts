import fs from 'fs';
import path from 'path';
import { ORACLE_DATA_DIR, REPO_ROOT } from '../../config.ts';
import { createContainedFile } from '../../learn/commit-file-write.ts';

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
  // Absent field → legacy server root. An explicitly blank/invalid value is an error, never a fallback.
  if (memoryOwnerRoot === undefined || memoryOwnerRoot === null) return repoRoot();
  const requested = memoryOwnerRoot.trim();
  if (!requested || !path.isAbsolute(requested) || requested.includes('\0')) throw new Error(INVALID_MEMORY_OWNER_ROOT);
  const real = realpathOrNull(requested);
  if (!real || !fs.statSync(real).isDirectory()) throw new Error(INVALID_MEMORY_OWNER_ROOT);
  // ψ must be a real directory inside the real root (a `ψ -> elsewhere` link is not a memory tree here).
  const psi = realpathOrNull(path.join(real, 'ψ'));
  if (!psi || !fs.statSync(psi).isDirectory() || !(psi === real || psi.startsWith(real + path.sep))) throw new Error(INVALID_MEMORY_OWNER_ROOT);
  const dataDir = realpathOrNull(process.env.ORACLE_DATA_DIR?.trim() || ORACLE_DATA_DIR);
  if (dataDir && real === dataDir) throw new Error(INVALID_MEMORY_OWNER_ROOT);
  return real;
}

/**
 * Create the learning file exclusively inside the real root. Returns the real
 * path, or false when a file/symlink already exists there. Throws
 * LEARNING_FILE_OUTSIDE_ROOT when a symlinked ancestor would take it outside.
 */
export function writeLearningFile(sourceFile: string, content: string, root: string = repoRoot()): string | false {
  const filePath = learningSourcePath(sourceFile, root);
  if (!filePath) throw new Error(INVALID_LEARNING_SOURCE_FILE);
  if (fs.existsSync(filePath)) return false;
  try {
    return createContainedFile(root, filePath, content);
  } catch (error) {
    if ((error as { code?: string }).code === 'EEXIST') return false;
    throw error;
  }
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
