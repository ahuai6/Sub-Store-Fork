# Sub-Store-Fork Agent 交接总纲

本文是任何新 coding agent 接手本仓库（`ahuai6/Sub-Store-Fork`）时的**首要必读入口**。改代码、审 PR、同步上游、排查故障、发布上线之前，先读完本文，再按下方导航按需阅读对应专题文档。

本文记录维护约束。运行行为以当前源码和测试为准，操作方法见运维手册。线上前端、后端脚本和设备模块各有独立的验收依据，见[发布验收](docs/fork-maintenance.md#verify-deployment)。

## 文档导航

| 文档 | 职责 | 何时必读 |
| --- | --- | --- |
| `AGENTS.md`（本文） | 项目定位、硬性约束、审批边界、关键注意事项、日常命令与速查 | **每次任务开始前必读** |
| [架构文档](docs/architecture.md) | 前后端入口、Surge 路由、缓存与 TTL、构建、`geo.js`、定时任务 | 改动后端、前端、构建、`geo.js` 或模块前 |
| [运维手册](docs/fork-maintenance.md) | 从干净检出验证前后端、CI/CD、上游冲突处理与线上验收 | 本地验证、同步、排查 CI 或发布前 |
| [维护日志](docs/maintenance-log.md) | 上游同步、关键变更、实测数据与验证范围 | 回溯设计决策、追加维护记录时 |
| `scripts/check/GEO-NOTICE.md` | `geo.js` 上游归属、GPL-3.0 声明、当前追踪的 blob SHA 与改动摘要 | 修改或同步 `scripts/check/geo.js` 前 |
| `docs/performance-plan-audit.md`、`docs/step5-checks-and-cache.md` | 2026-11-13 历史归档记录（非当前状态） | 仅作历史背景参考，勿当作现状 |
| `README.md`、`config/README.md`、`config/Surge-Beta.sgmodule` | **上游原文件** | **禁止直接修改**，避免上游同步冲突 |

根目录 `AGENT.md` 仅指向本文，无第二份内容。

---

## 1. 项目定位与三上游关系

本仓库是 `sub-store-org/Sub-Store` 面向 **Surge iOS（含 TestFlight beta）** 的持续同步与二次开发公开仓库（2026-11-15 公开）。后端主许可证为 **AGPL-3.0**（根目录 `LICENSE`）；前端与 `geo.js` 各自保持 **GPL-3.0** 独立分发。

**后端源码**在本仓库的 `backend/`。**前端完整源码**在 `sub-store-org/Sub-Store-Front-End`，本仓库维护 `.github/scripts/prepare_frontend_pages.py` 和 `.github/scripts/fork-frontend/` 中的补丁，构建后发布到 `gh-pages`。Surge 模式下，Pages 里的页面通过模块接管的 `https://sub.store` 调用后端。改 API、解析或缓存从 `backend/` 入手，改页面或请求调度从前端上游源码和补丁入手。项目安装入口见 [Surge 模块说明](dist/README.md)。

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
   - `sub-store-0.js` **严禁导入 `ProxyUtils`、`restful/sync.js` 或 `restful/file.js`**。保持文件元数据路由注册零写入，新增或迁入的轻路由也不得在注册时写主 store。历史路由在缺键时仍可能初始化，详见[存储与保存排障](docs/architecture.md#surge-save-diagnostics)。
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
- **下载、缓存与分片**：`download.js` + `sync.js` / `preview.js` 通过 `deferPreprocess` 与 `returnParsed` 复用解析结果，并回填默认流量头缓存键。`CacheShards` 支持单键懒读与分片增量更新，新增或删除键时仍更新分片清单。单值上限 3 MiB UTF-8。
- **前端 Pages 补丁**：`prepare_frontend_pages.py` 注入 `/Sub-Store-Fork/` 子路径、PWA `autoUpdate`、请求限流与刷新防重型预览。`forkRequestGuard.ts` 实现 3 级优先级的 2 槽队列。当前补丁戳可用 `python3 .github/scripts/prepare_frontend_pages.py --print-patch-stamp` 查询。
- **非 Node 路由与日志**：`vendor/express.js` 加固 JSON 400 容错、Promise 拒绝捕获、大小写无关 header、安全 query 解码；`debug-logs.js` 在 `SURGE_ONLY` 下满 50 条或响应/`$done` 时批量刷盘。

---

## 5. 检查与发布入口

后端工具链以 `.node-version` 和 `backend/package.json` 的 `packageManager` 为准。后端全量验收使用 Linux CI 同款的 `bash .github/scripts/run_fork_publish_checks.sh "$PWD"`，请在干净副本中执行，脚本会为构建临时更新两处 mihomo 版本字符串。性能改动另跑 `pnpm bench`。前端变更还需拉取上游源码，跑完补丁、类型检查、构建与产物验证。

- [本地验证和 Windows 命令](docs/fork-maintenance.md#local-checks)
- [前端全量验证](docs/fork-maintenance.md#frontend-checks)
- [发布触发和线上验收](docs/fork-maintenance.md#verify-deployment)

---

## 6. 高频踩坑与注意事项

1. **Windows 本地验证**：PowerShell 下留意 Mocha 启动环境、Babel 的 `@/` 解析和模块渲染器的 UTF-8 输出。可复制命令与两个已知 mihomo 路径用例见[Windows 小节](docs/fork-maintenance.md#windows-checks)，全量验收以 Linux CI 为准。
2. **TypeScript `vue-tsc` 对 `axios.get` 泛型推断**：前端补丁里包装 `axios.get`（如 `forkRequestGuard.ts` 的 `queuedPreviewGet`）必须显式声明返回 `Promise<any>` 而非泛型 `<T>`，否则上游 `vue-tsc --noEmit` 会将 `T` 推断为 `unknown` 导致构建失败。
3. **保存卡住**：记录 `PATCH /api/sub/:name` 的响应和主文档写入，再看随后取订阅或并行预览是否卡住。键齐全与旧数据缺键应分别复现，见[Surge 保存排障](docs/architecture.md#surge-save-diagnostics)。
4. **`debug-logs.js` 批量开关边界**：上游 `logs.spec.js` 会构造 `env: { isNode: false }` 并断言 `console.log` 后立即写入存储；因此日志批量缓冲只能按 `SURGE_ONLY` 编译常量开启，不能按 `!$.env.isNode` 开启。
5. **非 Node `/` 重定向与 `DEFAULT_FRONTEND_URL`**：`miscs.js` 仅修改非 Node `/` 302 到 `https://ahuai6.github.io/Sub-Store-Fork/`；引导文案里的 `DEFAULT_FRONTEND_URL` 必须保持上游 `https://sub.xream.eu.org`。
6. **已安装 Surge 模块的参数残留**：更新模块不一定覆盖用户已保存的旧参数；若涉及模块默认参数或路由 pattern 变更，需提醒用户在 Surge 中更新或重装模块，并核对定时任务名仍以 `#` 开头。
7. **`star-history.yml`**：上游工作流保持不动，它在公开仓库中可能偶发失败，属于非核心上游文件，不要为修它而偏离上游。
8. **变更收尾**：每次完成上游同步、架构改动或审计修复后，同步更新 `docs/maintenance-log.md`（若涉及架构/运维变化，同步更新 `docs/architecture.md` / `docs/fork-maintenance.md` 及本文）。
