# Sub-Store-Fork 维护与变更记录

本文按时间倒序记录本仓库自创建以来的关键架构演进、上游同步、代码审计修复、性能与产物体积实测数据。

> **维护规范**：每次完成上游版本同步、架构调整、Bug 审计修复或性能增强并发布后，在本文顶部追加一条结构化记录（注明日期、提交 SHA / PR 号、上游基线、核心改动、实测数据与测试计数）。

---

## 2026-11-20 — 文档体系结构化重构

- **背景**：原 `AGENTS.md` 体量超过部分 AI 工具的规则自动注入截断阈值，导致后半部分同步规范与踩坑要点被截断；同时 `dist/README.md` 与 2026-11-13 历史记录存在过时表述。
- **调整**：
  - 精炼 `AGENTS.md` 为 ~10 KB 完整交接总纲（确保在工具规则注入中零截断），集中呈现文档导航、三上游定位、硬性约束、审批边界、速查架构、标准命令与高频踩坑。
  - 新增 `docs/architecture.md`（技术架构与子系统深潜规范，含 Mermaid 全景图）与 `docs/maintenance-log.md`（完整时间线维护记录，避免触发 `.gitignore` 中的 `CHANGELOG.md` 规则）。
  - 重构 `docs/fork-maintenance.md` 为纯运维与冲突解决手册；更新 `AGENT.md` 与 `dist/README.md`；为 2026-11-13 两份历史文档添加归档提示横幅。
  - 保持上游原文件 `README.md`、`config/README.md`、`config/Surge-Beta.sgmodule` 原样不动。

---

## 2026-11-20 — 全栈性能与体验增强（P1–P9）及三上游监控上线

- **提交**：`c2bdbca8`（P1–P9 主提交）、`f9efa9a6`（修复 `queuedPreviewGet` 返回类型 `Promise<any>` 以通过上游 `vue-tsc`）
- **上游基线**：
  - 后端 `sub-store-org/Sub-Store`：`2a173b88`（`v2.44.16`）
  - 前端 `sub-store-org/Sub-Store-Front-End`：`59632bfc`（`v2.34.3`）
  - `geo.js` `xream/scripts`：repo `49248e43` / blob `1d573206451a140b3ba3964b07f7de392e7e5ccd`
- **发布记录**：
  - Linux `ci.yml`（`44577653062`）：**1086 passing / 0 failing**，Python 回归 **18 passing**
  - Release `2.44.16`（`publish-dist.yml` `44577805683`）：`Built from: f9efa9a64f0b533f6c49a2b068db7a89db697d27`，12 个资产全量更新
  - GitHub Pages（`publish-frontend.yml` `44577697254` / `pages-build-deployment` `44577885421`）：`patches=subpath-routes-2-pwa-autoupdate-1-surge-session-3-repo-pages-1`
- **核心改动（P1–P9）**：
  - **P1 前端线上缺陷修复**：`prepare_frontend_pages.py` 补丁 `PreviewPanel.vue` 的 `/preview` 路径补齐 `BASE_URL`（消除子路径 404）；`vite.config.ts` 启用 PWA `registerType: "autoUpdate"`（`check_dist` 强制断言 `sw.js` 含 `skipWaiting` 与 `clientsClaim`）。
  - **P2 前端并发调度与渲染优化**：`forkRequestGuard.ts` 2 槽队列升级为 3 级优先级（写/预览/刷新/下载 > 列表读 > `/api/sub/flow`），`hidden` 状态挂起队列中的流量请求并在 `visibilitychange` 恢复；`FilePreview.vue` 改走 `queuedPreviewGet`；`index.html` 注入 API `preconnect` 与 `.compare-table-row` `content-visibility:auto`。
  - **P3 O(1) 增量分片与资源缓存分片**：`cache-shards.js` 单例化 `TextEncoder`，新增 `writeEntries`/`deleteEntries` 增量路径（冷启动读写与过期清理不加载无关分片，键集合未变跳过 manifest 重写）；`#sub-store-cached-resource` 接入分片。
  - **P4 下载/输出缓存消除重复解析**：`download.js` + `sync.js` / `preview.js` 增加 `deferPreprocess`（缓存命中零解析）与 `returnParsed`（冷拉只解析一次）；`output-cache.js` 扩展 `OMITTED_SETTINGS` 并对 >256 字符文本做 MD5 摘要。
  - **P5 零源码侵入打包瘦身**：`bundle-esbuild.js` 新增 `stripPeggyGrammarPlugin`（剥离打包期无用 Peggy DSL 字符串）与 `dedupeNoblePlugin`（去重 `@noble/curves` 与 `@noble/hashes` 到 2.2.0 单副本，不改 lockfile）及构建断言。
  - **P6 非 Node 路由加固与批量日志**：`vendor/express.js` 修 `HEAD` 拼写与 `next()` 传参、CORS 后容错解析 JSON（非法返 400）、捕获非 `async` Promise 拒绝、大小写无关 header 去重、安全 query 解码；`debug-logs.js` 在 `SURGE_ONLY` 下满 50 条或响应/`$done` 时批量落盘。
  - **P7 `geo.js` 调度与上游漂移监测**：启用 `cache` 时同步预扫描先应用缓存结果；新增 opt-in `prioritize_stale=true` 配合 `keep_last=true` 轮换探测；输出单行 `[geo] ...` 汇总日志；新增 `.github/scripts/check_geo_upstream.py` 接入 `sync-upstream.yml` 非阻塞监测 `xream/scripts` 漂移。
  - **P8 首页纯文件元数据路由下沉 `sub-store-0`**：新增 `backend/src/restful/file-metadata.js`（`/api/files`、`/api/wholeFiles`、`/api/wholeFile/:name`，注册零写入），缩窄 `render_surge_beta_module.py` 的 `FORK_CORE_PATTERN` 并重渲染 `dist/Surge-Beta.sgmodule`；`sub-store-1` 保留完整 `file.js` 兼容旧模块。
  - **P9 细节修复与流量头回填**：`subscriptions.js` 修复缺失订阅提前 `delete sub.subscriptions` 抛 `TypeError` 且 `404` 错位问题；`download.js` 回填 `defaultFlowUserAgent + originalUrl` 流量头缓存键。
- **实测产物体积对比（Release 资产实测）**：

| 产物 | P1–P9 前 | P1–P9 后 | 变化 |
| --- | ---: | ---: | ---: |
| `sub-store-0.min.js` | 337,406 B | **305,704 B** | **-31.7 KB (-9.4%)** |
| `sub-store-1.min.js` | 1,081,715 B | **995,185 B** | **-86.5 KB (-8.0%)** |
| `cron-sync-artifacts.min.js` | 1,043,512 B | **956,195 B** | **-87.3 KB (-8.4%)** |
| `sub-store.min.js` | 1,148,634 B | **1,061,519 B** | **-87.1 KB (-7.6%)** |
| `sub-store.bundle.js` | 3,107,936 B | **3,020,843 B** | **-87.1 KB (-2.8%)** |
| `proxy-utils.esm.mjs` | 1,033,112 B | **945,788 B** | **-87.3 KB (-8.5%)** |

- **V8 基准实测（Node v24.22.1，`bench.js`，仅供参考非 Surge 真机）**：
  - `getFlag5000`：`37.48 ms`（-84.3% vs baseline `238.39 ms`）
  - `peggySurgePerRequest`：`3.27 ms`（-92.4% vs baseline `43.07 ms`）
  - `peggyLoonPerRequest`：`2.11 ms`（-91.7%）、`peggyQxPerRequest`：`2.64 ms`（-85.3%）
  - `outputCacheHit5000`：`0.05 ms` vs `outputCacheMiss5000`：`95.01 ms`

---

## 2026-11-20 — 第一轮全代码审计与 10 项逻辑修复

- **提交**：`31e63666`
- **验证**：Linux `ci.yml` **1073 passing / 0 failing**，Python 回归 **11 passing**；已发布 Release `2.44.16` 与 `gh-pages`。
- **修复内容**：
  1. `forkRequestGuard.ts`：拦截 axios 0.27 取消错误缺失 `error.config` 导致的 2 槽泄漏，清理 `AbortSignal`/`CancelToken` 排队等待者。
  2. `cache-shards.js` / `bounded-cache.js`：修复写分片中途失败后 `_keySet` 不一致、冷启动过期触发双次落盘、以及预算核算未计入 `[id, entry]` 包装字节的问题。
  3. `preview.js` / `output-cache.js`：修复组合订阅预览未检查子订阅 `noCache`、`preview-file` 缓存键缺失文件元数据字段的问题。
  4. `geo.js`：`surge_http_api` 请求正确转义并传递配置 HTTP `method`；小批量待刷缓存按 15 秒间隔周期落盘防超时丢失。
  5. `storage.js` / `batch-flush.js`：Surge 恢复备份时同步内存缓存并触发迁移；Surge 批量刷新改为同步时间检查点（不挂 timer）。
  6. `sync-upstream.yml`：彻底移除对已关闭 GitHub Issues 的依赖（`gh issue` / `issues: write`），改为输出至 Actions Job Summary 与 PR 评论，并新增 `test_sync_upstream_workflow.py` 守护。

---

## 2026-11-16 至 2026-11-19 — 上游 2.44.15–2.44.16 同步与 Surge 保存性能修复

- **`12543105`（PR #22，`647a433b`、`dba79bdc`）**：修复 Surge 保存订阅卡死与反复重写主 store 问题（紧凑存储、未变跳过、防止 YAML 图遍历卡顿），新增 `surge-subscription-save.spec.js` 端到端 Surge VM 回归。
- **`28909bf0`**：移除重型依赖 `jsrsasign`（`rs.js` 轻量化），为分片缓存实现冷启动单键懒加载（`readEntry` / `_ensureLoaded`），优化 Surge 冷启动。
- **`bed73b89`**：支持 fork 脚本处理 CRLF 行尾，增强 Windows 本地测试兼容性。
- **`15071233`**：`CheckResultCache` 批量写入、删除置空键、加固 `geo`/`preview` 缓存边界。
- **`b1d5827f`（merge commit）**：合入上游 `2.44.15–2.44.16`（`7f2de2f3..2a173b88`：SCP 分享功能、Surge/Surfboard 非法节点名处理）。
- **`31b56f16`（PR #21）**：文档更新记录仓库公开并移除已删除的 `Sub-Store-Fork-Dist` 流程。

---

## 2026-11-13 至 2026-11-15 — 早期基础架构建设（PR #5–#20）

- **PR #19（`4c21f05b`，merge commit）**：合入上游 `2.44.12–2.44.14`（Surge VLESS XHTTP、sing-box Snell `userkey`、WS HTTP Upgrade），确立 `parsers/peggy/surge.js` 冲突的标准合并范式（保留上游语法 + 保留预编译导入与 `setSurgeXhttpOption` 传参）。Linux 测试 **1033 passing**。
- **PR #20（`007223c8`）**：仓库于 2026-11-15 设为公开；CI、Release 发布、Pages 前端与每日上游同步全部迁回本仓库使用 `GITHUB_TOKEN`，弃用 `ahuai6/Sub-Store-Fork-Dist` 及外置 token。
- **PR #18（`33d124fb`）**：修复 `PATCH /api/settings` 无法持久化 TTL `0` / `"0"` 的问题，确立三个缓存 TTL 键的保存/清空规则。
- **PR #17（`87268dd3`）**：建立首版面向 coding agent 的独立交接文档 `AGENTS.md`。
- **PR #16（`7d4d0c41`，merge commit）**：通过 `git merge -s ours --no-ff d9896398`（`5222fc28`）补记上游 2.44.11 祖先关系，确立「同步 PR 严禁 squash，必须用 Create a merge commit」的硬性纪律（取代因 squash 重复触发的 PR #15）。
- **PR #14（`06544218`）**：过渡期迁移至外置产物仓库（后由 PR #20 取代）。
- **PR #13（`85a458ab`，squash）**：合并上游 2.44.11 三文件冲突并修复 runner 无 git identity 导致的空白冲突 PR（取代已关闭未合并的 PR #12）。
- **PR #11（`2b44d0f3`）**：为 `geo.js` 新增 opt-in `keep_last` / `keep_last_max_age`（`#sub-store-cached-last-good`）。
- **PR #10（`9105596c` / `06fd1578`）**：模块定时任务 `sync`/`produce`/`prefetch` 全部默认 `#` 关闭，prefetch 全参数赋默认值；同时记录用户对常规已验证 PR 直接合并的授权。
- **PR #9**：引入 `CacheShards` 分片缓存、全局 TTL 审计、Surge 模块参数语法校验与公开 `geo.js`（带 GPL-3.0 与 `GEO-NOTICE.md`）；当时测试 **1020 passing**。
- **PR #8**：为 `sub-store-0` 与 `sub-store-1` 引入 `__SURGE_ONLY__` 编译期开关与 `@non-surge-start/end` 宿主剥离。
- **PR #7**：`getFlag` 匹配器单次编译；Peggy 预编译（保留源码）；将重型 `file` 路由从 `sub-store-0` 移出使简单包剥离 `ProxyUtils`；Node 按文件写入 store。
- **PR #6**：引入遵循 `resourceCacheTtl` 的输出缓存、遵循 `scriptCacheTtl` 的共享节点检测缓存与 opt-in `prefetch` 定时任务。
- **PR #5**：建立 `golden-snapshot.spec.js` 黄金快照保护、`bench.js` 5000 节点基准、`inflight.js` 同 realm 去重、前端刷新防重型预览与 `geo.js` 批量缓存写入。
