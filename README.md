# skm — 基于命名空间的 skill 管理器

`skm` 用**命名空间**管理 skill：**一个命名空间 = 一个 git 仓库**；skill 就是仓库里含 `SKILL.md` 的目录。装好后 `skm` 是个普通命令，可在**任意文件夹**下执行。

> 设计目标：**保证有用 + 最少化**。没有第三方依赖，零构建，纯 Node + 系统 git。

---

## 安装

### 方式一：从源码（当前即可用）

```bash
git clone git@github.com:yangzc/skill-cli.git
cd skill-cli
npm install          # 零依赖，瞬间完成
npm link            # 软链出全局 skm 命令
skm --help
```

不想装全局命令，也可以每次直接 `node bin/skm.js <命令>`。

**前置条件**：Node ≥ 18、系统已装 `git`（skm 全程走系统 git）。

### 方式二：通过 npm（发布后）

```bash
npm install -g skm      # 全局命令
npx skm <命令>          # 免安装即用
```

> 包名若改为作用域包（如 `@yangzc/skm`），安装命令相应变为 `npm install -g @yangzc/skm`，但命令名仍是 `skm`（由 `bin` 字段决定）。

---

## 快速开始

```bash
skm ns add skills-repo https://github.com/owner/skills-repo.git   # 注册命名空间（clone 缓存到 ~/.cache/skm）
skm ns use skills-repo            # 设为「当前命名空间」（可选）
skm ls -v                        # 列出该命名空间全部 skill（含描述）
skm install some-skill           # 拉取最新并安装到 ./some-skill/
skm update --installed           # 拉上游更新并重装已装的
```

---

## 核心概念

| 概念 | 说明 |
|---|---|
| **命名空间** | 一个 git 仓库。名字默认从地址末段推导（`https://github.com/heygen-com/hyperframes.git` → `hyperframes`） |
| **当前命名空间** | 全局存一份，`skm ls` / `install` / `rm` / `update` 默认作用于它 |
| **仓库缓存** | 每个命名空间一份工作副本：`~/.cache/skm/repos/<名字>/` |
| **目标目录（scope）** | skill 实际装到哪：默认 `./<skill-name>/`（当前工作目录，每 skill 一目录）、全局 `~/.agents/skills`，或 `--dir` |
| **lock** | 目标目录下的 `.skm-lock.json`，记录每个 skill 来自哪个命名空间 / 哪个 commit |

```
命名空间 hyperframes ──clone──► ~/.cache/skm/repos/hyperframes/   (git 工作副本)
                                        │
                              发现所有含 SKILL.md 的目录
                                        │
                                        ├──► <目标目录>/<skill>/        真实安装目录
                                        └──► <目标目录>/.skm-lock.json  来源 / commit / 指纹
```

---

## 命令

### 命名空间 `skm ns <subcommand>`

| 命令 | 说明 |
|---|---|
| `skm ns add <name> <git-url>` | 指定名字新建（推荐，避免歧义） |
| `skm ns add <git-url>` | 省略名字，名字从地址末段推导；第一个命名空间自动成为当前 |
| `skm ns ls` | 列出所有命名空间，`*` 标记当前 |
| `skm ns use <name>` | 切换当前命名空间 |
| `skm ns rm <name> [--purge]` | 删除命名空间（`--purge` 同时删仓库缓存） |
| `skm ns info [name]` | 详情：url / ref / commit / 缓存路径 / 可装数 / 已装数 |
| `skm ns rename <a> <b>` | 改名（连带缓存目录） |
| `skm ns set-url <n> <url>` | 改该命名空间的 git 地址（同时把缓存仓库的 origin 重指过去） |
| `skm ns fetch [name]` | 只做 `git fetch`，不安装 |

### skill 管理 `skm install` / `ls` / `rm` / `update` / `info`

| 命令 | 说明 |
|---|---|
| `skm ls` | 查：列出当前命名空间所有 skill，标记哪些已装（`-v` 显示描述） |
| `skm ls --installed` | 列出本目标目录里已安装的，带命名空间 / commit / 时间 |
| `skm ls --all-ns` | 跨所有命名空间列出 |
| `skm install <skill...>` | **增**：安装（默认先拉最新；支持前缀模糊匹配） |
| `skm install --all` | 装当前命名空间全部 skill |
| `skm rm <skill...>` | 删：卸载（`--verify` 检查本地改动） |
| `skm rm --all` | 卸载当前命名空间的全部 |
| `skm rm --all-ns` | 卸载本目标目录里的全部 |
| `skm update` | 获取：拉上游并报告变化（新增 / 删除 / 改动） |
| `skm update --installed` | 获取并重装本命名空间所有已装 skill |
| `skm update <skill...>` | 获取并重装指定 skill |
| `skm info <skill>` | 详情：所属命名空间、来源、repo 内路径、是否被本地改过 |

### 不切换命名空间也能指定

全局 flag `-n, --ns <name>` 可临时指向别的命名空间，对所有命令生效：

```bash
skm -n hyperframes ls
skm info vercel:find-skills
```

装某个非当前命名空间下的 skill，三种等价写法：

```bash
skm ns use main && skm install media-use   # 先切过去
skm install main:media-use                 # ns:skill 内联
skm install media-use -n main              # -n / --ns / --namespace
```

- 名字支持**唯一前缀模糊匹配**：`skm install media` 命中 `media-use` 就直接装；命中多个会列出候选并报错
- 也可给 repo 内相对路径：`skm install hyperframes:skills/media-use`
- `--name <别名>`（或 `--as <别名>`）装成另一个目录名（仅限单个 skill）：`skm install media-use -n hyperframes --name mua`
- 在别的命名空间里找不到时会给提示：`found in other namespace(s): hyperframes: media-use ...`
- 不带参数只预览：`skm install` 会列出当前命名空间的可装 skill 然后退出

### 把本地 skill 提交回命名空间 `skm push`

`add` 是「仓库 → 本地」，`push` 是反方向「本地 → 仓库」，用来把本地改过的 skill 同步回它来的地方。

```bash
skm push a1                                   # 提交当前目录里已安装的 a1，并推上去
skm push ./my-skill --path skills/my-skill    # 任意目录，指定 repo 内位置
skm push a1 --local                           # 只提交到缓存仓库，先 review 再推
```

| 参数 | 说明 |
|---|---|
| `--path <dir>` | repo 内目标位置；省略时优先用它原来的 `skillPath`（装回来的就回到原位），否则 `skills/<name>` |
| `--branch <b>` | 提交到哪个分支；省略时用命名空间 ref（若确实是分支），否则 origin 默认分支 |
| `-m, --message <msg>` | 提交信息，默认 `chore: sync <name>` |
| `--local` | 只提交、不推送（别名 `--no-push` / `--commit-only`） |
| `--dry-run` | 只打印计划，不写任何东西 |
| `--force` | 允许覆盖目标位置上的**另一个** skill |

行为要点：

- **默认 commit + push**。想先看 diff 再推就用 `--local`，之后直接再跑一次不带 `--local` 的 `skm push <skill>` 即可（空改动时会只推送积压的提交）
- 会在缓存仓库里建/切到**真实分支**（缓存平时是 detached HEAD）。已有本地分支是**复用而不是重置**，所以多次 `--local` 不会丢提交，最后一次推送会把积压的一起推上去
- 目标位置已有**同名** skill → 视为同步直接覆盖（含删掉本地已删除的文件）；已有**别的** skill → 拒绝，需 `--path` 换位置或 `--force`
- 如果推的正是当前目录已安装的 skill，会顺带刷新 lock 里的 `commit` / `folderHash`，之后 `skm info` 不再显示 `modified: yes`
- 命名空间被 `--ref` 钉在 tag/commit 上时会警告，并把提交落到 origin 的默认分支
- **远端是空仓库也能引导**：刚在 GitHub 建好的 repo 没有任何 ref，`skm ns add` 会提示 `repository is empty`，随后 `skm push <skill>` 会直接建出分支并推上第一个 commit（默认用 clone 时的 HEAD 分支名，可用 `--branch` 指定）
- 找不到源目录时会列出附近候选：`nearby folders: skills/h5-ppt-generator`

### Git 地址写法

`<url>` 接受以下写法，会在写入配置前归一化：

| 你写的 | 归一化为 | 命名空间名 |
|---|---|---|
| `https://github.com/a/b.git` | 原样 | `b` |
| `https://gitlab.com/group/sub/repo.git` | 原样 | `repo` |
| `git@github.com:owner/repo.git` | 原样（ssh） | `repo` |
| `git://host/a/b.git` / `ssh://git@host/a/b.git` | 原样 | `b` |
| `file:///tmp/x` | 原样 | `x` |
| `/abs/path` `./rel` `../rel` `~/path` | 转成绝对路径 | `path` |

- 推荐显式写法：`skm ns add <name> <git-url>`（例：`skm ns add main https://github.com/heygen-com/hyperframes.git`），名字只允许字母、数字、`.`、`_`、`-`
- 不写名字时，取地址最后一段并去掉 `.git`、转小写作为名字：`.../hyperframes.git` → `hyperframes`
- 同一名字想换地址：`skm ns set-url <name> <url>`，或 `skm ns add <name> <url> --force`
- 钉版本：`skm ns add <name> <url> --ref v1.2.0`（branch / tag / commit 都行），之后 `skm ns set-url` 或 `ns add` 会清掉该钉定
- 私有仓库依赖**你系统 git 的凭据**（ssh-agent、credential helper、或直接把 token 写进 URL）。`skm` 自己**不存凭据**；把 token 写进 URL 会被明文记进 `config.json`，不推荐
- 换了地址后，之前装的 skill 仍记着旧的 `skillPath`，`skm update --installed` 会提示 `not in namespace anymore`

---

## 目标目录（scope）

| 方式 | 位置 |
|---|---|
| 默认 | 当前工作目录，每个 skill 一个文件夹：`./<skill-name>/`（agent 不会自动扫描到；如需被发现可加 `--link` 同步进 `.codebuddy/skills` 等） |
| `-g, --global` | `~/.agents/skills`，并默认在 `~/.codebuddy/skills/` 建 symlink（与 CodeBuddy 现有布局一致） |
| `--dir PATH` | 完全自定义 |

`--link` / `--no-link` 可显式控制是否建 symlink。

---

## 通用参数（Flags）

| 参数 | 说明 |
|---|---|
| `-n, --ns <name>` | 临时指定命名空间（对所有命令生效） |
| `--ref <ref>` | 建命名空间时钉住 branch / tag / commit |
| `-g, --global` | 操作全局目标目录 |
| `--dir <path>` | 指定目标目录 |
| `-f, --force` | 覆盖已存在 |
| `--name <别名>`, `--as <别名>` | 安装时重命名（单个 skill） |
| `--offline`, `--no-fetch` | 跳过 `git fetch`，只用本地缓存（离线安装） |
| `--json` | 机器可读输出（`ls` / `ns ls` / `info`） |
| `-v, --verbose` | 显示描述 |

> 安装默认**会先 `git fetch` 最新**，`--offline` / `--no-fetch` 用于离线。

---

## 典型工作流

```bash
# 1. 接入两个仓库
skm ns add main https://github.com/heygen-com/hyperframes.git
skm ns add vercel https://github.com/vercel-labs/skills.git

# 2. 看看有什么
skm ns ls
skm ls -v

# 3. 安装到当前工作目录（每个 skill 一个文件夹：./<skill-name>/）
skm install --all
skm ls --installed

# 4. 切到另一个仓库操作
skm ns use vercel
skm ls
skm install find-skills

# 5. 上游有更新
skm update              # 先看看变了什么
skm update --installed  # 再重装

# 6. 装到全局并自动建 symlink
skm install --all -g

# 7. 清理
skm rm --all-ns
skm ns rm vercel --purge
```

---

## 关于 SSH 口令

`skm` 完全走系统 git，私有仓库用你的 ssh key。

**`skm push` 默认只问一次口令。** 一次 push 有两次网络操作（先 fetch 再 push），本来会问两次；`skm` 会给 git 注入一个 ssh 连接复用命令，两条操作走同一条连接，且进程退出后保留 10 分钟：

```
GIT_SSH_COMMAND=ssh -o ControlMaster=auto -o ControlPath=<cache>/ssh/cm-%C -o ControlPersist=10m
```

- `%C` 是「本机 + 目标主机 + 端口 + 用户名」的哈希，**每个远端各自一个 socket**，互不干扰
- `ControlPersist=10m` 内的后续 push（乃至 `ls` / `update`）**完全不再问口令**
- 想改保留时长：`SKM_SSH_PERSIST=1h`
- 想关掉：`SKM_NO_SSH_MUX=1`；你已自行设置 `GIT_SSH_COMMAND` / `GIT_SSH` 时 `skm` 也会**自动让路**，绝不覆盖
- socket 放在 `~/.cache/skm/ssh/`（权限 `0700`）；目录不可写时静默退回原行为

彻底不问口令的办法还是把它加进 ssh-agent：

```bash
ssh-add --apple-use-keychain ~/.ssh/id_rsa        # macOS
eval "$(ssh-agent -s)" && ssh-add ~/.ssh/id_rsa   # Linux
```

第一次 `skm push` 时如果检测到 agent 里没有 key，会打印一次这样的提示，之后不再重复（记在 `config.json` 的 `hints.sshKey`）。

> 直接用系统 ssh 的人也可以把上面的 `ControlMaster` / `ControlPath` / `ControlPersist` 三行写进 `~/.ssh/config`，效果一样。

---

## 文件布局

```
~/.config/skm/config.json        # 命名空间注册表 + 当前命名空间
~/.cache/skm/repos/<ns>/         # 每个命名空间的 git 工作副本
<目标目录>/.skm-lock.json         # 该目标目录已安装 skill 的来源与指纹
```

`config.json` 示例：

```json
{
  "version": 2,
  "current": "hyperframes",
  "namespaces": {
    "hyperframes": {
      "url": "https://github.com/heygen-com/hyperframes.git",
      "ref": "main",
      "commit": "abc1234...",
      "createdAt": "2026-09-23T06:00:00.000Z",
      "updatedAt": "2026-09-23T06:00:00.000Z",
      "lastFetchedAt": "2026-09-23T06:10:00.000Z",
      "skills": ["hyperframes", "hyperframes-core", "..."]
    }
  }
}
```

可用环境变量重定位：`SKM_HOME`（配置）、`SKM_CACHE_HOME`（缓存），也遵循 `XDG_CONFIG_HOME` / `XDG_CACHE_HOME`。

---

## 源码结构

```
skill-cli/
├── bin/skm.js        # 入口：EPIPE 保护 + 错误收敛
└── src/
    ├── commands.js   # 命令解析与全部子命令（ns / ls / install / rm / update / info / push）
    ├── config.js     # 命名空间注册表（config.json）、缓存目录
    ├── store.js      # 目标目录（scope）+ lock 读写
    ├── skills.js     # 递归发现 SKILL.md、扫描已安装、文件计数
    ├── git.js        # 来源归一化、clone/fetch/checkout、commit 与 diff
    └── util.js       # 颜色输出、ANSI 感知表格、目录拷贝与内容指纹、frontmatter
```
