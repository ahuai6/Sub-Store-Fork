# Sub-Store-Fork Agent 交接总纲

本文是任何新 coding agent 接手本仓库（`ahuai6/Sub-Store-Fork`）时的**首要必读入口**。改代码、审 PR、同步上游、排查故障、发布上线之前，先读完本文，再按下方导航按需阅读对应专题文档。

> **文档分工与事实来源（单一真源原则）**：为避免大文档被工具上下文截断，本仓库将交接信息按职责拆分为四份维护文档；若两处不一致，以**当前代码**与本文为准并同步修正过时文档。线上部署现状以本仓库最新 Release 说明的 `Built from`、`dist/Surge-Beta.sgmodule` 及 `gh-pages` 分支的 `frontend-version.txt` 为准。

## 文档导航

| 文档 | 职责 | 何时必读 |
| --- | --- | --- |
| `AGENTS.md`（本文） | 项目定位、硬性约束、审批边界、关键注意事项、日常命令与速查 | **每次任务开始前必读** |
| `docs/architecture.md` | 完整系统架构、路由切分、构建瘦身、缓存分片与 TTL、下载流水线、非 Node 路由/日志、前端 Pages 补丁、`geo.js`、定时任务 | 改动后端/前端/构建/`geo.js`/模块代码前 |
| `docs/fork-maintenance.md` | CI/CD 排程、权限安全、三上游同步与冲突解决手册、必须保留的 fork 改动清单、发布与线上验收流程 | 同步上游、解冲突、排查 CI/发布、改工作流前 |
| `docs/maintenance-log.md` | 完整时间线维护记录（PR #5 至今、上游同步、审计修复、体积与基准实测） | 回溯设计决策、追加新版本维护记录时 |
| `scripts/check/GEO-NOTICE.md` | `geo.js` 上游归属、GPL-3.0 声明、当前追踪的 blob SHA 与改动摘要 | 修改或同步 `scripts/check/geo.js` 前 |
| `docs/performance-plan-audit.md`、`docs/step5-checks-and-cache.md` | 2026-11-13 历史归档记录（非当前状态） | 仅作历史背景参考，勿当作现状 |
| `README.md`、`config/README.md`、`config/Surge-Beta.sgmodule` | **上游原文件** | **禁止直接修改**，避免上游同步冲突 |

根目录 `AGENT.md` 仅指向本文，无第二份内容。

---

## 1. 项目定位与三上游关系

本仓库是 `sub-store-org/Sub-Store` 面向 **Surge iOS（含 TestFlight beta）** 的持续同步与二次开发公开仓库（2026-11-15 公开）。后端主许可证为 **AGPL-3.0**（根目录 `LICENSE`）；前端与 `geo.js` 各自保持 **GPL-3.0** 独立分发。

| 上游 / 分支 / 位置 | 职责 | 同步 / 发布方式 |
| --- | --- | --- |
| `sub-store-org/Sub-Store` (`master`) | 后端上游 | `sync-upstream.yml`（每日 04:17 UTC）快进 `upstream` 并合入 `main` |
| `sub-store-org/Sub-Store-Front-End` | 前端上游（GPL-3.0，不 vendoring） | `publish-frontend.yml`（每日 05:23 UTC）浅拉源码 → 锚点补丁 → 构建推 `gh-pages` |
| `xream/scripts` (`check/geo.js`) | `geo.js` 上游（GPL-3.0） | `sync-upstream.yml` 末尾 `check_geo_upstream.py` 每日非阻塞比对 blob SHA |
| `upstream` / `main` | 上游原样镜像（只快进） / 默认分支（上游 + fork 改动） | 默认分支是 `main`，**不是 `master`** |
| `sync/upstream` / `sync/tests-failed` | 同步冲突 PR / 检查失败 PR 分支 | 均不强推，报告写 Actions Job Summary（**仓库保持关闭 Issues**） |
| `dist/Surge-Beta.sgmodule` | 发布的 Surge 模块 | 由 `render_surge_beta_module.py` 基于 `config/Surge-Beta.sgmodule` 生成 |
| GitHub Release / `gh-pages` | 构建脚本资产（tag = `backend/package.json` version）/ Pages 前端 | 均在本仓库通过 `GITHUB_TOKEN` 发布 |

**公开访问链接**：
- 模块：`https://raw.githubusercontent.com/ahuai6/Sub-Store-Fork/main/dist/Surge-Beta.sgmodule`（同文件亦附于 Release）
- 脚本：`https://github.com/ahuai6/Sub-Store-Fork/releases/latest/download/` 下的 `sub-store-0.min.js`、`sub-store-1.min.js`、`cron-sync-artifacts.min.js`、`sub-store.min.js`、`sub-store.bundle.js`、`sub-store-parser.loon.min.js`、`proxy-utils.esm.mjs`、`runtime-manifest.json`
- `geo.js`：`https://raw.githubusercontent.com/ahuai6/Sub-Store-Fork/main/scripts/check/geo.js`（Release 同时附带 `geo.js`、`GEO-LICENSE.txt`、`GEO-NOTICE.md`）
- 前端：`https://ahuai6.github.io/Sub-Store-Fork/`（Pages 源为 `gh-pages` 的 `/`）

> 已删除的 `ahuai6/Sub-Store-Fork-Dist` 及 `FORK_REPO_TOKEN`、`PUBLIC_DIST_TOKEN` **严禁重新引入**。

---

## 2. 硬性约束（绝不可违反）

1. **Git 历史与合并纪律**：
   - 从当前 `origin/main` 开工，提交作者邮箱固定使用 `117343258+ahuai6@users.noreply.github.com`（历史上仅 4 个旧提交含个人邮箱，已决定不改写历史）。
   - **同步 PR（`sync/*` 或任何并入上游提交的 PR）必须使用 GitHub 的 Create a merge commit**；严禁 squash / rebase（否则上游提交丢失祖先关系，下次同步在同文件重复冲突）。普通功能 PR 可 squash。
   - **严禁** force-push、删除分支、开启 GitHub Issues、添加 `upload-artifact`、提交任何令牌/订阅链接/真实节点。
2. **上游原文件保护**：
   - `config/Surge-Beta.sgmodule`、`README.md`、`config/README.md`、`main.yml`、`star-history.yml` 保持与上游一致，**不要修改**。
   - **不要手动运行 `main.yml`**（name: `build`，它监听 `master` 且会 force-push `release` 分支）；真正的发布工作流是 `publish-dist.yml`。
   - **不删上游源文件**：完整保留全部 producers、parsers（含 Loon、QX）和 lodash；保留 `backend/src/test/proxy-producers/snapshots/` 黄金快照。
3. **缓存与全局 TTL 红线**：
   - 所有缓存一律遵循 `resourceCacheTtl` / `headersCacheTtl` / `scriptCacheTtl`（通过 `ttlFromSetting`）；TTL 为 `0`（含 `"0"`）时不读不写；禁止因节点指纹或内容未变而跨 TTL 永久复用。
   - **唯一例外**是用户显式开启的 `geo.js` `keep_last`（存 `#sub-store-cached-last-good`），且 `/api/utils/refresh` 清缓存时必须同步清除，输出不加标记。
4. **Surge 模块与路由红线**：
   - fork 模块改动只能写在 `.github/scripts/render_surge_beta_module.py`，必须通过 `--check` 逐字节还原为 `config/Surge-Beta.sgmodule`，提交结果 `dist/Surge-Beta.sgmodule` 须与渲染器输出逐字节一致。
   - 公开模块的 `sync`、`produce`、`prefetch` 三个定时任务名默认均以 `#` 开头（关闭），且所有 prefetch 参数均有可用默认值，安装不得要求用户输入。
   - `sub-store-0.js` **严禁导入 `ProxyUtils`、`restful/sync.js` 或 `restful/file.js`**，且路由注册阶段不得写主 store（避免每次简单请求重写整个 `sub-store` 文档）。
5. **合规与防护标记**：
   - 保留 `scripts/check/geo.js`、`GEO-LICENSE.txt`、`GEO-NOTICE.md` 并作为 Release 资产，不得擅自删改 `GEO-NOTICE.md` 中未定性的上游条款。
   - 新增运行时优化必须在 `.github/scripts/apply-fork-runtime.mjs` 补稳定标记；修改前端补丁行为必须递增 `.github/scripts/prepare_frontend_pages.py` 的 `PATCH_STAMP`（否则 `publish-frontend` 会跳过部署）。

---

## 3. 审批边界

- **可直接执行并合并（无需逐次询问）**：符合第 2 节硬性约束且全套本地与 CI 检查通过的常规维护、上游同步（必须 merge commit）、Bug 修复、性能优化、文档更新与发布触发（授权记录在 `06fd1578`）。
- **必须先请示用户**：
  - 修改 `GEO-NOTICE.md` 的上游额外条款或调整许可证策略；
  - 新增绕过全局 TTL 的持久化缓存；
  - 默认启用 `sync`/`produce`/`prefetch` 或新增必填安装参数；
  - force-push、删分支、`upload-artifact`、改 `main.yml` / `star-history.yml`；
  - 合并 head 仍为未解决冲突上游提交的 `sync/upstream`；
  - 会破坏已安装 Surge 模块或用户数据的不兼容变更。

---

## 4. 架构与核心机制速查（详见 `docs/architecture.md`）

- **路由切分**：
  - `sub-store-0.min.js`（~306 KB，`__SURGE_ONLY__ = true`）：首页全部元数据请求——subs、collections、token、modules、**纯文件元数据**（`restful/file-metadata.js`：`/api/files`、`/api/wholeFiles`、`/api/wholeFile/:name`）、artifacts、settings、sort、archives、misc、logs、age。
  - `sub-store-1.min.js`（~995 KB，`__SURGE_ONLY__ = true`）：download、`/api/file/:name`、`/share/file/:name`（及完整 `file.js` 兼容旧模块）、preview、sync、node-info；保留全部解析器与生产者。
  - `cron-sync-artifacts.min.js`（~956 KB）：定时同步、定时处理、`prefetch`（默认全关闭）。
- **打包瘦身（`backend/bundle-esbuild.js`）**：`surgeOnlyStripPlugin` 剥离 `@non-surge-start/end` 宿主代码；`stripPeggyGrammarPlugin` 剥离 `parsers/peggy/(surge|loon|qx).js` 无用 DSL 源码字符串；`dedupeNoblePlugin` 去重 `@noble/curves` 与 `@noble/hashes` 为 2.2.0 单副本（不改 lockfile）。
- **下载、缓存与分片**：`download.js` + `sync.js` / `preview.js` 通过 `deferPreprocess`（缓存命中零解析）与 `returnParsed`（冷拉只解析一次）消除重复解析，并自动回填默认流量头缓存键。`CacheShards`（`cache-shards.js`）覆盖 `#sub-store-cached-{resource,script-resource,output,check,last-good}`，单值上限 3 MiB UTF-8，冷启动按单键懒读并支持 O(1) 增量写入/删除。
- **前端 Pages 补丁**：`prepare_frontend_pages.py` 锚点注入（当前 `PATCH_STAMP`: `subpath-routes-2-pwa-autoupdate-1-surge-session-3-repo-pages-1`），涵盖 `/Sub-Store-Fork/` 子路径（含 `/preview`）、PWA `autoUpdate`（`skipWaiting` + `clientsClaim`）、3 级优先级 2 槽队列（后台挂起 `/api/sub/flow`、`FilePreview` 走 `queuedPreviewGet`）、刷新防重型预览、`preconnect` 与大表 `content-visibility:auto`。
- **非 Node 路由与日志**：`vendor/express.js` 加固 JSON 400 容错、Promise 拒绝捕获、大小写无关 header、安全 query 解码；`debug-logs.js` 在 `SURGE_ONLY` 下满 50 条或响应/`$done` 时批量刷盘。

---

## 5. 标准检查、构建与发布命令（详见 `docs/fork-maintenance.md`）

工具链钉在根目录 `.node-version`（当前 `24.22.1`）与 `backend/package.json` 的 `pnpm@11.0.9`。每次提交前必跑：

```bash
# 1. Fork 锚点与运行时保护检查
node .github/scripts/apply-fork-frontend.mjs --check
node .github/scripts/apply-fork-runtime.mjs --check

# 2. 后端全量测试（含 golden snapshots）与打包
cd backend
corepack enable && corepack prepare pnpm@11.0.9 --activate
pnpm i --frozen-lockfile
pnpm test
pnpm bundle:esbuild
cd ..

# 3. 脚本 Python 回归与模块渲染逐字节校验
python3 -m unittest discover -s .github/scripts -p 'test_*.py' -v
python3 .github/scripts/render_surge_beta_module.py --check \
  --public-repo ahuai6/Sub-Store-Fork --output /tmp/Surge-Beta.sgmodule
cmp /tmp/Surge-Beta.sgmodule dist/Surge-Beta.sgmodule

# 4. 性能改动额外跑基准（V8 参考值，对照 backend/bench/baseline.json）
cd backend && pnpm bench
```

发布触发（有权限直接跑 `gh workflow run`，否则请用户点击 Run）：
- 后端/模块/`geo.js` 变更：`gh workflow run publish-dist.yml --ref main`（定时每 3 小时第 47 分也会按 SHA 差异自动发布）
- 前端补丁变更：`gh workflow run publish-frontend.yml --ref main`（定时每日 05:23 UTC；未改 `PATCH_STAMP` 时可传 `-f force=true`）
- 上线验收必查：Release 的 `Built from` == `main` HEAD、`dist/Surge-Beta.sgmodule` 一致、`gh-pages` 的 `frontend-version.txt` / `sw.js` / `index.html` 标记无误。

---

## 6. 高频踩坑与注意事项

1. **Windows 本地跑 Mocha 的已知差异**：`backend/package.json` 的 `test` 脚本使用类 Unix 环境变量前缀，且 `babel-plugin-root-import` 在 Windows 路径分隔符下需显式重写 `@/` 别名；同时 `mihomo-config.spec.js` 中 2 个上游测试依赖 `os.tmpdir()` 以 `/` 开头，在 Windows 会报 500 而在 Linux CI（`ci.yml`）100% 通过。最终以 Linux `ci.yml` 全绿为准。
2. **TypeScript `vue-tsc` 对 `axios.get` 泛型推断**：前端补丁里包装 `axios.get`（如 `forkRequestGuard.ts` 的 `queuedPreviewGet`）必须显式声明返回 `Promise<any>` 而非泛型 `<T>`，否则上游 `vue-tsc --noEmit` 会将 `T` 推断为 `unknown` 导致构建失败。
3. **注册路由阶段零写入**：`sub-store-0` 的路由 `register($app)` 禁止在缺失键时调用 `$.write(...)`（例如 `file-metadata.js` 只在 `POST /api/files` 时懒初始化 `FILES_KEY`），否则冷启动会额外重写一次完整 `sub-store` 文档（`surge-subscription-save.spec.js` 会立即拦截）。
4. **`debug-logs.js` 批量开关边界**：上游 `logs.spec.js` 会构造 `env: { isNode: false }` 并断言 `console.log` 后立即写入存储；因此日志批量缓冲只能按 `SURGE_ONLY` 编译常量开启，不能按 `!$.env.isNode` 开启。
5. **非 Node `/` 重定向与 `DEFAULT_FRONTEND_URL`**：`miscs.js` 仅修改非 Node `/` 302 到 `https://ahuai6.github.io/Sub-Store-Fork/`；引导文案里的 `DEFAULT_FRONTEND_URL` 必须保持上游 `https://sub.xream.eu.org`。
6. **已安装 Surge 模块的参数残留**：更新模块不一定覆盖用户已保存的旧参数；若涉及模块默认参数或路由 pattern 变更，需提醒用户在 Surge 中更新或重装模块，并核对定时任务名仍以 `#` 开头。
7. **`star-history.yml`**：上游工作流保持不动，它在公开仓库中可能偶发失败，属于非核心上游文件，不要为修它而偏离上游。
8. **变更收尾**：每次完成上游同步、架构改动或审计修复后，同步更新 `docs/maintenance-log.md`（若涉及架构/运维变化，同步更新 `docs/architecture.md` / `docs/fork-maintenance.md` 及本文）。
