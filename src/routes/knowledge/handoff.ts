/**
 * POST /api/handoff — write a handoff markdown file under ψ/inbox/handoff.
 */

import { Elysia } from 'elysia';
import path from 'path';
import { REPO_ROOT } from '../../config.ts';
import { tenantDataPath } from '../../middleware/tenant.ts';
import { HandoffBody } from './model.ts';
import { relativeKnowledgePath, safeHandoffSlug, writeHandoffFile } from '../../knowledge/handoff.ts';
import { INVALID_MEMORY_OWNER_ROOT, resolveLearningRoot } from '../learn/safety.ts';

const repoRoot = () => process.env.ORACLE_REPO_ROOT || REPO_ROOT;
const inboxDir = () => tenantDataPath(path.join(repoRoot(), 'ψ/inbox'));
export const handoffEndpoint = new Elysia().post(
  '/handoff',
  ({ body, set }) => {
    try {
      const data = (body ?? {}) as Record<string, any>;
      if (typeof data.content !== 'string' || !data.content.trim()) {
        set.status = 400;
        return { error: 'Missing required field: content' };
      }

      // Owner routing (OM-BL-2026-09-11-01): a proxied seat forwards its bound memoryOwnerRoot and the
      // file lands under <root>/ψ/inbox/handoff — same containment as learn (absolute, real, has ψ/,
      // never the data dir). Absent field → legacy server root (data dir on the owner core).
      let ownerRoot: string | null = null;
      if (data.memoryOwnerRoot !== undefined && data.memoryOwnerRoot !== null) {
        try { ownerRoot = resolveLearningRoot(String(data.memoryOwnerRoot)); }
        catch { set.status = 400; return { error: INVALID_MEMORY_OWNER_ROOT }; }
      }
      const root = ownerRoot ?? repoRoot();
      const dirPath = ownerRoot ? path.join(ownerRoot, 'ψ', 'inbox', 'handoff') : path.join(inboxDir(), 'handoff');
      const filePath = writeHandoffFile(dirPath, data.content, safeHandoffSlug(data.slug, data.content));

      set.status = 201;
      return {
        success: true,
        file: relativeKnowledgePath(root, filePath),
        message: 'Handoff written.',
        ...(ownerRoot ? { memoryOwnerRoot: ownerRoot } : {}),
      };
    } catch (error) {
      set.status = 500;
      return { error: error instanceof Error ? error.message : 'Unknown error' };
    }
  },
  {
    body: HandoffBody,
    detail: {
      tags: ['knowledge'],
      menu: { group: 'hidden' },
      summary: 'Write a handoff markdown file',
    },
  },
);
