# Sub-Store-Fork 交接说明

本文是本仓库给任何新 coding agent 的交接说明。改代码、审 PR、同步上游、发布之前先读完。`docs/fork-maintenance.md` 保留同一套同步和发布的操作细节；两处不一致时，以本文和当前代码为准，并改掉过时的一边。`docs/performance-plan-audit.md` 和 `docs/step5-checks-and-cache.md` 是 2026-11-13 的历史记录，部署状态以 Dist 仓库的 README、Release 和 `gh-pages` 上的 `frontend-version.txt` 为准。

根目录 `AGENT.md` 只指向本文，没有第二份内容。

## 1. 项目定位

这是 `sub-store-org/Sub-Store` 的私有持续同步与二次开发仓库（`ahuai6/Sub-Store-Fork`），不是一次性改版。使用场景是 Surge iOS，包括 TestFlight beta。源码保持私有。

| 位置 | 职责 |
| --- | --- |
| `sub-store-org/Sub-Store` 的 `master` | 后端上游 |
| `sub-store-org/Sub-Store-Front-End` | 前端上游，独立仓库，GPL-3.0。本仓库不 vendoring 前端 |
| 私有 `upstream` | 上游 `master` 的原样镜像，只允许快进，不放 fork 改动 |
| 私有 `main` | 上游代码 + 已审核的 fork 修改。默认分支是 `main`，不是 `master` |
| 私有 `sync/upstream` | 冲突时的同步 PR 分支。已有解决提交时不强推 |
| 私有 `sync/tests-failed` | 合并无冲突但发布检查失败时的 PR 分支。不强推 |
| `ahuai6/Sub-Store-Fork-Dist` 的 `main` | 公开模块、`geo.js`、许可证和来源说明 |
| Dist 的 Release | 构建好的脚本。模块里的脚本 URL 使用 `releases/latest/download` |
| Dist 的 `gh-pages` | 按上游前端构建的官方页面，不是后端源码目录 |

公开页面是 https://ahuai6.github.io/Sub-Store-Fork-Dist/ 。非 Node 的 `/` 在 `backend/src/restful/miscs.js` 里 302 到这个 URL。`backend/src/utils/cors.js` 的 `NON_NODE_CORS_DEFAULT` 包含 `https://ahuai6.github.io`，并保留上游 origin（含 `https://sub.xream.eu.org`）。`NODE_CORS_DEFAULT` 与它相同。引导文案里的 `DEFAULT_FRONTEND_URL` 仍是上游的 `https://sub.xream.eu.org`，不要把它改成 Pages 地址。

后端许可证是 AGPL-3.0（根目录 `LICENSE`）。`geo.js` 另有 GPL-3.0，见第 8 节。

## 2. 架构

### 目录

- `backend/`：pnpm 包，`package.json` 的 `version` 是发布版本。`packageManager` 为 `pnpm@11.0.9`。Node 钉在根目录 `.node-version`（当前 `24.22.1`）。
- `backend/src/main.js`：Node 入口，经 `backend/src/restful/index.js` 注册全部路由。
- `backend/src/products/sub-store-0.js`：Surge 简单脚本。集合、订阅、token、模块、artifact、设置、排序、归档、misc、日志、age。不导入 ProxyUtils，不注册 file 路由。
- `backend/src/products/sub-store-1.js`：Surge 核心脚本。download、file、preview、sync、node-info。file 路由在这里，所以简单包不会带上解析器。
- `backend/src/products/cron-sync-artifacts.js`：定时同步、定时处理、prefetch。
- `backend/src/products/resource-parser.loon.js`、`proxy-utils.esm.js`：仍构建，给非本次 Surge 主路径的产物用。源码保留。
- `backend/bundle-esbuild.js`、`backend/surge-only-strip.js`：构建。
- `backend/scripts/precompile-peggy.js`、`backend/scripts/bench.js`：Peggy 预编译和性能基准。基线在 `backend/bench/baseline.json`。
- `config/Surge-Beta.sgmodule`：上游原文件。不要在这里写 fork 改动。
- `.github/scripts/render_surge_beta_module.py`：把上游模块渲染成公开模块，并检查差异可以逐项还原。
- `scripts/check/geo.js`：发布的脚本操作源码，旁边有 `GEO-NOTICE.md` 和 `GEO-LICENSE.txt`。
- `.github/workflows/`：私有仓库工作流，只保留手动入口。真正跑的是 Dist 里的同名文件。

发布的 Surge 模块把 Core（`sub-store-1.min.js`）放在 Simple（`sub-store-0.min.js`）前面。Core 的 pattern 匹配 download、`share/file`、`api/file(s)`、`api/wholeFile(s)`、preview、sync、`api/utils/node-info`。Simple 是 `^https?:\/\/sub\.store` 的兜底，看不到已经被 Core 接走的 file URL。

### Surge-only 构建

只有 `sub-store-0` 和 `sub-store-1` 使用 esbuild `define`：

```text
__SURGE_ONLY__ = true
$platform = "Surge"
```

`backend/src/runtime/build-flags.js` 把这两个标识折成常量。其他产物定义 `__SURGE_ONLY__` 为 `false`，仍在运行时判断宿主。测试和 `babel-node` 不声明该标识，检测保持动态。不要给 `$platform` 赋值，Surge 构建会把这个标识替换成字符串字面量。

`surge-only-strip.js` 在解析前删掉 `/* @non-surge-start */` … `/* @non-surge-end */` 整段语句。标记必须成对、包住完整语句、不能嵌套。其他构建保留这些语句。

`bundle-esbuild.js` 的 `assertSurgeOnlyBundles()` 检查文本标记，没有数字体积门槛：

- `sub-store-0.min.js` 不得含 `ProxyUtils`，也不得含 `undici`、`shoutrrr`、`dotenv`、`geoip2`、`fetch-socks`、`express`、`body-parser`、`$task.fetch`、`$prefs`、`stash-version`。必须仍有 `policy-descriptor`、`lodash`、`$httpClient`、`$persistentStore`。
- `sub-store-1.min.js` 同样不得含上述宿主适配器，并且必须有 `sing-box` 和 `vmess`。生产者和解析器留在这个包里。
- Node 的 `sub-store.min.js` 必须仍有 `undici` 和 dotenv。`sub-store.bundle.js` 必须仍有 undici 和 shoutrrr 相关文本。

全部 producers、parsers（含 Loon、QX）和 lodash 都保留。不要为了缩小 Surge 包去删这些源文件。

### 热路径

- `backend/src/utils/geo.js`：`getFlag` 的关键词匹配器在模块作用域编译一次。国旗和 ISO 表不再每个节点重建。
- Peggy：`surge.js`、`loon.js`、`qx.js` 里的 grammar 仍是源码。`precompile-peggy.js` 在 `pretest`、`prebench`、`prebundle:esbuild`、`prestart` 时生成 `parsers/peggy/generated/`。该目录在 `.gitignore`。运行时 `getParser()` 加载生成结果，不调用 `peggy.generate`。语法变了要让预编译重新跑，不要手改生成文件。

### 存储

`backend/src/vendor/open-api.js` 的 `persistCache`：Node 上每个顶层 cache 名是一个 pretty JSON 文件（`SUB_STORE_DATA_BASE_PATH` 或 `.` 下的 `${name}.json`）。以 `#` 开头的键在 Node 上写入 `root.json`。只有变了的那一个文件会重写；pretty JSON 与上次相同则跳过。不防抖，因为 Surge 在 `$done()` 时结束，脚本可能立刻再读宿主存储。

### 缓存与全局 TTL

设置项的单位是秒。代码里的 `DEFAULT_*` 是毫秒。`backend/src/utils/bounded-cache.js` 的 `ttlFromSetting`：

- 设置对象里没有该键：用默认毫秒数。
- 键在且数值 `> 0`：秒 × 1000。
- 键在且数值 `<= 0` 或不是有限数：返回 0。0 表示不读也不写。

| 设置 | 缺省 | 管什么 |
| --- | --- | --- |
| `resourceCacheTtl` | 1 小时（`DEFAULT_CACHE_TTL`） | 原始资源缓存，以及订阅/集合/预览的输出缓存 |
| `headersCacheTtl` | 1 分钟（`DEFAULT_HEADERS_CACHE_TTL`） | 资源响应头，以及流量信息 |
| `scriptCacheTtl` | 48 小时（`DEFAULT_SCRIPT_CACHE_TTL`） | 脚本资源缓存、`geo.js` 的 `cache`、共享节点检测结果 |

指纹、内容哈希、节点配置未变，都只是 TTL 窗口内的键。窗口结束就完整重算。缩短 TTL 后，已有条目的有效期会被 `created + 当前 TTL`  cap 住。`noCache`、`noOutputCache`，以及 `settings.outputCache` 为 false/0/off，会跳过输出缓存。命中输出缓存之后，响应转换和 age 加密仍按当次请求执行。

存储键：

- `#sub-store-cached-resource`
- `#sub-store-cached-headers-resource`
- `#sub-store-cached-script-resource`
- `#sub-store-cached-output`
- `#sub-store-cached-check`
- `#sub-store-cached-last-good`（只给 `keep_last`）

`backend/src/utils/cache-shards.js`：序列化后不超过 64 KiB 的映射保持旧的单值布局。更大则迁到 version 1 manifest，每个条目一个键 `` `${storeKey}:v1:${md5(id)}` ``。单值上限 `SHARD_BYTES` = 3 MiB（UTF-8，`TextEncoder`）。超限的单条跳过，不拆块。旧布局仍可读。迁移不延长 TTL。`/api/utils/refresh` 调用各缓存的 `revokeAll()`，并清掉已登记分片。`scriptResourceCache.revokeAll()` 会再清 check 和 last-good；`miscs.js` 里也会分别调用。

同一次运行内的去重不是缓存：

- `backend/src/utils/inflight.js`：preview、download、node-info 在同一个 JS realm 里共享进行中的 Promise。Node 进程里重叠请求可以共享。一次 Surge http-request 冷启动、处理一个请求、在 `$done()` 结束，不能跨独立脚本会话。不要加持久锁。
- `geo.js` 的 `dedup_target` 只在这一次调用里共享进行中的请求。

### geo.js

源码 `scripts/check/geo.js`。公开 URL：

https://raw.githubusercontent.com/ahuai6/Sub-Store-Fork-Dist/main/geo.js

作为 Sub-Store Script Operator 使用，不是独立的 Surge HTTP 脚本。原有参数和输出模板保持兼容。新参数默认关闭。

| 参数 | 行为 |
| --- | --- |
| `cache` | 可选。只有 `scriptCacheTtl > 0` 时才读写 TTL 缓存 |
| `concurrency` | 默认 10，超过 20 按 20。Surge `$httpClient` 上限 |
| `timeout` | 毫秒，默认 5000 |
| `two_phase` | 先做可达性探测，再请求 geo。探测 URL 默认 `http://www.gstatic.com/generate_204`，`reachability_timeout` 默认 1500 毫秒，上限 5000，不重试 |
| `dedup_target` | 同一次调用里，相同 server、port、代理类型共享进行中的请求。凭据不同也可能被归到一起，它不证明出口相同 |
| `time_budget` | 毫秒。用尽后不再启动新节点。未启动的节点保留原名，不把失败写入缓存。安全上限 880000 毫秒（880 秒），给 Surge 900 秒脚本超时留余量。省略、空、0 都是关闭 |
| `keep_last` | 默认关。开启后，失败、超时或被 `time_budget` 跳过时，沿用该节点上次成功结果。成功会覆盖存储。失败不写也不擦。输出不加标记 |
| `keep_last_max_age` | 纯数字是毫秒；也接受 `3600s`、`24h`、`7d`。省略、空、0 表示一直保留到更新的成功或刷新 |

`keep_last` 用与 TTL 缓存相同的 `cacheId`，存在 `#sub-store-cached-last-good`，不受 `scriptCacheTtl` 过期。这是全局 TTL 规则的唯一例外。刷新和 clear-cache 仍会删掉它。

示例：`keep_last=true&keep_last_max_age=7d`。

### 定时任务与 prefetch

`config/Surge-Beta.sgmodule` 保持上游。上游里 `produce` 已经是 `# Sub-Store Produce`。渲染脚本再把 `sync` 改成 `# Sub-Store Sync`，并追加默认关闭的 prefetch。公开模块里三个任务名都以 `#` 开头，Surge 不运行它们。

prefetch 参数都有默认值，安装不用填：

- `prefetch_cron`：`50 */6 * * *`。任务名仍以 `#` 开头时不运行。若任务名启用但 cron 为空，`prefetchDecision` 直接返回，不生成订阅，也不落入 Gist 同步。
- `prefetch_sub`、`prefetch_col`：`off`，表示不选目标，不会去找名为 off 的订阅。真正叫 off 的订阅写成 `%6Fff`，过滤关闭值之后才 URL 解码。
- `prefetch_platform`：`Surge`。

预热写入的是输出缓存，仍随 `resourceCacheTtl` 过期。已安装模块会保留用户保存的参数；更新模块不一定改回新默认值。要应用新默认值就重新安装，或检查任务名是否仍以 `#` 开头。

GitHub 上的每日上游同步和设备上的 Gist/订阅定时同步是两件事。模块默认关闭不会关掉 Dist 的 `sync-upstream`。

## 3. 硬性约束

- 从当前 `origin/main` 开工。保留上游来源和 Git 历史。
- 同步或任何并入上游提交的 PR，必须用 GitHub 的 **Create a merge commit**。禁止 squash，禁止 rebase。原因在第 5 节。普通功能 PR 可以 squash。
- 不 force-push，不删除分支，不添加 `upload-artifact`。Actions artifact 配额已经用尽，发布脚本直接从工作区复制文件。
- 不在本仓库恢复 `push`、`pull_request` 或 `schedule`。自动任务只放在 Dist。`main.yml` 和 `star-history.yml` 是上游文件，不要为了停掉它们而改内容。
- 源文件不删。保留全部 producers、parsers（含 Loon/QX）和 lodash。
- 所有缓存跟随上面的全局 TTL。TTL 为 0 时不读不写。不得因为节点指纹或内容不变而永久复用。唯一例外是用户显式开启的 `geo.js` `keep_last`，而且 refresh 清缓存时一起清。不要给复用结果加标记。
- 发布模块的同步、定时处理、prefetch 默认全部关闭。安装不得要求填写 prefetch 参数。
- `config/Surge-Beta.sgmodule` 保持上游版本。fork 改动只通过渲染脚本套用，并检查可以还原成原文件。
- 用户已明确要求发布 `geo.js`。只发布该源码、`GEO-LICENSE.txt` 和 `GEO-NOTICE.md`。不要扩大公开的私有源码范围。
- 保留 golden snapshots：`backend/src/test/proxy-producers/snapshots/`。性能相关 PR 跑 `pnpm bench`，记录真实收益和开销。基线是 V8 测量，不是 Surge 真机。
- 常规维护、上游同步和修复 PR，在符合这些约束且检查通过后可以直接合并，不必逐个请用户批准（授权记录在 `06fd1578`）。需要用户作决定的取舍再问。见第 6 节。
- 手动工作流由用户在 Dist Actions 点 Run。有权限的 Agent 可以用 `workflow_dispatch` 触发 Dist 工作流；没有权限就请用户点 Run。不要去点本私有仓库里的同名工作流。

## 4. CI 与发布

本私有仓库的 Actions 账单已停止，任务在开始前被拒绝。本仓库的 `publish-dist.yml`、`publish-frontend.yml`、`sync-upstream.yml` 的 `on` 只剩 `workflow_dispatch`。真正执行的文件在 https://github.com/ahuai6/Sub-Store-Fork-Dist 的 `.github/workflows/` 。Dist 用 secret `FORK_REPO_TOKEN` checkout 本仓库，再调用本仓库的脚本。脚本不在 Dist 复制一份。

`FORK_REPO_TOKEN` 建在 **Dist** 的 Actions secrets。它是 fine-grained PAT，资源只选私有的 `ahuai6/Sub-Store-Fork`。权限只开 Contents、Pull requests、Issues、Commit statuses，级别都是 Read and write。Metadata 的 Read 是自带的。不要把这个 token 授给 Dist 仓库本身。Dist 的 `main`、Release 和 `gh-pages` 用工作流自带的 `GITHUB_TOKEN` 推，因此 Dist 的 Actions → General → Workflow permissions 需要 Read and write。本私有仓库上的 `PUBLIC_DIST_TOKEN` 不再被新工作流读取，可以留着。

GitHub cron 是 UTC。台北时间是 UTC+8，无夏令时。

| 工作流 | 触发 | 作用 |
| --- | --- | --- |
| `sync-upstream.yml` | `17 4 * * *`（每天 04:17 UTC，12:17 台北）和 `workflow_dispatch` | 快进私有 `upstream`，合并进 `main`，或开 PR/issue。见第 5 节 |
| `publish-frontend.yml` | `23 5 * * *`（每天 05:23 UTC，13:23 台北）和 `workflow_dispatch`。输入 `force`（boolean，默认 false） | 构建上游前端并推 `gh-pages` |
| `publish-dist.yml` | `47 */3 * * *`（每 3 小时的第 47 分：UTC 00:47、03:47、06:47、09:47、12:47、15:47、18:47、21:47；台北 08:47、11:47、14:47、17:47、20:47、23:47、02:47、05:47）和 `workflow_dispatch`（Dist 这份没有输入） | 检查并发布模块与脚本 |
| `verify-private.yml` | 只有 `workflow_dispatch`。输入 `ref`：私有仓库的分支名或 SHA | 跑与发布相同的检查，不发布 |
| `fork-build.yml` | 只有 `workflow_call`。输入 `ref`、`publish`、`post_status` | 被上两项调用。不要单独 Run |

`publish-dist` 先比较私有 `main` 与 Dist README 里 `Built from` 的 SHA。schedule 只在两者不同时构建。`workflow_dispatch` 即使 SHA 相同也构建。比较脚本是 Dist 的 `.github/scripts/dist_source_sha.py`。推送到私有仓库不会自动启动这次发布。`sync-upstream` 仅在 `backend/package.json` 变化，或重套了 redirect/CORS 补丁时，用 Dist 的 `GITHUB_TOKEN` 再 dispatch 一次 `publish-dist`。其他 main 提交等 schedule。

`publish-frontend` 按 `gh-pages` 的 `frontend-version.txt` 比较 `sha`、`base`（`/Sub-Store-Fork-Dist/`）、`api`（`https://sub.store`）和 `patches`。补丁戳来自 `prepare_frontend_pages.py` 的 `PATCH_STAMP`，当前是 `subpath-routes-1-surge-session-1`。后端合并不会让前端补丁上线。`force=true` 时即使已部署也重建。

`verify-private` 调用 `fork-build`，`publish=false`，`post_status=true`。Dist 的 `.github/scripts/post_fork_status.sh` 在该私有 SHA 上写入提交状态，context 是 `Sub-Store-Fork-Dist/verify`。私有 PR 的检查列表能看到它。token 没有 Commit statuses 写权限时，工作流给出 warning，Actions 运行结果仍在，状态不会出现。私有 PR 不会自动触发这次验证。

`fork-build` 的检查顺序与本仓库 `publish-dist.yml` 相同，实现在 Dist 的 `.github/scripts/run_fork_publish_checks.sh`：

1. `node .github/scripts/apply-fork-frontend.mjs --check`
2. `node .github/scripts/apply-fork-runtime.mjs --check`
3. `backend` 里 `pnpm i --frozen-lockfile`
4. 拉取 mihomo `version.txt`，跑 `.github/scripts/sync_mihomo_version.mjs`
5. `pnpm test`（含 golden snapshots）
6. `python3 -m unittest discover -s .github/scripts -p 'test_render_surge_beta_module.py'`
7. `pnpm bundle:esbuild`
8. `render_surge_beta_module.py --check`，并组装 `public-dist/`：两个 Surge 包、Node 包、`sub-store.bundle.js`、Loon parser、cron、`proxy-utils.esm.mjs`、`runtime-manifest.json`、`geo.js` 与两份说明、`version.txt`、`source-sha.txt`。`upstream-sha.txt` 是 `git merge-base HEAD origin/upstream`，不是“代码里包含的最新上游提交”的别名。squash 会让这一行停在更老的共同祖先。

`publish=true` 时只接受 ref 和 HEAD 都是 `main`，然后跑 `.github/scripts/publish_public_dist.sh`。脚本拒绝把产物推回源仓库。它把模块、`geo.js`、两份说明和 `LICENSE` 推到 Dist `main`，并把构建产物上传到 tag 为 `backend/package.json` version 的 Release。Dist README 的 `Built from` 就是这次的私有 SHA。

前端补丁在 `.github/scripts/prepare_frontend_pages.py`，锚点消失就失败，不会静默跳过：

- Vite base `/Sub-Store-Fork-Dist/`，`VITE_API_URL=https://sub.store`。拒绝 base `/`。
- 子路径下的流量页、关于页链接、复制 API 链接、PWA scope。
- `.github/scripts/fork-frontend/forkRequestGuard.ts`：API 并发最多 2，给 Surge 的 3 个 webview 脚本槽留一个。刷新或恢复后的重型预览要等用户操作。构建后的页面有 `<meta name="sub-store-fork" content="api-cap-2 skip-restored-preview" />`。

本仓库 `main.yml` 仍监听 `master` 的 `backend/package.json`，另有 `workflow_dispatch`。默认分支是 `main`，push 不会跑；账单停止时手动也起不来。`star-history.yml` 仍是上游的每天 `0 0 * * *`（00:00 UTC，08:00 台北）加 `workflow_dispatch`。文件保持与上游一致。账单停止时它同样无法启动。不要在这里改它。

## 5. 上游同步

运行的是 Dist 的 `sync-upstream.yml`。本仓库的同名文件不会按 schedule 启动。

1. checkout 私有 `main`，设置 `github-actions[bot]` 的 `user.name` / `user.email`，然后 `git merge upstream/master`。Runner 上的 Git 没有身份时会立刻 `fatal: empty ident name`，而且写不出冲突索引。
2. 快进私有 `upstream` 到上游 `master`。只镜像 origin 还没有的标签，不移动已有标签。不能快进就失败，不强推。
3. 无冲突时跑 `apply-fork-frontend.mjs`。它只重套两处锚点：`/` 的 302，以及 CORS 默认 origin 里的 `https://ahuai6.github.io`。锚点仍在时它是幂等的。然后 `apply-fork-runtime.mjs --check`。后者只检查标记还在，不会从改写过的上游代码里重建优化。
4. 无冲突、标记还在、并且 `run_fork_publish_checks.sh` 通过时，才推私有 `main`。
5. 有冲突文件时，把上游 tip 推到 `sync/upstream` 并开 PR，标题是 `sync: resolve upstream merge conflicts`。该分支的 head 是未改过的上游提交。冲突路径用 `git ls-files -u`。
6. merge 在写出任何冲突之前失败时开 issue，不开一份冲突列表为空的 PR。
7. 检查失败时，把合并结果推到 `sync/tests-failed` 并开 PR。不是快进则不强推，改开 issue。
8. 补丁锚点对不上则开 issue，不推 `main`。

常见冲突文件：

- `backend/src/restful/miscs.js`：保留 fork 的 `https://ahuai6.github.io/Sub-Store-Fork-Dist/`。保留上游新增的 `DEFAULT_FRONTEND_URL` 文案。
- `backend/src/utils/cors.js`：默认 origin 用上游列表，再保留 `https://ahuai6.github.io`。不要丢掉上游新加的 origin。
- `backend/src/test/vendor/express-cors.spec.js`：断言继续引用 `NON_NODE_CORS_DEFAULT`，让测试跟着合并后的列表走。

还必须留下的 fork 行为见 `apply-fork-runtime.mjs` 的 `need()` 列表，以及 `docs/fork-maintenance.md` 的「必须保留的 fork 修改」表。核心是：Pages 302 与 CORS、前端补丁锚点、请求去重、输出缓存、检测缓存、分片、`keep_last`、getFlag 与 Peggy 预编译、file 路由在 sub-store-1、按文件写 store、Surge-only 构建、模块渲染默认关闭任务。

### 为什么同步 PR 必须用 merge commit

每日同步用 `git merge` 判断上游 tip 是不是 `main` 的祖先。squash 或 rebase 只留一个父提交，文件内容虽然在，上游提交却不是祖先，下一次 schedule 会在同样的三个文件上再次冲突。

2026-11-13 的实际顺序：

- PR #12：identity 未设置，冲突列表是空的。head 是未改上游 `196a6d56`。已关闭，未合并。不要把这种 head 合进 `main`，那会丢掉 fork 修改。
- PR #13：人工解决了 2.44.11 的三文件冲突，并修好空白冲突报告。它被 squash 到 `85a458ab`。该提交只有一个父提交 `06544218`，所以上游 `d9896398` 不是祖先。
- PR #15：下一次同步因此又开了冲突 PR。head 仍是未改上游 `d9896398`，冲突文件还是那三个。
- PR #16：用 `git merge -s ours --no-ff d9896398` 得到 `5222fc28`。父提交是 `85a458ab` 和 `d9896398`，树与 `85a458ab` 相同，没有改源码。然后用 **Create a merge commit** 把这条历史合进 `main`（`7d4d0c41`）。这样 `d9896398` 才成为 `main` 的祖先。#15 随后被标成已合并，因为它的 head 经这条历史变得可达，不是因为有人在 #15 上解决了冲突。

以后：

- `sync/*`，或任何带有上游提交的 PR，用 Create a merge commit。
- 若 squash 已经发生，用 `git merge -s ours` 把上游 tip 记成祖先，并再以 merge commit 合入。不要为了“树已经一样”就 squash 这次补救。
- 不要 merge 一个 head 等于未改上游的 `sync/upstream` PR，除非冲突已经在该分支上解决，并且合并方式是 merge commit。

处理冲突的逐步清单在 `docs/fork-maintenance.md` 的「收到上游同步 PR 后的处理流程」。摘要：看上游范围和冲突文件；保留上表语义；跑两个 apply 脚本；跑第 6 节的检查；PR 说明里写清取舍；用 `verify-private` 验证 head；用 merge commit 合并；需要马上给 Surge 用就到 Dist Run `publish-dist`。

## 6. PR 审查与合并

本地环境用 `.node-version` 的 Node 和 `pnpm@11.0.9`。在 `backend/`：

```bash
corepack enable
corepack prepare pnpm@11.0.9 --activate
pnpm i --frozen-lockfile
pnpm test
```

`pnpm test` 含 golden snapshots。2026-11-13 在 Node 24.22.1、pnpm 11.0.9 上是 **1020 passing**。数量会随上游测试增加。以当次输出为准，不要为了凑数改断言或重写快照。快照只有在上游生产者行为确实变了、并且你核对过 fixture 不该变时才更新，并在 PR 里说明。

模块渲染：

```bash
python3 -m unittest discover -s .github/scripts -p 'test_render_surge_beta_module.py'
```

当前 6 个测试。然后：

```bash
node .github/scripts/apply-fork-frontend.mjs --check
node .github/scripts/apply-fork-runtime.mjs --check
cd backend && pnpm bundle:esbuild
python3 .github/scripts/render_surge_beta_module.py --check \
  --public-repo ahuai6/Sub-Store-Fork-Dist \
  --output /tmp/Surge-Beta.sgmodule
```

体积检查就是 `assertSurgeOnlyBundles()` 的标记存在/不存在，不是字节数门槛。前端改动还要确认 `prepare_frontend_pages.py` 的锚点和 `PATCH_STAMP`。性能改动跑 `cd backend && pnpm bench`，对照 `backend/bench/baseline.json`，写上收益和开销。Node 版本不同会让冷启动数字漂移，不要把换 Node 当成优化结果。

私有 PR 没有自动 CI。到 Dist Actions 运行 `verify-private`，`ref` 填分支名或 head SHA。通过后该 SHA 上应有 `Sub-Store-Fork-Dist/verify` 成功状态。可以用：

```bash
gh api repos/ahuai6/Sub-Store-Fork/commits/<SHA>/statuses
```

看 `context` 为 `Sub-Store-Fork-Dist/verify` 的条目。没有权限触发时，请用户点 Run，不要改用本私有仓库的工作流。

可以直接合并：符合第 3 节、检查和 `verify-private` 都过了的常规维护、上游同步和修复。同步类必须是 merge commit。合并后保留分支。

先问用户：

- 扩大公开源码、改许可证处理方式、或删改 `GEO-NOTICE.md` 里尚未定性的上游额外条款。
- 新增缓存，或让指纹在 TTL 之外继续生效。`keep_last` 以外的永久缓存不要加。
- 把 sync、produce、prefetch 改成默认开启，或让安装必须填写参数。
- force-push、删分支、`upload-artifact`、在本仓库加回自动触发、改 `star-history.yml`。
- 合并 head 仍是未改上游的 `sync/upstream`。
- 行为取舍会影响已安装 Surge 模块或用户数据，而且不能靠重新安装模块解释清楚。

合并进 `main` 之后，私有 SHA 变了。Dist 的 `publish-dist` schedule 会在数小时内发布。模块、脚本或 `geo.js` 有用户可见变化时，马上到 Dist Run `publish-dist`，并提醒用户在 Surge 里更新模块、刷新脚本。已保存的模块参数可能还在，必要时重新安装。只改文档时，schedule 仍会因为 SHA 不同而重发一份构建；构建内容不变就不必催用户更新模块。需要前端时单独 Run `publish-frontend`，并说明原因。发布后核对 Dist README 的 `Built from`、Release 资产，以及模块里的脚本主机是 `ahuai6/Sub-Store-Fork-Dist`。

本 agent 无法在对话之外持续盯 GitHub。后续同步 PR 需要有人再次唤起。

## 7. 二次开发

功能加在现有边界上：

- Surge HTTP API：按路由放进 `sub-store-0` 或 `sub-store-1`。解析器、文件和重型下载留在 sub-store-1。简单包不要 import ProxyUtils。
- 新的宿主专用语句放进 `@non-surge-start` / `@non-surge-end`，让 Surge 包剥掉，Node 和其他产物留着。
- 新的导出格式加 producer，并给 `golden-snapshot.spec.js` 的 `TARGETS` 补快照。不要删 Loon、QX 或其他格式。
- 模块的公开 URL、CORS、路由和定时任务默认值改 `render_surge_beta_module.py`，并保证 `--check` 能把公开模块还原成 `config/Surge-Beta.sgmodule`。
- 前端行为改 `prepare_frontend_pages.py` 和 `fork-frontend/`。改了行为就改 `PATCH_STAMP`，否则 `publish-frontend` 会认为已经部署。
- 运行时优化要在 `apply-fork-runtime.mjs` 加一个稳定标记，让下一次干净合并丢了它时同步会停。

缓存接到 `ttlFromSetting`。0 不读不写。刷新路径调用 `revokeAll()`，分片用 `CacheShards`。不要用节点指纹当永久跳过条件。

测试放在 `backend/src/test/**/*.spec.js`，mocha + chai，`@babel/register`。`package.json` 的 `test` 脚本已经设置 `SUB_STORE_FRONTEND_BACKEND_PATH=/`。Peggy 语法改动靠 `pretest` 重新生成。geo 行为放在 `backend/src/test/scripts/geo-optimized.spec.js`，对照 `backend/src/test/fixtures/geo.upstream.js` 的原契约。

发布物路径：

- 模块：https://raw.githubusercontent.com/ahuai6/Sub-Store-Fork-Dist/main/Surge-Beta.sgmodule
- 同一文件的 Release：https://github.com/ahuai6/Sub-Store-Fork-Dist/releases/latest/download/Surge-Beta.sgmodule
- 脚本：`releases/latest/download/` 下的 `sub-store-0.min.js`、`sub-store-1.min.js`、`cron-sync-artifacts.min.js`，以及 Node 包、parser、`proxy-utils.esm.mjs`、`runtime-manifest.json`
- `geo.js`：Dist `main` 和 Release 各一份
- 前端：https://ahuai6.github.io/Sub-Store-Fork-Dist/

## 8. 已知风险与待办

- `geo.js` 的许可证没有完全收口。`GEO-NOTICE.md` 记录上游仓库 `xream/scripts` 在 `49248e431b1ebb3f55b6d384a25582f74cde8207` 的 GPL-3.0，同时记录该 README 里的额外免责、使用限制和 24 小时删除要求。这些文字和 GPL 同时存在，法律解释没有被认定。发布是仓库所有者在 2026-11-13 明确要求的。不要扩大公开源码，不要删掉 notice。
- 设置接口目前写不进 TTL 0。`ttlFromSetting` 只在键存在且 `<= 0` 时关闭缓存。`backend/src/restful/settings.js` 的 `updateSettings` 会把 `resourceCacheTtl`、`headersCacheTtl`、`scriptCacheTtl` 的非正数删掉。键被删掉之后等于未设置，缓存回到 1 小时、1 分钟、48 小时。测试是直接把 0 写进 store。不要把“在设置里填 0”写成已经能关闭缓存。若要让接口保留 0，那是行为变更，先问用户。
- PR #12 已关闭、未合并。不要重新打开并合并它的上游 head。`sync/upstream` 分支保留，以后的同步可能再次使用它。
- Dist 的 `Built from` 在 squash 之后会落后于真实包含的上游内容。写本文时 Dist README 和 Release `2.44.11` 的 `Built from` 是 `85a458aba7b787d31ec2a554fcc995333525ba30`，`Upstream tree` 是 `091e6f8d8c2dcec8c1d8e792ecee4304935d6e90`。私有 `main` 已是 `7d4d0c410254c69b2861312a9bc03c2065b961de`，`origin/upstream` 是 `d9896398feeb55c42fa3bd15f70104dd02b13899`。下一次 `publish-dist` 会因为 SHA 不同而重发，并把 `Upstream tree` 记成当时的 `git merge-base`。这些 SHA 会过期，以 Dist README 为准。
- 写本文时 `gh-pages` 的 `frontend-version.txt` 是前端 `2.34.3`、sha `59632bfcba5193fcf213b545e025252007ca15aa`、`patches=subpath-routes-1-surge-session-1`、base `/Sub-Store-Fork-Dist/`、api `https://sub.store`。实时首页含 `<meta name="sub-store-fork" content="api-cap-2 skip-restored-preview" />`。`docs/performance-plan-audit.md` 里“补丁尚未部署”的句子已经过时。
- 前端默认 API 超时在上游是 50000 毫秒，可被 `localStorage.apiRequestTimeout` 覆盖。浏览器超时不会停掉已经在跑的 Surge 脚本。`time_budget` 要留在这个超时之内，或让用户把前端超时调大。
- `dedup_target` 按 server、port、类型合并，凭据不同也可能共享。它不是出口 IP 的证明。
- 分片解决单值约 4 MB 的 iOS 限制，不保证设备总空间够用。
- Surge 真机安装、TestFlight 和模块参数是否残留，不能在这个仓库的测试里证实。
- `star-history.yml` 的每日 schedule 仍在文件里。停掉它是未决定的可选项，不是功能修复。

## 9. 变更历史（PR #5–#16）

- **#5** 合并：golden snapshots、可重复 bench、同一次运行内的 preview/download/node-info 去重、刷新后不叠加重型预览、优化 `geo.js`、脚本资源缓存批量写。
- **#6** 合并：输出缓存跟随 `resourceCacheTtl`；节点检测结果在 `scriptCacheTtl` 内共享；prefetch cron 默认不跑。
- **#7** 合并：`getFlag` 只编译一次；Peggy 预编译；file 路由移到 sub-store-1；Node 按文件写 store，内容不变则跳过。
- **#8** 合并：只对 `sub-store-0` 和 `sub-store-1` 做 Surge-only 构建。
- **#9** 合并：分片缓存、全局 TTL 审计、Surge 模块参数语法修复，并按要求发布 `geo.js`。
- **#10** 合并：sync、produce、prefetch 默认关闭，prefetch 参数都有默认值。同时记录了“常规已验证 PR 可直接合并”的授权。
- **#11** 合并：可选 `keep_last` / `keep_last_max_age`，默认关，不打标记，刷新仍清除。
- **#12** 关闭，未合并：空白冲突列表。head 是未改上游 `196a6d56`。被 #13 取代。
- **#13** squash 合并：解决上游 2.44.11 的三文件冲突，并让同步在设置 git identity 之后才 merge。squash 丢掉了 `d9896398` 的祖先关系。
- **#14** 合并：私有仓库自动 Actions 停用，构建、验证、发布和同步改由 Dist 执行。
- **#15** 标成已合并：squash 之后每日同步再次冲突。head 是未改上游 `d9896398`。它是在 #16 把该提交记成祖先之后才变成已合并。
- **#16** 用 merge commit 合并：`merge -s ours` 记录 `d9896398` 已合并，并写明同步 PR 必须用 merge commit。
