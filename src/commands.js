import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import {
  color,
  log,
  fail,
  ensureDir,
  removeDir,
  copyDir,
  hashDir,
  expandHome,
  pathExistsSync,
  truncate,
  pad,
  table,
  nowIso,
  parseFrontmatter,
} from './util.js';
import {
  normalizeSource,
  sourceLabel,
  syncRepo,
  shortSha,
  currentCommit,
  diffNames,
  git,
  defaultBranchOf,
  headBranchName,
  remoteBranchExists,
  localBranchExists,
  commitsAhead,
  commitIdentity,
  isSshRemote,
  sshAgentHasKeys,
} from './git.js';
import {
  projectRoots,
  globalRoots,
  loadLock,
  saveLock,
  lockPathFor,
  groupInstalledByNamespace,
} from './store.js';
import { findSkills, discoverInstalled, countFiles, skillFileIn } from './skills.js';
import {
  loadConfig,
  saveConfig,
  repoDirFor,
  deriveNamespaceName,
  namespaceNames,
} from './config.js';

const VERSION = JSON.parse(
  fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;

const ALIASES = {
  ls: 'ls',
  install: 'install',
  rm: 'rm',
  update: 'update',
  info: 'info',
  push: 'push',
  ns: 'ns',
  help: 'help',
  version: 'version',
};

/* ------------------------------------------------------------------ args */

export function parseArgs(argv) {
  const positional = [];
  const flags = {};
  const addFlag = (key, value) => {
    if (key in flags) {
      flags[key] = Array.isArray(flags[key]) ? [...flags[key], value] : [flags[key], value];
    } else {
      flags[key] = value;
    }
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq > -1) {
        addFlag(arg.slice(2, eq), arg.slice(eq + 1));
        continue;
      }
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        addFlag(key, next);
        i += 1;
      } else addFlag(key, true);
      continue;
    }
    if (arg.startsWith('-') && arg.length > 1) {
      const key = arg.slice(1);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        addFlag(key, next);
        i += 1;
      } else addFlag(key, true);
      continue;
    }
    positional.push(arg);
  }
  return { positional, flags };
}

function flagStr(flags, ...names) {
  for (const name of names) {
    const v = flags[name];
    if (typeof v === 'string') return v;
    if (Array.isArray(v)) {
      const last = v.filter((x) => typeof x === 'string').pop();
      if (last) return last;
    }
  }
  return null;
}

function flagList(flags, ...names) {
  const out = [];
  for (const name of names) {
    const v = flags[name];
    if (v === undefined || v === true) continue;
    out.push(...(Array.isArray(v) ? v : [v]).flatMap((x) => String(x).split(',')).map((s) => s.trim()).filter(Boolean));
  }
  return out;
}

function truthy(flags, ...names) {
  return names.some((n) => flags[n] === true || flags[n] === 'true');
}

/** `--ns <name>` / `--namespace <name>` / `-n <name>` */
function nsFlag(flags) {
  return flagStr(flags, 'ns', 'namespace', 'n');
}

/* ---------------------------------------------------------------- target */

function resolveTarget(ctx) {
  if (ctx.flags.dir) {
    return {
      root: path.resolve(ctx.cwd, expandHome(String(ctx.flags.dir))),
      links: [],
      scope: 'custom',
    };
  }
  if (ctx.flags.global || ctx.flags.g) return globalRoots();
  return projectRoots(ctx.cwd);
}

function linkEnabled(ctx, target) {
  if (truthy(ctx.flags, 'no-link')) return false;
  if (truthy(ctx.flags, 'link')) return true;
  return target.scope === 'global';
}

async function syncLinks(target, name, dest, enabled) {
  if (!enabled) return [];
  const created = [];
  for (const dir of target.links) {
    if (!pathExistsSync(path.dirname(dir))) continue;
    await ensureDir(dir);
    const linkPath = path.join(dir, name);
    await fsp.rm(linkPath, { recursive: true, force: true }).catch(() => {});
    try {
      await fsp.symlink(path.relative(dir, dest) || dest, linkPath, 'dir');
      created.push(linkPath);
    } catch {
      /* ignore */
    }
  }
  return created;
}

async function removeLinks(target, name) {
  const removed = [];
  for (const dir of target.links) {
    const linkPath = path.join(dir, name);
    try {
      const st = await fsp.lstat(linkPath);
      if (st.isSymbolicLink()) {
        await fsp.rm(linkPath, { force: true });
        removed.push(linkPath);
      }
    } catch {
      /* not present */
    }
  }
  return removed;
}

/* ------------------------------------------------------------ namespaces */

function pickNamespace(cfg, ctx, override) {
  const name = override || nsFlag(ctx.flags) || cfg.current;
  if (!name) {
    fail('no namespace selected.\n  add one:   skm ns add heygen-com/hyperframes\n  or pick:   skm ns use <name>');
  }
  const entry = cfg.namespaces[name];
  if (!entry) {
    const available = namespaceNames(cfg);
    fail(
      `unknown namespace: ${name}${available.length ? `\n  available: ${available.join(', ')}` : '\n  add one: skm ns add <url>'}`,
    );
  }
  return { name, entry };
}

/** `skm install hyperframes:hyperframes-core` -> namespace override + skill name */
function splitNsArg(arg, cfg) {
  const m = /^([\w.-]+):([^\s]+)$/.exec(String(arg));
  if (m && cfg.namespaces[m[1]]) return { ns: m[1], name: m[2] };
  return { ns: null, name: String(arg) };
}

async function ensureRepo(cfg, nsName, { fetch = false } = {}) {
  const entry = cfg.namespaces[nsName];
  const dir = repoDirFor(nsName);
  const present = fs.existsSync(path.join(dir, '.git'));

  if (!present || fetch) {
    const verb = present ? 'fetching' : 'cloning';
    log.step(`${verb} ${color.bold(nsName)} ${color.dim(entry.url)}`);
    const res = await syncRepo({ url: entry.url, ref: entry.ref, dir });
    entry.ref = res.ref;
    entry.commit = res.commit;
    entry.lastFetchedAt = nowIso();
    await saveConfig(cfg);
    return { ...res, dir, dirPath: dir, fetched: true };
  }
  return {
    dir,
    dirPath: dir,
    ref: entry.ref,
    commit: entry.commit,
    fetched: false,
    empty: !entry.commit,
  };
}

async function rememberSkills(cfg, nsName, available) {
  cfg.namespaces[nsName].skills = available.map((s) => s.name);
  await saveConfig(cfg);
}

/** Pure matcher: exact on name/path/basename first, then case-insensitive substring. */
function matchSkill(available, query) {
  const q = String(query).replace(/\/+$/, '');
  const exact = available.filter((s) => s.name === q || s.path === q || path.basename(s.path) === q);
  if (exact.length === 1) return { skill: exact[0] };
  if (exact.length > 1) return { error: 'ambiguous', matches: exact };

  const lower = q.toLowerCase();
  const partial = available.filter(
    (s) => s.name.toLowerCase().includes(lower) || s.path.toLowerCase().includes(lower),
  );
  if (partial.length === 1) return { skill: partial[0] };
  if (partial.length > 1) return { error: 'ambiguous', matches: partial };
  return { error: 'missing', matches: [] };
}

/** "did you mean" hint: other namespaces that do contain a matching skill. */
function crossNamespaceHint(cfg, nsName, query) {
  const q = String(query).toLowerCase();
  const hits = Object.entries(cfg.namespaces)
    .filter(([n]) => n !== nsName)
    .map(([n, e]) => [n, (e.skills || []).filter((s) => s.toLowerCase().includes(q))])
    .filter(([, list]) => list.length);
  if (!hits.length) return '';
  const lines = hits.map(([n, list]) => `    ${n}: ${list.join(', ')}`).join('\n');
  const first = hits[0][0];
  return `\n  found in other namespace(s):\n${lines}\n  install one with: skm install ${first}:<skill>   (or -n ${first})`;
}

function resolveSkill(available, query, cfg, nsName) {
  const m = matchSkill(available, query);
  if (m.skill) return m.skill;
  if (m.error === 'ambiguous') {
    log.raw(color.dim(`  matches: ${m.matches.map((s) => s.name).join(', ')}`));
    fail(`ambiguous skill "${query}" (${m.matches.length} matches)`);
  }
  fail(`skill "${query}" not found in namespace ${nsName}${crossNamespaceHint(cfg, nsName, query)}`);
  return null;
}

/* --------------------------------------------------------------- install */

async function installOne({ nsName, entry, skill, target, lock, force, link, name }) {
  const dest = path.join(target.root, name);
  if (pathExistsSync(dest) && !force) {
    log.warn(`${name} already installed  ${color.dim(dest)}  (use --force)`);
    return null;
  }

  await removeDir(dest);
  await ensureDir(target.root);
  await copyDir(skill.absPath, dest);
  const links = await syncLinks(target, name, dest, link);

  const prev = lock.skills[name];
  lock.skills[name] = {
    namespace: nsName,
    source: sourceLabel(entry.url),
    sourceUrl: entry.url,
    ref: entry.ref,
    commit: entry.commit,
    skillPath: skill.path,
    folderHash: await hashDir(dest),
    scope: target.scope,
    links,
    installedAt: prev?.installedAt || nowIso(),
    updatedAt: nowIso(),
  };
  return { name, dest, links };
}

/* --------------------------------------------------------------- commands */

async function cmdNs(sub, ctx) {
  const cfg = await loadConfig();
  const action = sub || 'ls';

  if (action === 'ls' || action === 'list') {
    const names = namespaceNames(cfg);
    if (truthy(ctx.flags, 'json')) {
      log.raw(JSON.stringify({ current: cfg.current, namespaces: cfg.namespaces }, null, 2));
      return;
    }
    if (!names.length) {
      log.raw(color.dim('no namespaces yet. add one:'));
      log.raw('  skm ns add heygen-com/hyperframes');
      return;
    }
    const target = resolveTarget(ctx);
    const lock = await loadLock(target.root);
    const groups = groupInstalledByNamespace(lock);
    const rows = names.map((n) => {
      const e = cfg.namespaces[n];
      return [
        n === cfg.current ? `${n} ${color.green('*')}` : n,
        e.url,
        `${e.ref || '-'}${e.commit ? `@${shortSha(e.commit)}` : ''}`,
        String(groups.get(n)?.size ?? 0),
        e.lastFetchedAt ? e.lastFetchedAt.slice(0, 10) : '-',
      ];
    });
    log.raw('');
    for (const line of table(rows, ['NAMESPACE', 'REPOSITORY', 'REF', 'INSTALLED', 'FETCHED'])) {
      log.raw(`  ${line}`);
    }
    log.raw(color.dim(`\n  * = current     install dir: ${target.root}`));
    return;
  }

  if (action === 'use') {
    const [wanted] = ctx.positional;
    if (!wanted) {
      if (!cfg.current) fail('no current namespace. usage: skm ns use <name>');
      log.raw(`${color.bold(cfg.current)}  ${color.dim(cfg.namespaces[cfg.current].url)}`);
      return;
    }
    if (!cfg.namespaces[wanted]) {
      const names = namespaceNames(cfg);
      fail(
        `unknown namespace: ${wanted}${names.length ? `\n  available: ${names.join(', ')}` : ''}`,
      );
    }
    cfg.current = wanted;
    await saveConfig(cfg);
    log.ok(`namespace -> ${color.bold(wanted)}`);
    return;
  }

  if (action === 'add') {
    const [first, second] = ctx.positional;
    if (!first) fail('usage: skm ns add <name> <git-url>\n       skm ns add <git-url>');

    let name;
    let rawUrl;
    if (second) {
      name = first;
      rawUrl = second;
    } else {
      rawUrl = first;
      name = deriveNamespaceName(normalizeSource(rawUrl, ctx.cwd));
    }
    if (!/^[\w.-]+$/.test(name)) fail(`invalid namespace name: ${name} (use letters, digits, . _ -)`);

    const url = normalizeSource(rawUrl, ctx.cwd);
    const existing = cfg.namespaces[name];
    if (existing && existing.url !== url && !truthy(ctx.flags, 'force')) {
      fail(`namespace "${name}" already points at ${existing.url}\n  pick another name or pass --force`);
    }

    cfg.namespaces[name] = {
      url,
      ref: flagStr(ctx.flags, 'ref', 'branch') || existing?.ref || null,
      commit: existing?.commit || null,
      createdAt: existing?.createdAt || nowIso(),
      updatedAt: nowIso(),
      lastFetchedAt: null,
      skills: existing?.skills || [],
    };
    await saveConfig(cfg);

    const { dirPath, empty } = await ensureRepo(cfg, name, { fetch: true });
    const available = await findSkills(dirPath);
    await rememberSkills(cfg, name, available);

    log.ok(`namespace ${color.bold(name)} -> ${sourceLabel(url)}`);
    log.raw(
      color.dim(
        empty
          ? '   repository is empty - publish into it with: skm push <skill>'
          : `${available.length} skill(s) available`,
      ),
    );

    if (!cfg.current || truthy(ctx.flags, 'use')) {
      cfg.current = name;
      await saveConfig(cfg);
      log.raw(color.dim(`   current namespace -> ${name}`));
    }
    return;
  }

  if (action === 'rm' || action === 'remove') {
    const name = ctx.positional[0] || nsFlag(ctx.flags);
    if (!name) fail('usage: skm ns rm <name> [--purge]');
    if (!cfg.namespaces[name]) fail(`unknown namespace: ${name}`);

    delete cfg.namespaces[name];
    if (cfg.current === name) cfg.current = namespaceNames(cfg)[0] || null;
    await saveConfig(cfg);

    if (truthy(ctx.flags, 'purge')) {
      await removeDir(repoDirFor(name));
    }
    log.ok(`removed namespace ${color.bold(name)}`);
    if (cfg.current) log.raw(color.dim(`   current namespace -> ${cfg.current}`));
    return;
  }

  if (action === 'set-url' || action === 'seturl') {
    const [name, rawUrl] = ctx.positional;
    if (!name || !rawUrl) fail('usage: skm ns set-url <name> <git-url>');
    const entry = cfg.namespaces[name];
    if (!entry) fail(`unknown namespace: ${name}\n  known: ${namespaceNames(cfg).join(', ') || '(none)'}`);

    const url = normalizeSource(rawUrl, ctx.cwd);
    const previous = entry.url;
    if (previous === url) {
      log.warn(`namespace ${name} already points at ${url}`);
      return;
    }

    entry.url = url;
    entry.updatedAt = nowIso();
    entry.commit = null;
    entry.lastFetchedAt = null;
    await saveConfig(cfg);

    await ensureRepo(cfg, name, { fetch: true });
    const available = await findSkills(repoDirFor(name));
    await rememberSkills(cfg, name, available);

    log.ok(`${color.bold(name)}: ${sourceLabel(previous)} -> ${sourceLabel(url)}`);
    log.raw(`   ${color.dim(`${available.length} skill(s) available`)}`);
    return;
  }

  if (action === 'info' || action === 'show') {
    const name = ctx.positional[0] || cfg.current;
    if (!name) fail('usage: skm ns info [name]');
    const entry = cfg.namespaces[name];
    if (!entry) fail(`unknown namespace: ${name}`);
    const target = resolveTarget(ctx);
    const lock = await loadLock(target.root);
    const installed = groupInstalledByNamespace(lock).get(name) ?? new Set();

    log.raw(`${color.bold(name)}${name === cfg.current ? ` ${color.green('* current')}` : ''}`);
    log.raw(`  ${color.dim('url')}        ${entry.url}`);
    log.raw(`  ${color.dim('ref')}        ${entry.ref || '-'}${entry.commit ? ` @ ${entry.commit}` : ''}`);
    log.raw(`  ${color.dim('cache')}      ${repoDirFor(name)}`);
    log.raw(`  ${color.dim('available')}  ${entry.skills?.length ?? '?'}`);
    log.raw(`  ${color.dim('installed')}  ${installed.size}`);
    log.raw(`  ${color.dim('created')}    ${entry.createdAt || '-'}`);
    log.raw(`  ${color.dim('fetched')}    ${entry.lastFetchedAt || '-'}`);
    return;
  }

  if (action === 'rename') {
    const [from, to] = ctx.positional;
    if (!from || !to) fail('usage: skm ns rename <old> <new>');
    if (!cfg.namespaces[from]) fail(`unknown namespace: ${from}`);
    if (cfg.namespaces[to]) fail(`namespace already exists: ${to}`);

    cfg.namespaces[to] = cfg.namespaces[from];
    delete cfg.namespaces[from];
    if (cfg.current === from) cfg.current = to;
    await saveConfig(cfg);

    if (fs.existsSync(repoDirFor(from))) {
      await ensureDir(path.dirname(repoDirFor(to)));
      await fsp.rename(repoDirFor(from), repoDirFor(to)).catch(() => {});
    }
    log.ok(`renamed ${from} -> ${to}`);
    return;
  }

  if (action === 'fetch') {
    const name = ctx.positional[0] || cfg.current;
    if (!name) fail('usage: skm ns fetch [name]');
    await ensureRepo(cfg, name, { fetch: true });
    const available = await findSkills(repoDirFor(name));
    await rememberSkills(cfg, name, available);
    log.ok(`${name} -> ${shortSha(cfg.namespaces[name].commit)} (${available.length} skills)`);
    return;
  }

  fail(`unknown ns subcommand: ${action}\n  try: skm ns [ls|add|use|rm|info|rename|set-url|fetch]`);
}

async function cmdLs(ctx) {
  const cfg = await loadConfig();
  const target = resolveTarget(ctx);
  const lock = await loadLock(target.root);
  const groups = groupInstalledByNamespace(lock);

  if (truthy(ctx.flags, 'installed', 'i')) {
    const entries = Object.entries(lock.skills);
    if (truthy(ctx.flags, 'json')) {
      log.raw(JSON.stringify({ dir: target.root, count: entries.length, skills: lock.skills }, null, 2));
      return;
    }
    log.raw(`${color.bold('installed')} in ${target.root} ${color.dim(`(${entries.length})`)}`);
    if (!entries.length) {
      log.raw(color.dim('\n  none. try: skm install --all'));
      return;
    }
    const rows = entries
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, e]) => [
        name,
        e.namespace || '-',
        `${e.ref || '-'}${e.commit ? `@${shortSha(e.commit)}` : ''}`,
        e.updatedAt ? e.updatedAt.slice(0, 16).replace('T', ' ') : '-',
      ]);
    log.raw('');
    for (const line of table(rows, ['NAME', 'NAMESPACE', 'REF', 'UPDATED'])) log.raw(`  ${line}`);
    return;
  }

  const allNs = truthy(ctx.flags, 'all', 'all-ns', 'all-namespaces');
  const filterNs = nsFlag(ctx.flags);
  const nsList = allNs ? namespaceNames(cfg) : [filterNs || cfg.current].filter(Boolean);
  if (!nsList.length) {
    fail('no namespace selected.\n  add one:   skm ns add heygen-com/hyperframes\n  or list:   skm ns ls');
  }

  const collected = [];
  for (const nsName of nsList) {
    if (!cfg.namespaces[nsName]) {
      fail(`unknown namespace: ${nsName}\n  known: ${namespaceNames(cfg).join(', ') || '(none)'}`);
    }
    const { dirPath } = await ensureRepo(cfg, nsName, { fetch: truthy(ctx.flags, 'refresh') });
    const available = await findSkills(dirPath);
    await rememberSkills(cfg, nsName, available);
    const installedSet = groups.get(nsName) ?? new Set();

    if (!allNs) {
      const e = cfg.namespaces[nsName];
      const tag = e.commit ? `${e.ref || '-'}@${shortSha(e.commit)}` : 'empty repository';
      log.raw(
        `${color.bold(nsName)}  ${color.dim(e.url)}\n  ${color.dim(
          `${tag}  ${available.length} available, ${installedSet.size} installed`,
        )}`,
      );
    }

    const nameWidth = Math.max(4, ...available.map((s) => s.name.length));
    for (const s of available) {
      const on = installedSet.has(s.name) || Boolean(lock.skills[s.name]);
      collected.push({
        namespace: nsName,
        name: s.name,
        installed: on,
        path: s.path,
        description: s.description,
      });
      if (allNs) continue;
      const mark = on ? color.green('installed') : color.dim('-');
      log.raw(`  ${color.cyan(pad(s.name, nameWidth))}  ${pad(mark, 12)} ${color.dim(s.path)}`);
      if (s.description && truthy(ctx.flags, 'verbose', 'v')) {
        log.raw(
          `  ${' '.repeat(nameWidth)}  ${color.dim(truncate(s.description.replace(/\s+/g, ' '), 90))}`,
        );
      }
    }
    if (!allNs && available.length) log.raw('');
  }

  if (truthy(ctx.flags, 'json')) {
    log.raw(JSON.stringify({ dir: target.root, count: collected.length, skills: collected }, null, 2));
    return;
  }

  if (allNs) {
    log.raw(color.dim(`across ${nsList.length} namespace(s)  ->  ${target.root}`));
    const rows = collected.map((r) => [
      r.name,
      r.namespace,
      r.installed ? color.green('installed') : color.dim('-'),
      r.path,
    ]);
    log.raw('');
    for (const line of table(rows, ['NAME', 'NAMESPACE', 'STATUS', 'PATH'])) log.raw(`  ${line}`);
  }
}

async function cmdAdd(ctx) {
  const cfg = await loadConfig();
  let nsOverride = null;
  const names = ctx.positional.map((arg) => {
    const split = splitNsArg(arg, cfg);
    if (split.ns && !nsOverride) nsOverride = split.ns;
    return split.name;
  });

  const { name: nsName, entry } = pickNamespace(cfg, ctx, nsOverride);
  const target = resolveTarget(ctx);

  const { dirPath, empty } = await ensureRepo(cfg, nsName, {
    fetch: !truthy(ctx.flags, 'offline', 'no-fetch'),
  });
  const available = await findSkills(dirPath);
  if (!available.length) {
    fail(
      empty
        ? `namespace ${nsName} points at an empty repository - publish a skill into it first:\n  skm push <skill>`
        : `no SKILL.md found in namespace ${nsName}`,
    );
  }
  await rememberSkills(cfg, nsName, available);

  let selected;
  if (truthy(ctx.flags, 'all')) {
    selected = available;
  } else if (!names.length) {
    log.raw(color.dim(`namespace ${nsName} has ${available.length} skill(s):`));
    log.raw(`  ${available.map((s) => s.name).join(', ')}`);
    fail('\nspecify skill name(s), or use --all');
  } else {
    selected = names.map((n) => resolveSkill(available, n, cfg, nsName));
  }

  const nameOverride = flagStr(ctx.flags, 'name', 'as');
  if (nameOverride && selected.length > 1) fail('--name only works when installing a single skill');

  const lock = await loadLock(target.root);
  const link = linkEnabled(ctx, target);
  const force = truthy(ctx.flags, 'force', 'f');

  let count = 0;
  for (const skill of selected) {
    const name = nameOverride || skill.name;
    const res = await installOne({
      nsName,
      entry,
      skill,
      target,
      lock,
      force,
      link,
      name,
    });
    if (!res) continue;
    count += 1;
    log.ok(`${color.bold(res.name)} ${color.dim(`<- ${nsName}:${skill.path}`)}`);
    if (res.links.length) log.raw(`   ${color.dim(`linked: ${res.links.join(', ')}`)}`);
  }

  if (count) await saveLock(target.root, lock);
  log.raw(
    color.dim(
      `\n${count} installed -> ${target.root}  ${color.dim(`(${Object.keys(lock.skills).length} total)`)}`,
    ),
  );
}

async function cmdRm(ctx) {
  const cfg = await loadConfig();
  const target = resolveTarget(ctx);
  const lock = await loadLock(target.root);
  const nsOverride = nsFlag(ctx.flags);

  let nsName = null;
  const names = [];
  for (const arg of ctx.positional) {
    const split = splitNsArg(arg, cfg);
    if (split.ns && !nsName) nsName = split.ns;
    names.push(split.name);
  }
  nsName = nsName || nsOverride || cfg.current;

  let targets;
  if (truthy(ctx.flags, 'all-ns', 'all-namespaces')) {
    targets = Object.keys(lock.skills);
  } else if (truthy(ctx.flags, 'all')) {
    if (!nsName) fail('no namespace selected; use --all-ns to remove everything');
    targets = Object.entries(lock.skills)
      .filter(([, e]) => e.namespace === nsName)
      .map(([n]) => n);
    if (!targets.length) {
      log.warn(`nothing installed from namespace ${nsName}`);
      return;
    }
  } else {
    if (!names.length) fail('usage: skm rm <skill...> | --all [-n ns] | --all-ns');
    targets = names;
  }

  let removed = 0;
  for (const name of targets) {
    const entry = lock.skills[name];
    const dest = path.join(target.root, name);
    const exists = pathExistsSync(dest);

    if (!entry && !exists) {
      log.warn(`not found: ${name}`);
      continue;
    }
    if (entry && truthy(ctx.flags, 'verify') && exists) {
      const current = await hashDir(dest).catch(() => null);
      if (current && current !== entry.folderHash) {
        log.warn(`${name} has local modifications (removing anyway)`);
      }
    }
    if (exists) await removeDir(dest);
    await removeLinks(target, name);
    if (entry) delete lock.skills[name];
    removed += 1;
    log.ok(`removed ${color.bold(name)}${entry ? color.dim(` (${entry.namespace})`) : ''}`);
  }

  if (removed) await saveLock(target.root, lock);
  log.raw(color.dim(`\n${removed} removed, ${Object.keys(lock.skills).length} left in ${target.root}`));
}

async function cmdGet(ctx) {
  const cfg = await loadConfig();
  const { name: nsName, entry } = pickNamespace(cfg, ctx);
  const target = resolveTarget(ctx);
  const dir = repoDirFor(nsName);

  const before = await currentCommit(dir);
  const previousSkills = new Set(entry.skills || []);

  await ensureRepo(cfg, nsName, { fetch: true });
  const after = await currentCommit(dir);
  const available = await findSkills(dir);
  await rememberSkills(cfg, nsName, available);

  const changedFiles = before && after && before !== after ? await diffNames(dir, before, after) : [];
  const changedSkills = new Set();
  for (const file of changedFiles) {
    for (const s of available) {
      if (s.path === '.' || file === s.path || file.startsWith(`${s.path}/`)) changedSkills.add(s.name);
    }
  }

  const added = available.map((s) => s.name).filter((n) => !previousSkills.has(n));
  const gone = [...previousSkills].filter((n) => !available.some((s) => s.name === n));

  log.raw(
    `${color.bold(nsName)}  ${color.dim(`${shortSha(before) || '-'} -> ${shortSha(after)}`)}  ${color.dim(`${available.length} skills`)}`,
  );
  if (added.length) log.raw(`  ${color.green('+')} new:     ${added.join(', ')}`);
  if (gone.length) log.raw(`  ${color.red('-')} removed: ${gone.join(', ')}`);
  if (changedSkills.size) log.raw(`  ${color.yellow('~')} changed: ${[...changedSkills].join(', ')}`);
  if (!added.length && !gone.length && !changedSkills.size) {
    log.raw(color.dim('  no changes'));
  }

  const lock = await loadLock(target.root);
  const installedHere = Object.entries(lock.skills)
    .filter(([, e]) => e.namespace === nsName)
    .map(([n]) => n);

  const toRefresh = ctx.positional.length
    ? ctx.positional.map((n) => {
        const split = splitNsArg(n, cfg);
        return split.name;
      })
    : truthy(ctx.flags, 'installed', 'i')
      ? installedHere
      : [];

  if (!toRefresh.length) {
    if (installedHere.length) {
      log.raw(color.dim(`\n  reinstall with: skm update --installed   (${installedHere.length} installed)`));
    }
    return;
  }

  let count = 0;
  for (const name of toRefresh) {
    const skill = available.find((s) => s.name === name);
    if (!skill) {
      log.warn(`not in namespace anymore: ${name}`);
      continue;
    }
    const res = await installOne({
      nsName,
      entry: cfg.namespaces[nsName],
      skill,
      target,
      lock,
      force: true,
      link: linkEnabled(ctx, target),
      name,
    });
    if (!res) continue;
    count += 1;
    log.ok(`updated ${color.bold(name)} -> ${shortSha(after)}`);
  }
  if (count) await saveLock(target.root, lock);
}

/* -------------------------------------------------------------------- push */

/** Skill folders sitting a level or two below cwd - used for "did you mean". */
function nearbySkills(cwd, maxDepth = 2) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > maxDepth || out.length >= 12) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (skillFileIn(full)) {
        out.push(path.relative(cwd, full) || '.');
        continue;
      }
      walk(full, depth + 1);
    }
  };
  walk(cwd, 1);
  return out;
}

/** Resolve a `push` argument to a local folder that actually holds SKILL.md. */
function resolvePushSource(arg, target, cwd) {
  const raw = String(arg);
  const installed = path.join(target.root, raw);
  if (skillFileIn(installed)) return installed;

  const asPath = path.resolve(cwd, expandHome(raw));
  if (skillFileIn(asPath)) return asPath;
  if (pathExistsSync(asPath)) fail(`${asPath} has no SKILL.md - a skill folder must contain one`);

  const here = pathExistsSync(target.root)
    ? fs.readdirSync(target.root).filter((n) => skillFileIn(path.join(target.root, n)))
    : [];
  const near = nearbySkills(cwd);
  fail(
    `cannot find skill "${raw}"\n` +
      (here.length ? `  installed here:  ${here.join(', ')}\n` : '') +
      (near.length ? `  nearby folders:  ${near.join(', ')}\n` : '') +
      '  a source must be a folder containing SKILL.md',
  );
  return null;
}

function readSkillMeta(dir) {
  const file = skillFileIn(dir);
  const fm = file ? parseFrontmatter(fs.readFileSync(file, 'utf8')) : {};
  const base = path.basename(dir);
  return { name: fm.name || base, description: fm.description || '', base };
}

const quoteArg = (s) => (/[\s"'$]/.test(String(s)) ? JSON.stringify(String(s)) : String(s));

/**
 * One-shot nudge about ssh passphrases. `skm push` already multiplexes ssh so a
 * key is only unlocked once per connection window, but an agent removes even
 * that. Shown once, then remembered in config so it never nags again.
 */
function hintSshAgent(cfg, entry) {
  if (cfg.hints?.sshKey || !isSshRemote(entry.url)) return;
  if (process.env.SKM_NO_SSH_MUX || process.env.GIT_SSH_COMMAND || process.env.GIT_SSH) return;
  cfg.hints = { ...(cfg.hints || {}), sshKey: true };
  log.raw(
    color.dim(
      '  tip: skm reuses one ssh connection per push, so your passphrase is asked\n' +
        '       once instead of twice. to stop being asked at all:\n' +
        '         ssh-add --apple-use-keychain ~/.ssh/id_rsa       # macOS\n' +
        '         eval "$(ssh-agent -s)" && ssh-add ~/.ssh/id_rsa  # Linux',
    ),
  );
}

/** Repo-internal `--path` value, validated to stay inside the worktree. */
function validateRelPath(explicit) {
  const raw = String(explicit).trim();
  if (raw.startsWith('/') || raw.startsWith('~') || /^[A-Za-z]:[\\/]/.test(raw)) {
    fail(`--path must be relative to the repo, not an absolute path: ${explicit}`);
  }
  const rel = raw.replace(/^\.\//, '').replace(/[\\/]+$/, '');
  if (!rel || rel === '.') fail('--path must name a folder inside the repo, e.g. --path skills/my-skill');
  if (rel.split(/[\\/]/).includes('..')) fail(`invalid --path (escapes the repo): ${explicit}`);
  return rel.split(path.sep).join('/');
}

async function cmdPush(ctx) {
  const cfg = await loadConfig();

  // The arg parser lets any flag swallow the next bare word, so `skm push
  // --local my-skill` hides the source inside a boolean flag. Hand those back
  // and restore the flag to a plain boolean.
  const boolFlags = ['push', 'p', 'local', 'no-push', 'commit-only', 'force', 'f', 'dry-run', 'dry'];
  const rescued = [];
  for (const n of boolFlags) {
    const v = ctx.flags[n];
    if (v === undefined) continue;
    const list = Array.isArray(v) ? v : [v];
    for (const item of list) {
      if (typeof item === 'string' && item !== 'true' && item !== 'false') rescued.push(item);
    }
    ctx.flags[n] = list.includes('false') ? false : true;
  }
  const sources = [...rescued, ...ctx.positional];

  // `push` pushes. `--local` keeps the commit in the cache repo only.
  const wantPush = !truthy(ctx.flags, 'local', 'no-push', 'commit-only');

  const { name: nsName, entry } = pickNamespace(cfg, ctx, null);
  const target = resolveTarget(ctx);
  const lock = await loadLock(target.root);
  const explicitPath = flagStr(ctx.flags, 'path', 'to');
  const branchFlag = flagStr(ctx.flags, 'branch', 'b');
  const dryRun = truthy(ctx.flags, 'dry-run', 'dry');
  const force = truthy(ctx.flags, 'force', 'f');

  const srcArgs = sources.length ? sources : ['.'];
  const srcDirs = srcArgs.map((a) => resolvePushSource(a, target, ctx.cwd));
  if (explicitPath && srcDirs.length > 1) fail('--path only works when pushing a single skill');

  const planned = srcDirs.map((dir) => {
    const meta = readSkillMeta(dir);
    // If this folder was installed from the namespace, remember where it came
    // from, so it is republished in place instead of creating a duplicate.
    const lockKey = Object.keys(lock.skills).find(
      (k) => path.resolve(target.root, k) === path.resolve(dir),
    );
    const rec = lockKey ? lock.skills[lockKey] : null;
    const ownPath = rec && rec.namespace === nsName && rec.skillPath ? rec.skillPath : null;
    const rel = explicitPath
      ? validateRelPath(explicitPath)
      : ownPath || `skills/${String(meta.name).replace(/[\\/]+/g, '-')}`;
    return { dir, ...meta, rel, ownPath };
  });

  if (!cfg.hints?.sshKey && !(await sshAgentHasKeys())) hintSshAgent(cfg, entry);

  const { dirPath, empty } = await ensureRepo(cfg, nsName, { fetch: true });

  // Commit onto a real branch (the cache is normally in detached HEAD): an
  // explicit --branch, else the namespace ref when that is a branch, else
  // origin/HEAD, else - for a brand new remote - whatever HEAD points at.
  let branch = branchFlag;
  let refIsBranch = false;
  if (!branch && entry.ref) {
    refIsBranch = await remoteBranchExists(dirPath, entry.ref);
    if (refIsBranch) branch = entry.ref;
  }
  if (!branch) branch = (await defaultBranchOf(dirPath)) || (await headBranchName(dirPath));
  if (!branch) fail('cannot determine a branch to commit onto; pass --branch <name>');
  if (entry.ref && !refIsBranch && !branchFlag && entry.ref !== branch) {
    log.warn(`namespace ${nsName} is pinned to ${entry.ref}; committing onto ${color.bold(branch)}`);
  }

  if (dryRun) {
    log.raw(`${color.bold('dry run')} - nothing written`);
    for (const p of planned) log.raw(`  ${p.dir}  ->  ${nsName}:${p.rel}`);
    log.raw(
      color.dim(`  branch ${branch}, ${wantPush ? 'commit + push' : 'commit only (--local)'}`),
    );
    return;
  }

  let base = `refs/remotes/origin/${branch}`;
  if (!(await remoteBranchExists(dirPath, branch))) {
    const fallback = await defaultBranchOf(dirPath);
    if (fallback && fallback !== branch) {
      log.warn(`branch ${color.bold(branch)} does not exist on origin; starting from ${fallback}`);
      base = `refs/remotes/origin/${fallback}`;
    } else {
      // Empty remote (or dangling origin/HEAD): this push creates the branch.
      base = null;
      if (!empty) log.warn(`branch ${color.bold(branch)} does not exist on origin; creating it`);
    }
  }
  if (await localBranchExists(dirPath, branch)) {
    // Switch to the existing local branch rather than resetting it, so commits
    // made by an earlier (not yet pushed) `skm push` survive.
    await git(['-C', dirPath, 'checkout', '--quiet', branch]);
  } else if (base) {
    await git(['-C', dirPath, 'checkout', '-B', branch, base, '--quiet']);
  } else if ((await headBranchName(dirPath)) !== branch) {
    await git(['-C', dirPath, 'checkout', '-B', branch, '--quiet']);
  }

  const pushed = [];
  for (const p of planned) {
    const dest = path.join(dirPath, p.rel);
    if (skillFileIn(dest) && p.ownPath !== p.rel) {
      const existing = readSkillMeta(dest);
      if (existing.name !== p.name && !force) {
        fail(
          `${nsName}:${p.rel} already holds a different skill "${existing.name}"\n  pass --path <dir> to publish elsewhere, or --force to overwrite`,
        );
      }
    }
    await removeDir(dest);
    await copyDir(p.dir, dest);
    log.ok(`${color.bold(p.name)} -> ${nsName}:${p.rel}`);
    pushed.push(p);
  }

  await git(['-C', dirPath, 'add', '-A']);
  const dirty = Boolean(await git(['-C', dirPath, 'status', '--porcelain']));

  let sha = await currentCommit(dirPath);
  if (dirty) {
    const message =
      flagStr(ctx.flags, 'message', 'm') || `chore: sync ${pushed.map((p) => p.name).join(', ')}`;
    await git(['-C', dirPath, ...(await commitIdentity(dirPath)), 'commit', '-q', '-m', message]);
    sha = await currentCommit(dirPath);
    log.ok(`committed ${shortSha(sha)} on ${color.bold(branch)}  ${color.dim(truncate(message, 56))}`);
  } else {
    log.warn('no file changes to commit - repo already matches');
  }

  // `ahead === null` means origin has no such branch yet - a brand new repository.
  const ahead = await commitsAhead(dirPath, branch);
  const hasWork = ahead === null || ahead > 0;
  if (hasWork) {
    if (!entry.ref) entry.ref = branch;
    entry.commit = sha;
    entry.lastFetchedAt = nowIso();
    await saveConfig(cfg);
    await rememberSkills(cfg, nsName, await findSkills(dirPath));
  }

  if (wantPush) {
    if (hasWork) {
      await git(['-C', dirPath, 'push', 'origin', `${branch}:${branch}`]);
      log.ok(
        `pushed ${ahead === null ? `new branch ${branch}` : `${ahead} commit(s)`} -> ${sourceLabel(entry.url)}`,
      );
    } else {
      log.warn(`nothing to push - origin/${branch} already matches`);
    }
  } else if (hasWork) {
    const pending =
      ahead === null ? `branch ${branch} is not on origin yet` : `${ahead} commit(s) not pushed yet`;
    log.raw(
      color.dim(
        `\n  committed locally only (--local). publish with:\n    skm push ${srcArgs.map(quoteArg).join(' ')}\n` +
          `  (a later "skm ns fetch" / "skm install --refresh" re-detaches the cache to origin;\n` +
          `   the commit stays reachable on branch ${branch})`,
      ),
    );
  }

  // If we just republished something that is also installed here, record the new
  // commit so `skm info` stops reporting it as locally modified.
  let touched = 0;
  for (const p of pushed) {
    const key = Object.keys(lock.skills).find(
      (k) => path.resolve(target.root, k) === path.resolve(p.dir),
    );
    const le = key ? lock.skills[key] : null;
    if (!le) continue;
    le.namespace = nsName;
    le.skillPath = p.rel;
    le.commit = sha;
    le.ref = branch;
    le.folderHash = await hashDir(p.dir);
    le.updatedAt = nowIso();
    touched += 1;
  }
  if (touched) {
    await saveLock(target.root, lock);
    log.raw(color.dim(`   refreshed ${touched} install record(s)`));
  }
}

async function cmdInfo(ctx) {
  const cfg = await loadConfig();
  const [rawArg] = ctx.positional;
  if (!rawArg) fail('usage: skm info <skill>');

  const split = splitNsArg(rawArg, cfg);
  const name = split.name;
  const target = resolveTarget(ctx);
  const lock = await loadLock(target.root);

  const installed = lock.skills[name] || null;
  const nsName = split.ns || installed?.namespace || cfg.current;
  const dirPath = nsName && cfg.namespaces[nsName] ? repoDirFor(nsName) : null;
  let inRepo = null;
  if (dirPath && fs.existsSync(path.join(dirPath, '.git'))) {
    inRepo = (await findSkills(dirPath)).find((s) => s.name === name) || null;
  }

  const localDir = path.join(target.root, name);
  const exists = pathExistsSync(localDir);
  if (!installed && !inRepo && !exists) fail(`skill not found: ${name}`);

  if (truthy(ctx.flags, 'json')) {
    log.raw(JSON.stringify({ name, namespace: nsName, installed, inRepo, dir: localDir, exists }, null, 2));
    return;
  }

  log.raw(`${color.bold(name)}`);
  log.raw(`  ${color.dim('namespace')}  ${nsName || '-'}`);
  log.raw(`  ${color.dim('installed')}  ${installed ? 'yes' : 'no'}`);
  if (installed) {
    log.raw(`  ${color.dim('source')}     ${installed.source} (${installed.sourceUrl})`);
    log.raw(`  ${color.dim('ref')}        ${installed.ref} @ ${shortSha(installed.commit)}`);
    log.raw(`  ${color.dim('skillPath')}  ${installed.skillPath}`);
    log.raw(`  ${color.dim('updated')}    ${installed.updatedAt}`);
    if (installed.links?.length) log.raw(`  ${color.dim('links')}      ${installed.links.join(', ')}`);
  }
  if (inRepo) log.raw(`  ${color.dim('repo path')}  ${inRepo.path}`);
  if (exists) {
    log.raw(`  ${color.dim('dir')}        ${localDir}`);
    log.raw(`  ${color.dim('files')}      ${await countFiles(localDir)}`);
    if (installed) {
      const current = await hashDir(localDir).catch(() => null);
      const dirty = current && current !== installed.folderHash;
      log.raw(`  ${color.dim('modified')}   ${dirty ? color.yellow('yes') : 'no'}`);
    }
    if (skillFileIn(localDir)) log.raw(`  ${color.dim('skillfile')}  ${skillFileIn(localDir)}`);
  }
}

/* ------------------------------------------------------------------- ui */

function printDashboard(cfg, target, lock) {
  const groups = groupInstalledByNamespace(lock);
  log.raw(`${color.bold('skm')} ${color.dim(VERSION)}`);
  log.raw('');

  if (cfg.current && cfg.namespaces[cfg.current]) {
    const e = cfg.namespaces[cfg.current];
    const installedCount = groups.get(cfg.current)?.size ?? 0;
    log.raw(
      `  ${color.dim('namespace')}  ${color.bold(cfg.current)} ${color.dim(`(${e.url})`)}`,
    );
    log.raw(
      `  ${color.dim('           ')}  ${color.dim(`${e.ref || '-'} @ ${shortSha(e.commit) || '-'}   ${e.skills?.length ?? 0} available, ${installedCount} installed`)}`,
    );
  } else {
    log.raw(`  ${color.dim('namespace')}  ${color.yellow('none')}`);
  }

  log.raw(`  ${color.dim('scope')}      ${target.scope}`);
  log.raw(`  ${color.dim('dir')}        ${target.root}`);
  log.raw(`  ${color.dim('installed')}  ${Object.keys(lock.skills).length}`);

  const names = namespaceNames(cfg);
  if (names.length) {
    log.raw(
      `  ${color.dim('all ns')}     ${names.map((n) => (n === cfg.current ? color.green(`${n}*`) : n)).join(', ')}`,
    );
  }

  log.raw('');
  log.raw(color.cyan('  skm ls') + color.dim('            list skills in current namespace'));
  log.raw(color.cyan('  skm install <skill>') + color.dim('  install     ') + color.cyan('skm install --all') + color.dim('  install everything'));
  log.raw(color.cyan('  skm update') + color.dim('         fetch updates   ') + color.cyan('skm rm <skill>') + color.dim('  uninstall'));
  log.raw(color.cyan('  skm ns ls') + color.dim('         namespaces      ') + color.cyan('skm ns use <n>') + color.dim('  switch'));
  log.raw(color.dim('\n  need details: skm help'));
}

function printHelp() {
  log.raw(`skm ${VERSION} - namespace-based skill manager (each namespace = one git repo)

${color.bold('USAGE')}
  skm <command> [args] [flags]

${color.bold('NAMESPACE')}
  skm ns add <url>          add a namespace (name auto-derived from repo)
  skm ns add <name> <url>   add with an explicit name
  skm ns ls                 list namespaces (* = current)
  skm ns use <name>         switch current namespace
  skm ns rm <name>          remove a namespace [--purge to drop cache]
  skm ns info [name]        namespace details
  skm ns rename <a> <b>     rename a namespace
  skm ns set-url <n> <url>  change the git address of a namespace
  skm ns fetch [name]       refresh a namespace (git fetch only)

${color.bold('GIT ADDRESS  (ns add / ns set-url)')}
  owner/repo                -> https://github.com/owner/repo.git   (GitHub assumed)
  https://host/group/repo.git                                      (any host/scheme)
  git@host:group/repo.git                                          (ssh)
  /abs, ./rel, ~/path                                              (local repository)
  --ref <ref>               pin to a branch / tag / commit   (ns add only)
  No name given? it is the last path segment: .../hyperframes.git -> hyperframes
  For gitlab/self-hosted always give the full URL (owner/repo only expands to GitHub).
  Private repos use your normal git credentials (ssh-agent / credential helper).
  skm reuses one ssh connection per run (ControlPersist=10m), so a passphrase is
  asked once per push, not twice. SKM_NO_SSH_MUX=1 disables it.

${color.bold('SKILLS (in the current namespace)')}
  skm ls                    list skills, marking installed ones   [-v for descriptions]
  skm ls --installed        list what is installed here
  skm ls --all-ns           list skills across all namespaces
  skm install <skill...>    install skill(s)        [--force] [--name <alias>]
                            target another namespace with  ns:skill  or  -n <ns>
  skm install --all         install every skill in the namespace
  skm rm <skill...>         uninstall skill(s)      [--verify]
  skm rm --all              uninstall all of the current namespace
  skm rm --all-ns           uninstall everything in this dir
  skm update                git fetch + show what changed upstream
  skm update --installed    fetch and reinstall all installed skills
  skm update <skill...>     fetch and reinstall these skills
  skm info <skill>          details (namespace, source, local modifications)
  skm push [<skill|dir>]    publish a local skill into the current namespace
                            commits and pushes it   [--path <dir>] [--branch <b>] [-m <msg>]
                            --local       commit in the cache repo only, do not push

${color.bold('TARGET (where skills get installed)')}
  (default)   ./<skill-name>/        (current working directory, one folder per skill)
  -g          ~/.agents/skills      (+ symlinks into ~/.codebuddy/skills)
  --dir PATH  an explicit skills dir

${color.bold('FLAGS')}
  -n, --ns <name>   run against another namespace without switching
  --ref <ref>       pin namespace to branch/tag/commit (with ns add)
  -g, --global      operate on the global skills dir
  --link/--no-link  control symlinks in sibling agent dirs
  --json            machine-readable output (ls / ns ls / info)
  --force, -f       overwrite existing
  --refresh         alias of default behavior: fetch latest before install
  --offline, --no-fetch   skip the git fetch and use the local cache only

${color.bold('SHORTCUTS')}
  ns:skill syntax works anywhere, e.g.
    skm install hyperframes:hyperframes-core
    skm info hyperframes:media-use

${color.bold('EXAMPLES')}
  skm ns add heygen-com/hyperframes
  skm ns add vercel-labs/skills
  skm ns use hyperframes
  skm ls -v
  skm install hyperframes-core media-use
  skm ns use vercel && skm ls
  skm rm hyperframes-core
  skm update --installed
`);
}

function printVersion() {
  log.raw(VERSION);
}

/* ------------------------------------------------------------------ main */

export async function main(argv) {
  // Flags may appear before the command (`skm -n repo info x`) so parse once up-front.
  const parsed = parseArgs(argv);
  const [rawCommand, ...rest] = parsed.positional;
  const ctx = { positional: rest, flags: parsed.flags, cwd: process.cwd() };

  if (!rawCommand) {
    if (truthy(ctx.flags, 'help', 'h')) {
      printHelp();
      return;
    }
    if (truthy(ctx.flags, 'version', 'v')) {
      printVersion();
      return;
    }
    const cfg = await loadConfig();
    const target = resolveTarget(ctx);
    const lock = await loadLock(target.root);
    printDashboard(cfg, target, lock);
    return;
  }

  const command = rawCommand.toLowerCase();
  if (command === 'help' || command === '-h' || command === '--help') {
    printHelp();
    return;
  }
  if (command === 'version' || command === '-v' || command === '--version') {
    printVersion();
    return;
  }

  const resolved = ALIASES[command];
  if (!resolved) {
    log.err(`unknown command: ${rawCommand}`);
    log.raw(color.dim('run "skm help" for usage, or "skm" for a dashboard'));
    process.exit(1);
  }

  // `-h` / `--help` as a trailing flag on any command shows the full help too,
  // so `skm install -h` / `skm update -h` behave like `skm -h`.
  if (truthy(ctx.flags, 'help', 'h')) {
    printHelp();
    return;
  }

  switch (resolved) {
    case 'ns':
      return cmdNs(rest[0] || null, { ...ctx, positional: rest.slice(1) });
    case 'ls':
      return cmdLs(ctx);
    case 'install':
      return cmdAdd(ctx);
    case 'rm':
      return cmdRm(ctx);
    case 'update':
      return cmdGet(ctx);
    case 'info':
      return cmdInfo(ctx);
    case 'push':
      return cmdPush(ctx);
    default:
      fail(`unhandled command: ${resolved}`);
  }
}
