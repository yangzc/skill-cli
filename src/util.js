import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint = (code) => (s) => (useColor ? `\u001b[${code}m${s}\u001b[0m` : String(s));

export const color = {
  bold: paint('1'),
  dim: paint('2'),
  red: paint('31'),
  green: paint('32'),
  yellow: paint('33'),
  blue: paint('34'),
  magenta: paint('35'),
  cyan: paint('36'),
};

export const log = {
  raw: (m = '') => console.log(m),
  step: (m) => console.log(`${color.cyan('-')} ${m}`),
  ok: (m) => console.log(`${color.green('ok')} ${m}`),
  warn: (m) => console.warn(`${color.yellow('warn')} ${m}`),
  err: (m) => console.error(`${color.red('error')} ${m}`),
};

export function fail(message, code = 1) {
  log.err(message);
  process.exit(code);
}

export const HOME = os.homedir();

export function expandHome(p) {
  if (!p) return p;
  if (p === '~') return HOME;
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(HOME, p.slice(2));
  return p;
}

export function pathExistsSync(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

export async function pathExists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

export async function removeDir(dir) {
  await fsp.rm(dir, { recursive: true, force: true });
}

const IGNORE_NAMES = new Set(['.git', 'node_modules', '.DS_Store', '__pycache__']);

export async function copyDir(src, dest, ignore = IGNORE_NAMES) {
  await ensureDir(dest);
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    if (ignore.has(entry.name)) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(from, to, ignore);
    } else if (entry.isSymbolicLink()) {
      const link = await fsp.readlink(from);
      await fsp.symlink(link, to).catch(() => {});
    } else if (entry.isFile()) {
      await fsp.copyFile(from, to);
      const st = await fsp.stat(from);
      await fsp.chmod(to, st.mode).catch(() => {});
    }
  }
}

export async function walkFiles(dir, base = dir, out = []) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (IGNORE_NAMES.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkFiles(full, base, out);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

const MAX_HASH_BYTES = 1024 * 1024;

/** Content fingerprint of a skill folder (stable across machines). */
export async function hashDir(dir) {
  const files = (await walkFiles(dir)).sort();
  const h = crypto.createHash('sha1');
  for (const file of files) {
    const rel = path.relative(dir, file).split(path.sep).join('/');
    h.update(rel);
    h.update('\u0000');
    const st = await fsp.stat(file);
    if (st.size <= MAX_HASH_BYTES) h.update(await fsp.readFile(file));
    else h.update(`size:${st.size}`);
    h.update('\u0000');
  }
  return h.digest('hex');
}

/** Minimal YAML frontmatter reader (enough for `name` / `description`). */
export function parseFrontmatter(text) {
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) return {};
  const lines = match[1].split(/\r?\n/);
  const out = {};
  for (let i = 0; i < lines.length; i += 1) {
    const kv = /^([A-Za-z0-9_.-]+):[ \t]*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    const key = kv[1];
    let value = kv[2].trim();
    if (/^[>|][+-]?$/.test(value)) {
      const block = [];
      while (i + 1 < lines.length && (/^\s+/.test(lines[i + 1]) || lines[i + 1].trim() === '')) {
        i += 1;
        block.push(lines[i].replace(/^\s+/, ''));
      }
      value = block.join(value.startsWith('|') ? '\n' : ' ').trim();
    } else {
      value = value.replace(/^["']|["']$/g, '');
    }
    out[key] = value;
  }
  return out;
}

export function truncate(str, max) {
  const s = String(str);
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}...`;
}

const ANSI_RE = /\u001b\[[0-9;]*m/g;

/** Display width: ANSI colour codes must not count towards column widths. */
export function visibleLength(str) {
  return String(str).replace(ANSI_RE, '').length;
}

export function stripAnsi(str) {
  return String(str).replace(ANSI_RE, '');
}

export function pad(str, width) {
  const s = String(str);
  return s + ' '.repeat(Math.max(0, width - visibleLength(s)));
}

export function nowIso() {
  return new Date().toISOString();
}

export function table(rows, headers) {
  const widths = headers.map((h, i) =>
    Math.max(visibleLength(h), ...rows.map((r) => visibleLength(r[i] ?? ''))),
  );
  const line = (cells) =>
    cells
      .map((c, i) => pad(c, widths[i]))
      .join('  ')
      .trimEnd();
  return [line(headers.map((h) => color.bold(h))), ...rows.map((r) => line(r))];
}
