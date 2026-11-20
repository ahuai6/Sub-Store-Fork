# 持续同步、发布与运维手册

本文是 `AGENTS.md` 的操作手册，覆盖 CI/CD 工作流、仓库安全权限、三条上游基线的同步与冲突处理流程、必须保留的 fork 修改核对表、本地/CI 验证方法及线上验收步骤。

全局约束见 [AGENTS.md](../AGENTS.md)，前后端入口与运行行为见[架构文档](architecture.md)，历史变更与实测记录见[维护日志](maintenance-log.md)。日常开发可直接跳到[本地验证](#local-checks)和[线上验收](#verify-deployment)。

---

## 1. CI/CD 工作流与排程总览

全部 CI、发布、前端部署与上游同步均在本仓库运行，仅使用工作流自带的 `GITHUB_TOKEN`。**严禁重新引入已删除的 `ahuai6/Sub-Store-Fork-Dist`、`FORK_REPO_TOKEN` 或 `PUBLIC_DIST_TOKEN`**。

GitHub cron 使用 UTC；台北/北京时间 = UTC+8（无夏令时）。

| 工作流 | 触发条件 | 职责与跳过逻辑 |
| --- | --- | --- |
| `.github/workflows/ci.yml` | `push` 到 `main`、`pull_request`、`workflow_dispatch` | 调用 `run_fork_publish_checks.sh` 执行完整检查，不发布 |
| `.github/workflows/sync-upstream.yml` | 每天 `17 4 * * *`（12:17 UTC+8）+ `workflow_dispatch` | 快进 `upstream`、镜像新 tag、合入 `main`、校验并直推或开 PR；末尾非阻塞检查 `xream/scripts` `geo.js` 漂移 |
| `.github/workflows/publish-frontend.yml` | 每天 `23 5 * * *`（13:23 UTC+8）+ `workflow_dispatch`（可选 `force=true`） | 对比 `gh-pages` `frontend-version.txt` 的 `sha`/`base`/`api`/`patches`，有变化即拉上游前端 → 补丁 → 构建 → 推 `gh-pages` |
| `.github/workflows/publish-dist.yml` | 每 3 小时 `47 */3 * * *`（UTC+8: 02:47/05:47/08:47/11:47/14:47/17:47/20:47/23:47）+ `workflow_dispatch` | schedule 仅在 `HEAD != 最新 Release Built from` 时构建；`workflow_dispatch` 总是构建并用 `gh release upload --clobber` 原地更新同 version tag 的资产 |
| `.github/workflows/main.yml` / `star-history.yml` | **上游原文件** | **不要修改，也不要手动运行 `main.yml`**（`main.yml` 会 force-push `release` 分支） |

### 仓库安全与权限基线

- 写权限仅仓库所有者一人；已开启 secret scanning 与 push protection；**仓库保持关闭 GitHub Issues**（所有异常与漂移报告写 Actions Job Summary 或 PR）。
- `main` 规则集禁止 force-push 与删分支，但**允许不经 PR 直推 `main`**（否则 `sync-upstream` 无法在检查通过后直推 `main`）。
- 来自 fork 的 PR 工作流需批准后运行；Actions → General → Workflow permissions 必须为 **Read and write**。
- 提交身份固定：`117343258+ahuai6@users.noreply.github.com`。

| 工作流权限 | 用途 |
| --- | --- |
| `contents: write` | 推 `main`、`upstream`、镜像 tag、同步 PR 分支、`gh-pages` 及创建/更新 Release |
| `pull-requests: write` | `sync-upstream` 创建、评论、自动关闭 `sync/upstream` 与 `sync/tests-failed` PR |
| `actions: write` | `sync-upstream` 在必要时 dispatch `publish-dist.yml` |

---

## 2. 三上游协同同步策略

| 上游 | 监测/同步机制 | 正常路径 | 冲突 / 失败 / 漂移处理 | 人工介入动作 |
| --- | --- | --- | --- | --- |
| **后端** `sub-store-org/Sub-Store` (`master`) | `sync-upstream.yml`（每日 04:17 UTC） | 快进 `upstream` → `git merge upstream/master` → 重套 URL/CORS → 检查运行时标记 → 刷新模块 → 跑 `run_fork_publish_checks.sh` → 直推 `main` | 冲突推 `sync/upstream` 开 PR；检查失败推 `sync/tests-failed` 开 PR；分支无法快进/锚点缺失/无冲突索引失败时写 **Job Summary** 并报错中止（不推 `main`、不强推） | 按第 3 节解冲突，**必须用 Create a merge commit 合入 `main`**，必要时手动 Run `publish-dist.yml` |
| **前端** `sub-store-org/Sub-Store-Front-End` | `publish-frontend.yml`（每日 05:23 UTC） | `resolve_frontend_ref.sh` 选最新 release（若 `master` 领先则用 `master`）→ 校验 `frontend-version.txt` → `prepare_frontend_pages.py --patch` → `pnpm build` → `--finalize-site` → 推 `gh-pages` | 任意补丁锚点消失、`vue-tsc` 报错或 `check_dist`（含 `sw.js` `autoUpdate` / 子路径扫描）失败时直接中止，不覆盖 `gh-pages` | 浅拉最新前端源码排查新锚点，更新 `prepare_frontend_pages.py` / `forkRequestGuard.ts` 并递增 `PATCH_STAMP`，推 `main` 后手动 Run `publish-frontend.yml` |
| **`geo.js`** `xream/scripts` (`check/geo.js`) | `sync-upstream.yml` 末尾 `check_geo_upstream.py`（`if: always()` + `continue-on-error: true`） | 比对上游 `geo.js` blob SHA 与 `scripts/check/GEO-NOTICE.md` 记录值，一致则静默通过 | 漂移时输出 `::notice::` 并追加 Markdown 差异报告至 **Job Summary**，不阻塞后端同步 | 对比 `xream/scripts` 与 `backend/src/test/fixtures/geo.upstream.js` 的 diff，按需移植到 `scripts/check/geo.js`，同步更新 `geo.upstream.js`、修订号与 blob SHA（`GEO-NOTICE.md`）并跑 `geo-optimized.spec.js` |

> 注意：`GITHUB_TOKEN` 推送的提交不会再次触发 `push` 事件工作流。因此 `sync-upstream.yml` 在直推 `main` 后，仅当 `backend/package.json` 变化、重套了 redirect/CORS 补丁或刷新了 `dist/Surge-Beta.sgmodule` 时才主动 dispatch `publish-dist.yml`；其他 `main` 提交等待 `publish-dist` 3 小时排程按 SHA 差异自动发布。

---

## 3. 上游同步 PR 与冲突解决手册

### 3.1 为什么同步 PR 必须使用 Merge Commit

`sync-upstream.yml` 依赖 Git 提交图判断 `upstream/master` 是否已是 `main` 的祖先。如果同步 PR 被 squash 或 rebase，文件内容虽已合入，但上游提交不再是 `main` 的父提交，下一次每日同步会**在完全相同的文件上再次冲突**（历史案例见 `docs/maintenance-log.md` PR #13–#16）。

- **铁律**：`sync/*` 或任何包含上游提交的 PR，一律使用 GitHub 的 **Create a merge commit**；**禁止 squash，禁止 rebase**。
- **补救办法**：先比较目标上游提交范围、原 PR diff 和当前 `origin/main`，确认该范围内的实际改动已完整进入 `main`。确认后，从 `origin/main` 建修复分支，执行 `git merge -s ours --no-ff <upstream-sha>` 记录祖先关系。用 `git diff HEAD^1 HEAD` 确认树内容未变，通过检查后以 **Create a merge commit** 合入 `main`。如果上游改动还有遗漏，用正常合并补齐。`-s ours` 会保留当前文件树，跳过的上游内容也会被后续同步视为已合入。
- **防误合并**：不要直接合并 head 仍为未改动上游提交的 `sync/upstream` PR，必须先在分支上解完冲突并验证通过。

### 3.2 高频冲突文件标准解法

| 文件 | 标准解决策略 |
| --- | --- |
| `backend/src/restful/miscs.js` | 保留非 Node `/` 302 到 `https://ahuai6.github.io/Sub-Store-Fork/`；保留上游的 `DEFAULT_FRONTEND_URL`（`https://sub.xream.eu.org`）引导文案；保留 `/api/utils/refresh` 中 `outputCache`/`checkResultCache`/`lastGoodCache` 的 `revokeAll()` 调用 |
| `backend/src/utils/cors.js` | 完整采纳上游新增的所有默认 origin，并确保 `https://ahuai6.github.io` 保留在 `NON_NODE_CORS_DEFAULT`（`NODE_CORS_DEFAULT` 同步） |
| `backend/src/test/vendor/express-cors.spec.js` | 测试断言继续引用 `NON_NODE_CORS_DEFAULT`，不要硬编码旧 origin 列表 |
| `backend/src/core/proxy-utils/parsers/peggy/surge.js`（及 `loon.js`/`qx.js`） | 完整采纳上游新增的语法规则与 helper，同时保留 fork 头部注释 `fork: peggy parsers are precompiled`、`export const grammars = String.raw\`...\``、`import compiledParser from './generated/....js'` 及 `getParser()` 传参（如 `setSurgeXhttpOption`），**绝不写回 `peggy.generate`**；解完后运行 `precompile-peggy.js` 重新生成 |
| `backend/src/utils/download.js`、`restful/sync.js`、`restful/preview.js` | 采纳上游新参数/错误处理，同时保留 `deferPreprocess`、`returnParsed`、`parseRawProxyEntries`、流量头默认键回填、`outputCache` 读写与 `inflight` 去重 |
| `config/Surge-Beta.sgmodule` | **完全接受上游版本**（theirs），然后重新运行 `render_surge_beta_module.py --check --output dist/Surge-Beta.sgmodule` 更新已提交的 `dist/Surge-Beta.sgmodule`；若上游改动了锚点（如 `UPSTREAM_CORE_PATTERN`、`UPSTREAM_CORS_ORIGINS`、`UPSTREAM_SYNC_DEFAULT`），对应更新 `render_surge_beta_module.py` 并确认 `--check` 仍能逐字节还原 |
| `backend/package.json` / `pnpm-lock.yaml` | 采纳上游版本与依赖；保留 `bench` 脚本与 `pre*` 中的 `precompile-peggy.js` 钩子；检查 `dedupeNoblePlugin` 在 `pnpm bundle:esbuild` 下仍通过 `assertNobleDeduplicated()` |

### 3.3 收到同步 PR 后的标准 7 步流程

1. 查看上游提交范围、冲突文件列表、`backend/package.json` 版本号与 CI 日志。
2. 逐文件按 3.2 表解决冲突，使用普通 merge commit 保留双父提交。
3. 运行锚点重套与保护检查：
   ```bash
   node .github/scripts/apply-fork-frontend.mjs
   node .github/scripts/apply-fork-runtime.mjs --check
   ```
   若 `apply-fork-runtime.mjs --check` 报缺失标记，说明上游重写了对应文件，需人工将对应 fork 语义移植回新结构。
4. 按第 5 节跑全量 `pnpm test`（含 golden snapshots）、Python 单测、`pnpm bundle:esbuild` 及模块渲染校验（如 `config/Surge-Beta.sgmodule` 有变化，重新生成并提交 `dist/Surge-Beta.sgmodule`）。性能相关改动同步跑 `pnpm bench`。
5. 更新 `docs/maintenance-log.md`（若涉及架构/锚点变化，同步更新 `docs/architecture.md`、`AGENTS.md`）。
6. 确认 `ci.yml` 全绿，以 **Create a merge commit** 合入 `main`（保留分支）。
7. 需要立即上线时手动触发 `publish-dist.yml`（前端有改动时触发 `publish-frontend.yml`），按第 6 节完成线上验收并提醒用户 Surge 端按需刷新资源/模块。

---

## 4. 必须保留的 Fork 修改核对表

下表与 `.github/scripts/apply-fork-runtime.mjs` 及 `apply-fork-frontend.mjs` 一一对应：

| 区域 | 必须保留的行为与保护标记 |
| --- | --- |
| 页面与 CORS | 非 Node `/` 302 → `https://ahuai6.github.io/Sub-Store-Fork/`；默认 origin 含 `https://ahuai6.github.io`（`apply-fork-frontend.mjs`） |
| 前端 Pages 补丁 | 子路径 `/Sub-Store-Fork/`（含 `/preview`、流量页、关于页、复制链接）、PWA `autoUpdate`（`skipWaiting` + `clientsClaim`）、3 级优先级 2 槽队列（后台挂起 `/api/sub/flow`、`FilePreview` 走 `queuedPreviewGet`）、刷新防重型预览、API `preconnect` 与 `.compare-table-row` `content-visibility:auto` |
| 请求去重 | `inflight.js` 同 realm 共享 preview/download/node-info；不加持久锁，不宣称跨 Surge 会话 |
| 下载与输出缓存 | `resourceCacheTtl`、noCache/noOutputCache、子订阅 `noCache` 隔离、`preview-file` 元数据键；`deferPreprocess` + `returnParsed` 消除重复解析；`OMITTED_SETTINGS` + `digestLargeString`；命中后仍执行响应转换与 age 加密 |
| 流量头与检测缓存 | `headersCacheTtl` / `scriptCacheTtl` 各自遵循全局 TTL（0 禁用读写，缩短即生效）；`download.js` 回填 `defaultFlowUserAgent + originalUrl`；`CheckResultCache` 批量写入 |
| 存储与分片 | `resource`、`script-resource`、`output`、`check`、`last-good` 接入 `CacheShards`（64 KiB 阈值、3 MiB UTF-8 上限、兼容旧布局、单键懒读与分片增量更新）。新增或删除键仍需重写清单。`revokeAll()` 清全部分片。Node 按文件写 store，Surge 主文档紧凑存储，备份恢复时同步迁移 |
| `geo.js` Operator | 兼容原参数/模板；20 并发上限、同步缓存预扫描、`time_budget`（880 s 安全上限）、`two_phase`、`dedup_target`、`keep_last` / `keep_last_max_age`（全局 TTL 唯一例外，刷新清除、不加标记）、`prioritize_stale` 轮换调度、单行汇总日志；随 `GEO-LICENSE.txt` 与 `GEO-NOTICE.md` 发布，每日非阻塞监测 `xream/scripts` 漂移 |
| 编译、瘦身与冷启动 | `getFlag` 单次编译，Peggy 预编译并保留语法源，保留三个瘦身插件及构建断言。证书指纹走轻量实现，运行时无需导入 `jsrsasign`（上游依赖声明仍在）。保留全部生产者、解析器和 lodash 源码 |
| 路由、容错与日志 | 纯文件元数据路由（`file-metadata.js`，注册零写入）在 `sub-store-0`（无 `ProxyUtils`）；`/api/file/:name`、`/share/file/:name` 与完整 `file.js` 兼容路由在 `sub-store-1`；`subscriptions.js` 缺失订阅返回 404；`express.js` 非 Node 容错加固（400 非法 JSON、Promise 拒绝捕获、大小写无关 header、安全 query 解析）；`SURGE_ONLY` 批量日志落盘 |
| 模块渲染与发布 | `config/Surge-Beta.sgmodule` 原样不动；`render_surge_beta_module.py --check` 可逆生成 `dist/Surge-Beta.sgmodule`，三个定时任务默认 `#` 关闭且 prefetch 参数全有默认值；Release 仅上传明确资产列表，无 `upload-artifact` |

---

<a name="local-checks"></a>

## 5. 本地与 CI 验证

### Linux / macOS / WSL

在干净的本仓库检出中，从仓库根目录执行。Node 版本见 `.node-version`，pnpm 由 `backend/package.json` 的 `packageManager` 钉住。需要 Corepack、Python 3、Git 和 curl。

```bash
bash .github/scripts/run_fork_publish_checks.sh "$PWD"
```

这与 Linux CI 使用同一入口，依次检查 fork 锚点和运行时标记、安装锁定依赖、拉取最新 mihomo 版本、跑后端 Mocha 和 golden snapshots、跑 Python 回归、构建产物、渲染并逐字节比对模块。它会修改 `backend/src/utils/download.js` 和 `backend/src/utils/flow.js` 的 mihomo 版本字符串，并重建 `public-dist/`。在临时克隆或专用检出里执行，避免把验证产生的版本更新混进业务提交。

后端性能改动额外在 `backend/` 执行 `corepack pnpm bench`，用 `backend/bench/baseline.json` 对照。该基准使用 Node/V8。`geo.js` 上游漂移可从根目录用 `python3 .github/scripts/check_geo_upstream.py` 检查。

<a name="windows-checks"></a>

### Windows PowerShell

以下第一段从仓库根目录执行。`PYTHONIOENCODING` 也适用于 Mocha 启动的渲染器子进程，避免重定向输出时出现 GBK 编码错误。

```powershell
$env:PYTHONIOENCODING = 'utf-8'
node .github/scripts/apply-fork-frontend.mjs --check
if ($LASTEXITCODE) { throw '重定向或 CORS 补丁检查失败' }
node .github/scripts/apply-fork-runtime.mjs --check
if ($LASTEXITCODE) { throw '运行时保护检查失败' }
python -m unittest discover -s .github/scripts -p 'test_*.py' -v
if ($LASTEXITCODE) { throw 'Python 回归失败' }

$moduleFile = New-TemporaryFile
try {
    python .github/scripts/render_surge_beta_module.py --check --public-repo ahuai6/Sub-Store-Fork --output $moduleFile.FullName
    if ($LASTEXITCODE) { throw '模块渲染失败' }
    if ((Get-FileHash $moduleFile.FullName).Hash -ne (Get-FileHash 'dist/Surge-Beta.sgmodule').Hash) {
        throw '渲染产物与 dist/Surge-Beta.sgmodule 不一致'
    }
} finally {
    Remove-Item -LiteralPath $moduleFile.FullName
}
```

从仓库根目录执行以下后端验证。仓库的 `pnpm test` 使用 POSIX 环境变量前缀。以下命令直接调用预编译和 Mocha，用临时加载器处理 Windows 下 `babel-plugin-relative-path-import` 对 `@/` 的转换问题。

```powershell
Push-Location backend
$testHook = New-TemporaryFile
try {
    $env:PYTHONIOENCODING = 'utf-8'
    $env:SUB_STORE_FRONTEND_BACKEND_PATH = '/'
    $env:NODE_OPTIONS = '--no-experimental-detect-module'
    corepack pnpm install --frozen-lockfile
    if ($LASTEXITCODE) { throw '后端依赖安装失败' }
    node scripts/precompile-peggy.js
    if ($LASTEXITCODE) { throw 'Peggy 预编译失败' }
    @'
const path = require('node:path');
const { createRequire, registerHooks } = require('node:module');
const backend = process.cwd();
const fromBackend = createRequire(path.join(backend, 'package.json'));
registerHooks({
    resolve(specifier, context, nextResolve) {
        const resolved = specifier.startsWith('@/')
            ? path.join(backend, 'src', specifier.slice(2))
            : specifier;
        return nextResolve(resolved, context);
    },
});
fromBackend('@babel/register')({
    babelrc: false,
    configFile: false,
    presets: [fromBackend.resolve('@babel/preset-env')],
});
'@ | Set-Content -LiteralPath $testHook.FullName -Encoding utf8
    node node_modules/mocha/bin/mocha.js --require $testHook.FullName --recursive 'src/test/**/*.spec.js'
    $mochaExitCode = $LASTEXITCODE
    Write-Output "Mocha exit code: $mochaExitCode"

    corepack pnpm bundle:esbuild
    if ($LASTEXITCODE) { throw '后端打包失败' }
} finally {
    Remove-Item -LiteralPath $testHook.FullName
    Pop-Location
}
```

Windows 下已知两项 mihomo 用例涉及临时文件路径，分别是 `uses remote mihomoConfig source url instead of stale content by default` 和 `merges local and remote mihomoConfig file sources when requested`。它们在 Windows 盘符路径下可能返回 HTTP 500。检查失败清单是否只包含这两项；最终以 Linux CI 全部通过为准。

<a name="frontend-checks"></a>

### 前端补丁与 Pages 产物

从 fork 仓库根目录用 Bash 执行，使用上游前端 `.node-version` 指定的 Node 与上游 `package.json` 指定的 pnpm。Windows 可用 WSL；若用 Git Bash，确认 `python3 --version` 调用的是已安装的 Python 3。以下流程按发布工作流选取上游提交，在新的临时目录验证补丁幂等、类型检查、构建及最终站点。复现已上线版本时，把第一行 `ref` 赋值改为 `ref=$(curl -fsSL https://ahuai6.github.io/Sub-Store-Fork/frontend-version.txt)`。

```bash
(
  set -euo pipefail
  ref=$(bash .github/scripts/resolve_frontend_ref.sh)
  field() { printf '%s\n' "$ref" | sed -n "s/^$1=//p"; }
  sha=$(field sha)
  frontend=$(mktemp -d)
  git -C "$frontend" init -q
  git -C "$frontend" fetch --depth 1 https://github.com/sub-store-org/Sub-Store-Front-End.git "$sha"
  git -C "$frontend" checkout -q --detach FETCH_HEAD
  expected_node=$(tr -d '\r\n' < "$frontend/.node-version")
  if [[ $(node -p process.versions.node) != "$expected_node" ]]; then
    printf '请切换到前端所需的 Node %s\n' "$expected_node" >&2
    exit 1
  fi

  prepare=.github/scripts/prepare_frontend_pages.py
  python3 "$prepare" --patch --frontend-dir "$frontend"
  git -C "$frontend" add -A
  python3 "$prepare" --patch --frontend-dir "$frontend"
  git -C "$frontend" diff --exit-code
  test -z "$(git -C "$frontend" ls-files --others --exclude-standard)"

  (
    cd "$frontend"
    corepack pnpm install --frozen-lockfile
    VITE_API_URL=https://sub.store NODE_OPTIONS=--max-old-space-size=4096 corepack pnpm build
  )
  package=$(cd "$frontend" && node -p "require('./package.json').version")
  python3 "$prepare" --finalize-site --dist "$frontend/dist" --frontend-dir "$frontend" \
    --sha "$sha" --track "$(field track)" --release-tag "$(field release_tag)" \
    --release-sha "$(field release_sha)" --package "$package"
  printf '前端验证产物 %s\n' "$frontend/dist"
)
```

`--finalize-site` 会校验子路径和 Service Worker，添加 `404.html`、`.nojekyll`、许可归属及 `frontend-version.txt`。前端队列或跨域、缓存、路由等跨端改动还应走一遍目标场景。涉及保存或预览时，分别观察页面发起的请求、响应与设备日志。

---

<a name="verify-deployment"></a>

## 6. 手动发布与线上验收

### 触发发布

后端与前端有独立排程。需要立即发布对应改动时，手动触发以下工作流。

```bash
# 发布后端脚本、模块与 geo.js 到本仓库 GitHub Release
gh workflow run publish-dist.yml --ref main

# 发布前端到本仓库 gh-pages（修改 PATCH_STAMP 后无需 force；强制重发加 -f force=true）
gh workflow run publish-frontend.yml --ref main
```

### 线上验收

1. **后端脚本与 Release**。核对 `Built from` 指向预期的后端、模块或 `geo.js` 源码修订，并检查 12 个资产。相同版本可覆盖发布，tag 不一定指向构建提交。若 `Built from` 落后 `main`，先用 `git diff --name-only` 查看两者差异。仅文档变化时，两边的运行时代码仍可能一致；若包含拟发布变更，查看对应 `publish-dist` 运行及资产。
2. **Pages 前端**。以线上 `frontend-version.txt` 的上游 `sha`、`base`、`api`、`patches` 对照预期来源与补丁戳。检查线上 `index.html` 与 `sw.js`，并查 `publish-frontend` 和 Pages 部署记录。`gh-pages` 上已有文件时，线上站点仍应独立核对。
3. **Surge 设备**。根据变更范围，在测试设备上核对模块版本、Core/Simple 对应的路由、默认关闭的定时任务，以及脚本外部资源是否已刷新。打开 Pages，用测试订阅确认首页、保存和预览等受影响流程。记录实机验证和模拟回归各自覆盖的范围。

```bash
gh release view --repo ahuai6/Sub-Store-Fork --json tagName,body,assets
pages=https://ahuai6.github.io/Sub-Store-Fork
curl -fsSL "$pages/frontend-version.txt"
curl -fsSL "$pages/sw.js" | grep -oE 'skipWaiting|clientsClaim' | sort -u
curl -fsSL "$pages/" | grep -oE 'sub-store-fork|preconnect|content-visibility' | sort -u
```

### Surge iOS 端升级提示

- **脚本更新**：在 Surge 中「更新外部资源」即可拉取最新 `sub-store-0.min.js`、`sub-store-1.min.js`、`cron-sync-artifacts.min.js`、`geo.js`。
- **前端更新**：由于 PWA 已启用 `autoUpdate`（`skipWaiting` + `clientsClaim`），刷新网页或重启 PWA 即自动激活新版本。
- **模块更新**：若本次更新修改了 `dist/Surge-Beta.sgmodule`（如路由 pattern 或默认参数），提醒用户在 Surge 中更新模块；由于 Surge 可能保留已保存的旧模块参数，若需应用新的默认参数请重新安装模块并确认 `sync`/`produce`/`prefetch` 任务名仍以 `#` 开头。
