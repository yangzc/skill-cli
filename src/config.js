import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ensureDir } from './util.js';

const HOME = os.homedir();

/** All paths respect SKM_HOME / SKM_CACHE_HOME / XDG_* so the tool is testable & relocatable. */
export const CONFIG_DIR = process.env.SKM_HOME
  ? path.resolve(process.env.SKM_HOME)
  : path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'), 'skm');

export const CACHE_DIR = process.env.SKM_CACHE_HOME
  ? path.resolve(process.env.SKM_CACHE_HOME)
  : path.join(process.env.XDG_CACHE_HOME || path.join(HOME, '.cache'), 'skm');

export const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
export const REPOS_DIR = path.join(CACHE_DIR, 'repos');

const empty = () => ({ version: 2, current: null, namespaces: {}, hints: {} });

export async function loadConfig() {
  try {
    const parsed = JSON.parse(await fsp.readFile(CONFIG_FILE, 'utf8'));
    return {
      version: 2,
      current: parsed.current || null,
      namespaces:
        parsed.namespaces && typeof parsed.namespaces === 'object' ? parsed.namespaces : {},
      // One-shot tips already shown (so `skm push` does not nag on every run).
      hints: parsed.hints && typeof parsed.hints === 'object' ? parsed.hints : {},
    };
  } catch {
    return empty();
  }
}

export async function saveConfig(cfg) {
  await ensureDir(CONFIG_DIR);
  const namespaces = Object.fromEntries(
    Object.entries(cfg.namespaces).sort(([a], [b]) => a.localeCompare(b)),
  );
  const payload = { version: 2, current: cfg.current || null, namespaces };
  if (cfg.hints && Object.keys(cfg.hints).length) payload.hints = cfg.hints;
  await fsp.writeFile(CONFIG_FILE, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

/** One git worktree per namespace (namespace name == cache folder name). */
export function repoDirFor(name) {
  return path.join(REPOS_DIR, String(name).replace(/[^\w.-]/g, '_'));
}

/** `https://github.com/heygen-com/hyperframes.git` -> `hyperframes` */
export function deriveNamespaceName(url) {
  const cleaned = String(url)
    .replace(/\.git$/, '')
    .replace(/[/\\]+$/, '');
  const parts = cleaned.split(/[/:]/).filter(Boolean);
  const last = parts[parts.length - 1] || 'default';
  return last.replace(/[^\w.-]/g, '-').toLowerCase();
}

export function namespaceNames(cfg) {
  return Object.keys(cfg.namespaces);
}

export function getNamespace(cfg, name) {
  return name && cfg.namespaces[name] ? cfg.namespaces[name] : null;
}
