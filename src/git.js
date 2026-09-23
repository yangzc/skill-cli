import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { HOME, expandHome, ensureDir } from './util.js';
import { CACHE_DIR } from './config.js';

const pExecFile = promisify(execFile);

/* ---------------------------------------------------- ssh connection reuse */

/**
 * Is this remote reached over ssh (and therefore multiplexable)?
 * Matches `ssh://...`, `git@host:path` and any `user@host:path` scp-ish form.
 */
export function isSshRemote(url) {
  const s = String(url || '');
  return /^ssh:\/\//i.test(s) || /^[^/@\s]+@[^/\s:]+:/.test(s);
}

const MUX_DIR = path.join(CACHE_DIR, 'ssh');
let muxPath = null;

/** Single-quote a value for the shell git runs GIT_SSH_COMMAND through. */
const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/**
 * Reuse one ssh connection for every git call in this process - and for a while
 * after it exits. Without this, a single `skm push` opens two connections (the
 * fetch, then the push), so a passphrase-protected key is asked for twice; with
 * it the second network call rides on the first connection.
 *
 * Disabled when the user already configures ssh themselves (GIT_SSH_COMMAND /
 * GIT_SSH) or opts out with SKM_NO_SSH_MUX=1. Lifetime is SKM_SSH_PERSIST.
 */
function sshMuxEnv() {
  if (process.env.SKM_NO_SSH_MUX) return {};
  if (process.env.GIT_SSH_COMMAND || process.env.GIT_SSH) return {};

  if (muxPath === null) {
    try {
      fs.mkdirSync(MUX_DIR, { recursive: true, mode: 0o700 });
      // %C is a hash of local host + remote host + port + remote user, so each
      // destination gets its own socket instead of fighting over one.
      muxPath = path.join(MUX_DIR, 'cm-%C');
    } catch {
      muxPath = ''; // unwritable cache dir - silently give up
    }
  }
  if (!muxPath) return {};

  const persist = process.env.SKM_SSH_PERSIST || '10m';
  return {
    GIT_SSH_COMMAND:
      `ssh -o ControlMaster=auto -o ControlPath=${shellQuote(muxPath)} ` +
      `-o ControlPersist=${persist}`,
  };
}

/** True when an ssh agent is running and actually holds at least one key. */
export async function sshAgentHasKeys() {
  if (!process.env.SSH_AUTH_SOCK && !process.env.SSH_AGENT_PID) return false;
  try {
    const { stdout } = await pExecFile('ssh-add', ['-l']);
    return stdout.trim().length > 0 && !/no identities/i.test(stdout);
  } catch {
    return false;
  }
}

export async function git(args, opts = {}) {
  const env = { ...process.env, ...sshMuxEnv(), ...(opts.env || {}) };
  try {
    const { stdout } = await pExecFile('git', args, {
      maxBuffer: 128 * 1024 * 1024,
      ...opts,
      env,
    });
    return stdout.trim();
  } catch (err) {
    const stderr = String(err.stderr || '').trim();
    const wrapped = new Error(stderr || err.message || `git ${args.join(' ')} failed`);
    wrapped.cause = err;
    throw wrapped;
  }
}

const URL_SCHEME = /^(https?|git|ssh|file):\/\//i;

/** Accept `owner/repo`, full URL, `git@host:owner/repo.git` or a local path. */
export function normalizeSource(input, cwd = process.cwd()) {
  const raw = String(input).trim().replace(/^["']|["']$/g, '');
  if (!raw) throw new Error('empty source');
  if (URL_SCHEME.test(raw) || raw.startsWith('git@')) return raw;
  if (raw.startsWith('/') || raw.startsWith('./') || raw.startsWith('../') || raw.startsWith('~')) {
    return path.resolve(cwd, expandHome(raw));
  }
  const ownerRepo = raw.replace(/\.git$/, '');
  if (/^[\w.-]+\/[\w.-]+$/.test(ownerRepo)) return `https://github.com/${ownerRepo}.git`;
  throw new Error(`cannot resolve source: ${input}`);
}

export function sourceLabel(url) {
  const s = String(url);
  const gh = /github\.com[/:]([^/]+)\/([^/#]+?)(?:\.git)?$/i.exec(s);
  if (gh) return `${gh[1]}/${gh[2]}`;
  const gl = /gitlab\.com[/:](.+?)(?:\.git)?$/i.exec(s);
  if (gl) return gl[1];
  if (s.startsWith('/') || s.startsWith('~') || /^[A-Za-z]:[\\/]/.test(s)) return s.replace(/\.git$/, '');
  return s.replace(/\.git$/, '').split(/[/:]/).filter(Boolean).slice(-2).join('/') || s;
}

export function shortSha(sha) {
  return String(sha || '').slice(0, 7);
}

async function defaultBranch(dir) {
  try {
    const head = await git(['-C', dir, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
    return head.replace(/^origin\//, '');
  } catch {
    return 'HEAD';
  }
}

/** Remote default branch, or null when origin/HEAD is unknown. */
export async function defaultBranchOf(dir) {
  const b = await defaultBranch(dir);
  return b === 'HEAD' ? null : b;
}

/** The branch HEAD points at (unborn branches count), or null when detached. */
export async function headBranchName(dir) {
  try {
    return await git(['-C', dir, 'symbolic-ref', '--short', 'HEAD']);
  } catch {
    return null;
  }
}

export async function localBranchExists(dir, branch) {
  if (!branch) return false;
  try {
    await git(['-C', dir, 'rev-parse', '--verify', `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

/** How many commits `branch` is ahead of `origin/<branch>`; null when unknown. */
export async function commitsAhead(dir, branch) {
  try {
    const out = await git([
      '-C',
      dir,
      'rev-list',
      '--count',
      `refs/remotes/origin/${branch}..${branch}`,
    ]);
    return Number(out) || 0;
  } catch {
    return null;
  }
}

export async function remoteBranchExists(dir, branch) {
  if (!branch || branch === 'HEAD') return false;
  try {
    await git(['-C', dir, 'rev-parse', '--verify', `refs/remotes/origin/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

/** Identity to commit with, filling in a fallback when git has none configured. */
export async function commitIdentity(dir) {
  const name = await git(['-C', dir, 'config', 'user.name']).catch(() => '');
  const email = await git(['-C', dir, 'config', 'user.email']).catch(() => '');
  const out = [];
  if (!name) out.push('-c', 'user.name=skm');
  if (!email) out.push('-c', 'user.email=skm@localhost');
  return out;
}

async function resolveCommit(dir, ref) {
  for (const candidate of [`refs/remotes/origin/${ref}`, `refs/tags/${ref}`, ref]) {
    try {
      const sha = await git(['-C', dir, 'rev-parse', '--verify', `${candidate}^{commit}`]);
      if (sha) return sha;
    } catch {
      /* try next */
    }
  }
  throw new Error(`ref not found in repository: ${ref}`);
}

export async function currentCommit(dir) {
  try {
    return await git(['-C', dir, 'rev-parse', 'HEAD']);
  } catch {
    return null;
  }
}

export async function diffNames(dir, from, to) {
  try {
    const out = await git(['-C', dir, 'diff', '--name-only', from, to]);
    return out.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Clone once, then fetch + check out `ref` (branch / tag / commit) into `dir`.
 */
export async function syncRepo({ url, ref, dir }) {
  await ensureDir(path.dirname(dir));

  let cloned = false;
  if (!fs.existsSync(path.join(dir, '.git'))) {
    if (fs.existsSync(dir)) await fsp.rm(dir, { recursive: true, force: true });
    await git(['clone', '--quiet', url, dir]);
    cloned = true;
  } else {
    // The namespace may have been re-pointed at a different repository
    // (`ns set-url`, or `ns add <name> <url> --force`) - keep origin in sync.
    const current = await git(['-C', dir, 'remote', 'get-url', 'origin']).catch(() => null);
    if (current && current !== url) {
      await git(['-C', dir, 'remote', 'set-url', 'origin', url]);
    }
  }

  await git(['-C', dir, 'fetch', '--all', '--tags', '--prune', '--force', '--quiet']);

  // A freshly created remote has no refs at all - there is nothing to check out
  // yet. Its branches appear once `skm push` publishes the first commit.
  const remoteRefs = await git([
    '-C',
    dir,
    'for-each-ref',
    '--format=%(refname)',
    'refs/remotes/origin',
  ]).catch(() => '');
  if (!remoteRefs) return { dir, ref: ref || null, commit: null, cloned, empty: true };

  const targetRef = ref || (await defaultBranch(dir));
  const commit = await resolveCommit(dir, targetRef);
  await git(['-C', dir, 'checkout', '--force', '--detach', commit, '--quiet']);

  return { dir, ref: targetRef, commit, cloned, empty: false };
}

export const SKM_CACHE_FALLBACK = path.join(HOME, '.cache', 'skm');
