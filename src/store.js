import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { HOME, ensureDir, nowIso } from './util.js';

export const LOCK_FILENAME = '.skm-lock.json';
export const LOCK_VERSION = 2;

/**
 * When `--link` is requested, project installs can also be mirrored into these
 * agent-discoverable directories (relative to the cwd). The default install
 * root itself is the cwd (see projectRoots).
 */
const PROJECT_LINK_CANDIDATES = ['.codebuddy/skills', '.claude/skills', '.agents/skills'];

/**
 * Default project target: install directly into the current working directory,
 * one folder per skill ->  <cwd>/<skill-name>/
 */
export function projectRoots(cwd) {
  const root = cwd;
  const links = PROJECT_LINK_CANDIDATES.map((c) => path.join(cwd, c));
  return { root, links, scope: 'project' };
}

export function globalRoots() {
  return {
    root: path.join(HOME, '.agents', 'skills'),
    links: [path.join(HOME, '.codebuddy', 'skills')],
    scope: 'global',
  };
}

export function lockPathFor(root) {
  return path.join(root, LOCK_FILENAME);
}

export async function loadLock(root) {
  const file = lockPathFor(root);
  try {
    const parsed = JSON.parse(await fsp.readFile(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || typeof parsed.skills !== 'object') {
      return { version: LOCK_VERSION, root, skills: {} };
    }
    return { version: parsed.version || LOCK_VERSION, root, skills: parsed.skills || {} };
  } catch {
    return { version: LOCK_VERSION, root, skills: {} };
  }
}

export async function saveLock(root, lock) {
  await ensureDir(root);
  const payload = {
    version: LOCK_VERSION,
    updatedAt: nowIso(),
    skills: Object.fromEntries(
      Object.entries(lock.skills).sort(([a], [b]) => a.localeCompare(b)),
    ),
  };
  await fsp.writeFile(lockPathFor(root), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

/** Installed skills grouped by namespace: { ns: Set<skillName> } */
export function groupInstalledByNamespace(lock) {
  const groups = new Map();
  for (const [name, entry] of Object.entries(lock.skills)) {
    const ns = entry.namespace || '(unknown)';
    if (!groups.has(ns)) groups.set(ns, new Set());
    groups.get(ns).add(name);
  }
  return groups;
}
