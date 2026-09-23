import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { parseFrontmatter } from './util.js';

const SKIP_DIRS = new Set(['.git', 'node_modules', '__pycache__', 'dist', 'build']);
const SKILL_FILES = ['SKILL.md', 'skill.md', 'Skill.md'];

export function skillFileIn(dir) {
  for (const name of SKILL_FILES) {
    const full = path.join(dir, name);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

/**
 * Recursively discover skills (folders containing SKILL.md) inside a repo worktree.
 * A folder that is itself a skill is not scanned further.
 */
export async function findSkills(repoDir, maxDepth = 8) {
  const found = [];

  async function walk(dir, depth) {
    if (depth > maxDepth) return;
    const skillFile = skillFileIn(dir);
    if (skillFile) {
      const text = await fsp.readFile(skillFile, 'utf8').catch(() => '');
      const fm = parseFrontmatter(text);
      found.push({
        name: fm.name || path.basename(dir),
        description: fm.description || '',
        path: path.relative(repoDir, dir).split(path.sep).join('/') || '.',
        absPath: dir,
      });
      return;
    }

    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      await walk(path.join(dir, entry.name), depth + 1);
    }
  }

  await walk(repoDir, 0);
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

/** List skill folders already present in an install root (managed or not). */
export async function discoverInstalled(root) {
  const out = [];
  const entries = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const dir = path.join(root, entry.name);
    const skillFile = skillFileIn(dir);
    if (!skillFile) continue;
    const text = await fsp.readFile(skillFile, 'utf8').catch(() => '');
    const fm = parseFrontmatter(text);
    out.push({
      name: entry.name,
      declaredName: fm.name || '',
      description: fm.description || '',
      dir,
      isLink: entry.isSymbolicLink(),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function countFiles(dir) {
  let count = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    const entries = await fsp.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      if (entry.isDirectory()) stack.push(path.join(current, entry.name));
      else if (entry.isFile()) count += 1;
    }
  }
  return count;
}
