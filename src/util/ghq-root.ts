/**
 * Resolve the ghq root the same way ghq itself does, without requiring the
 * ghq binary on PATH. MCP processes are spawned with a minimal PATH that
 * lacks /opt/homebrew/bin, so `ghq root` alone is not reliable — but git
 * lives in /usr/bin and carries the same answer via `git config ghq.root`.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

function spawnTrimmed(cmd: string[]): string | null {
  try {
    const out = Bun.spawnSync(cmd, { env: { ...process.env } }).stdout.toString().trim();
    return out || null;
  } catch {
    return null;
  }
}

export function detectGhqRoot(repoRoot: string): string {
  const envRoot = process.env.GHQ_ROOT?.trim();
  if (envRoot) return envRoot;

  const fromGhq = spawnTrimmed(['ghq', 'root']);
  if (fromGhq) return fromGhq;

  const home = process.env.HOME || os.homedir();

  const fromGit = spawnTrimmed(['git', 'config', '--get', 'ghq.root']);
  if (fromGit) return path.resolve(fromGit.replace(/^~(?=\/|$)/, home));

  const ghqDefault = path.join(home, 'ghq');
  if (fs.existsSync(ghqDefault)) return ghqDefault;

  const match = repoRoot.match(/^(.+?)\/github\.com\//);
  if (match) return match[1];

  // ghq lays repos out as <root>/<host>/<owner>/<repo>. Derive <root> only when the
  // segment three levels up is hostname-shaped (e.g. gitlab.com). Walking up blindly
  // from a repo that is not in such a layout (a tmp fixture, /app in a container)
  // yields an arbitrary ancestor such as `/`, and every ghq-aware lookup then treats
  // the whole filesystem as the ghq tree: resolveGhqAliasTargetByOrigin's symlink
  // sweep spawned one git per /dev/block, /dev/char, ... entry on the CI runner
  // (5-6 s per oracle_read FTS fallback; run 33972937476). Prefer the default
  // location, which may simply not exist — callers already treat that as "no ghq".
  const parts = path.resolve(repoRoot).split('/').filter(Boolean);
  const host = parts.length >= 4 ? parts[parts.length - 3] : undefined;
  return host && host.includes('.') ? '/' + parts.slice(0, -3).join('/') : ghqDefault;
}
