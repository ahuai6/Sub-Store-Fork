# 持续同步、发布与运维手册

本文是 `AGENTS.md` 的操作手册，覆盖 CI/CD 工作流、仓库安全权限、三条上游基线的同步与冲突处理流程、必须保留的 fork 修改核对表、本地/CI 验证方法及线上验收步骤。

> 全局硬性约束与审批边界见根目录 `AGENTS.md`；系统架构与各子系统实现细节见 `docs/architecture.md`；历史维护记录见 `docs/maintenance-log.md`。两处文档不一致时，以当前代码与 `AGENTS.md` 为准并同步修正过时文档。

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
- **补救办法**：若不慎已经 squash，在 `main` 上执行 `git merge -s ours --no-ff <upstream-sha>` 记录祖先关系（树内容不变），再以 **Create a merge commit** 合入 `main`。
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
| 存储与 O(1) 分片 | `resource`、`script-resource`、`output`、`check`、`last-good` 全部接入 `CacheShards`（64 KiB 阈值、3 MiB UTF-8 上限、旧布局兼容、冷启动单键懒读、`writeEntries`/`deleteEntries` O(1) 增量路径）；`revokeAll()` 清全部分片；Node 按文件写 store，Surge 主文档紧凑存储与恢复同步迁移 |
| `geo.js` Operator | 兼容原参数/模板；20 并发上限、同步缓存预扫描、`time_budget`（880 s 安全上限）、`two_phase`、`dedup_target`、`keep_last` / `keep_last_max_age`（全局 TTL 唯一例外，刷新清除、不加标记）、`prioritize_stale` 轮换调度、单行汇总日志；随 `GEO-LICENSE.txt` 与 `GEO-NOTICE.md` 发布，每日非阻塞监测 `xream/scripts` 漂移 |
| 编译、瘦身与冷启动 | `getFlag` 单次编译；Peggy 预编译（保留语法源）；`surgeOnlyStripPlugin` + `stripPeggyGrammarPlugin` + `dedupeNoblePlugin` 及断言；无 `jsrsasign`（由 `age` / 原生实现替代）；全部生产者/解析器/lodash 源码保留 |
| 路由、容错与日志 | 纯文件元数据路由（`file-metadata.js`，注册零写入）在 `sub-store-0`（无 `ProxyUtils`）；`/api/file/:name`、`/share/file/:name` 与完整 `file.js` 兼容路由在 `sub-store-1`；`subscriptions.js` 缺失订阅返回 404；`express.js` 非 Node 容错加固（400 非法 JSON、Promise 拒绝捕获、大小写无关 header、安全 query 解析）；`SURGE_ONLY` 批量日志落盘 |
| 模块渲染与发布 | `config/Surge-Beta.sgmodule` 原样不动；`render_surge_beta_module.py --check` 可逆生成 `dist/Surge-Beta.sgmodule`，三个定时任务默认 `#` 关闭且 prefetch 参数全有默认值；Release 仅上传明确资产列表，无 `upload-artifact` |

---

## 5. 本地与 CI 检查操作指南

### Linux / macOS / CI（标准路径）

CI 执行 `.github/scripts/run_fork_publish_checks.sh "$PWD"`，顺序如下：
1. `node .github/scripts/apply-fork-frontend.mjs --check`
2. `node .github/scripts/apply-fork-runtime.mjs --check`
3. `cd backend && pnpm i --frozen-lockfile`
4. 拉取最新 mihomo `version.txt` 并执行 `.github/scripts/sync_mihomo_version.mjs`
5. `cd backend && pnpm test`（含 `golden-snapshot.spec.js`；当前基线 **1086 passing / 0 failing**）
6. `python3 -m unittest discover -s .github/scripts -p 'test_*.py'`（当前 **18 passing**）
7. `cd backend && pnpm bundle:esbuild`（含 `precompile-peggy.js`、`assertNobleDeduplicated()`、`assertSurgeOnlyBundles()`）
8. `render_surge_beta_module.py --check` 并 `cmp` 校验输出与 `dist/Surge-Beta.sgmodule` 逐字节一致，组装 `public-dist/`（不入库）。

### Windows 本地开发注意事项

- 使用 `corepack pnpm ...` 调用 pinned pnpm。
- `backend/package.json` 的 `test`/`bench` 使用了 POSIX 环境变量前缀且 `babel-plugin-root-import` 在 Windows 下可能无法解析 `@/`，需在 PowerShell 中先设置 `$env:SUB_STORE_FRONTEND_BACKEND_PATH = '/'`、`$env:NODE_OPTIONS = '--no-experimental-detect-module'`，并通过自定义 Babel `@/` 别名插件运行 Mocha 或 `scripts/bench.js`。
- `backend/src/test/restful/mihomo-config.spec.js` 中 2 个上游测试因 `os.tmpdir()` 返回 `C:\...`（不以 `/` 开头）而在 Windows 失败，在 Linux `ci.yml` 100% 通过；其余全部测试必须在 Windows 本地 100% 通过，且推送后必须确认 Linux `ci.yml` 0 失败。
- 本地验证前端补丁：可浅克隆 `sub-store-org/Sub-Store-Front-End` 到临时目录，执行 `python .github/scripts/prepare_frontend_pages.py --patch --frontend-dir <dir>` 两次验证锚点匹配与幂等性。
- 检查 `geo.js` 上游漂移：`python .github/scripts/check_geo_upstream.py`。

---

## 6. 手动发布与线上验收清单

### 触发发布

```bash
# 发布后端脚本、模块与 geo.js 到本仓库 GitHub Release
gh workflow run publish-dist.yml --ref main

# 发布前端到本仓库 gh-pages（修改 PATCH_STAMP 后无需 force；强制重发加 -f force=true）
gh workflow run publish-frontend.yml --ref main
```

### 线上验收命令

```bash
# 1. 核对 Release 的 Built from SHA 与 12 个资产完整
gh release view --json tagName,body,assets

# 2. 核对 gh-pages 的 frontend-version.txt（sha、base、api、patches）
gh api repos/ahuai6/Sub-Store-Fork/contents/frontend-version.txt?ref=gh-pages --jq .content | base64 -d

# 3. 核对 gh-pages 的 sw.js 含 skipWaiting & clientsClaim，index.html 含 fork meta / preconnect / content-visibility
gh api repos/ahuai6/Sub-Store-Fork/contents/sw.js?ref=gh-pages --jq .content | base64 -d | grep -E "skipWaiting|clientsClaim"
gh api repos/ahuai6/Sub-Store-Fork/contents/index.html?ref=gh-pages --jq .content | base64 -d | grep -E "sub-store-fork|preconnect|content-visibility"
```

### Surge iOS 端升级提示

- **脚本更新**：在 Surge 中「更新外部资源」即可拉取最新 `sub-store-0.min.js`、`sub-store-1.min.js`、`cron-sync-artifacts.min.js`、`geo.js`。
- **前端更新**：由于 PWA 已启用 `autoUpdate`（`skipWaiting` + `clientsClaim`），刷新网页或重启 PWA 即自动激活新版本。
- **模块更新**：若本次更新修改了 `dist/Surge-Beta.sgmodule`（如路由 pattern 或默认参数），提醒用户在 Surge 中更新模块；由于 Surge 可能保留已保存的旧模块参数，若需应用新的默认参数请重新安装模块并确认 `sync`/`produce`/`prefetch` 任务名仍以 `#` 开头。
