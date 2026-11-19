# 持续同步与二次开发维护说明

本仓库的职责是跟随 Sub-Store 上游，同时保留 Surge iOS 使用场景需要的修改。
不要把一次无冲突 Git 合并等同于兼容性验证完成。

给新 agent 的完整交接在根目录 `AGENTS.md`。本文保留同步、发布和冲突处理的操作细节。两处不一致时，以 `AGENTS.md` 和当前代码为准，并改掉过时的一边。

## 仓库与发布关系

| 位置 | 职责 |
| --- | --- |
| `sub-store-org/Sub-Store` 的 `master` | 后端上游来源 |
| `upstream` | 上游原样镜像，只允许快进，不放 fork 改动 |
| `main` | 上游代码 + 已审核的 fork 修改 |
| `sync/upstream` | 冲突时的同步 PR 分支，已有解决提交时不强推 |
| `sync/tests-failed` | 合并无冲突但发布检查失败时的 PR 分支，不强推 |
| `dist/Surge-Beta.sgmodule` | Surge 安装用的模块。raw 与 Release 各一份 |
| `scripts/check/geo.js` | Script Operator。许可证和来源说明在同目录 |
| GitHub Release | 构建产物。tag 等于 `backend/package.json` 的 version |
| `gh-pages` | 从独立前端上游构建的页面，不是后端源码目录 |

CI、发布、前端和上游同步都在本仓库执行，用 `GITHUB_TOKEN`（`contents: write`，同步还要 pull requests、actions；仓库保持关闭 Issues）。不使用 `FORK_REPO_TOKEN` 或 `PUBLIC_DIST_TOKEN`。发布走 `publish_public_dist.sh` 和 `publish_frontend_pages.sh`。不上传 Actions artifact，不强推，不删分支。

仓库已于 2026-11-15 公开。`ci.yml` 在 push 到 `main` 和 pull request 上自动跑。安全设置和提交身份见下文「令牌与仓库安全」。`main.yml` 只监听 `master`，并且会 force-push `release` 分支，不要运行。`star-history.yml` 仍有每日 schedule，文件保持与上游一致，不在这里改。

时间表见 `AGENTS.md` 第 4 节：`sync-upstream` 每天 04:17 UTC，`publish-frontend` 每天 05:23 UTC，`publish-dist` 每 3 小时的第 47 分。`publish-dist` 的 schedule 只在 `HEAD` 与最新 Release 说明里的 `Built from` 不同时构建。手动 Run 即使 SHA 相同也构建。`publish-frontend` 按 `gh-pages` 上 `frontend-version.txt` 的 sha、base（`/Sub-Store-Fork/`）、api 和 patches 决定是否跳过。Pages 源是 `gh-pages` 的 `/`。

公开链接与 `AGENTS.md` 第 1 节相同：模块 https://raw.githubusercontent.com/ahuai6/Sub-Store-Fork/main/dist/Surge-Beta.sgmodule ；脚本 https://github.com/ahuai6/Sub-Store-Fork/releases/latest/download/ ；`geo.js` https://raw.githubusercontent.com/ahuai6/Sub-Store-Fork/main/scripts/check/geo.js ；前端 https://ahuai6.github.io/Sub-Store-Fork/ 。

`ahuai6/Sub-Store-Fork-Dist` 已由用户删除。不要再对它做 checkout、dispatch、发布或读取 secret。

## Surge 模块默认值

发布模块的 `sync`、`produce`、`prefetch` 三个定时任务名均以 `#` 开头，默认关闭。
安装时不需要用户输入任何 prefetch 字段：

- `prefetch_cron` 有合法默认时间 `50 */6 * * *`；任务名关闭时不会运行。
- `prefetch_sub`、`prefetch_col` 默认 `off`，表示不选择任何目标，不会去找名为 off 的订阅。
- 需要预跑时，只启用 prefetch 任务名并填写想处理的目标；不用的另一项保留 off。
- 如果实际订阅名称恰好是 off，可以在此字段填 `%6Fff`；过滤关闭值后才 URL 解码。
- 原有用户手动 API 同步仍可使用；模块默认值不会强行覆盖已安装模块中用户保存的配置。
  若旧模块已经启用 sync，更新后应检查该任务名，或重新安装以应用新默认值。

GitHub 每日上游同步与设备上的订阅/Gist 定时同步是两件事，模块默认关闭不关闭 GitHub 定时任务。

## 每日上游同步：当前行为

运行的文件是本仓库的 `.github/workflows/sync-upstream.yml`，每天 **04:17 UTC**。
它在 `git merge` 之前设置 `github-actions[bot]` 的 `user.name` / `user.email`。
没有身份时，runner 上的 git 会以 `fatal: empty ident name` 立刻失败，并且列不出冲突文件。冲突路径用 `git ls-files -u` 列出。合并在写出任何冲突之前失败时写入 Actions Job Summary 并以错误退出，不开一份空白冲突 PR。

1. 取上游 master，将 `upstream` 分支快进；只镜像 origin 尚无的标签，不移动已有标签。
2. 尝试合并到 main。无冲突时重套 URL/CORS，并检查运行时 fork 标记。上游模块变了就刷新 `dist/Surge-Beta.sgmodule`。
3. 无冲突、fork 标记仍在，且与 publish-dist 相同的检查通过时，才推 main。
   检查包括 fork 脚本 `--check`、`pnpm test`（含 golden snapshots）、模块
   renderer 的 Python 回归、`pnpm bundle:esbuild` 和 renderer `--check`。
   冲突时把上游 tip 推到 `sync/upstream` 并开 PR。检查失败时把合并结果推到
   `sync/tests-failed` 并开 PR。两条分支都不是快进时不强推，改为评论已有 PR（若存在）、写入 Actions Job Summary 并以错误退出。
   缺少 fork 标记会停止，写入 Actions Job Summary 并以错误退出，不推 main。这并不是“每次更新都先提 PR”。
4. 用 `GITHUB_TOKEN` 推上去的提交不会启动 `push` 工作流。sync 仅在
   `backend/package.json` 变化、重套 fork 补丁，或刷新了已提交模块时，再
   dispatch `publish-dist`。其他 main 提交由 publish-dist 的 schedule 在 SHA
   变化后发布。不要把“每日取上游”和“每日必须发布”混成一件事。

同步 PR 合入 `main` 时必须使用 merge commit。规则见下文「收到上游同步 PR 后的处理流程」。

有权限的 Agent 可以用 `workflow_dispatch` 触发本仓库的工作流；没有权限就请用户点 Run。用户把同步 PR 或失败链接发来后，可以在对话内继续处理。

## 令牌与仓库安全

发布、推 `gh-pages`、同步和开 PR 都用工作流里的 `GITHUB_TOKEN`。`FORK_REPO_TOKEN` 和 `PUBLIC_DIST_TOKEN` 不再使用。

- 写权限只有用户一人。
- `main` 规则集禁止 force push 和删除分支，但不要求必须通过 PR 才能推 `main`。否则 `sync-upstream` 直推 `main` 会失败。
- 来自 fork 的 pull request 工作流需要批准后才运行。
- Actions → General → Workflow permissions 必须是 Read and write。
- 已开启 secret scanning 和 push protection。
- 提交作者邮箱使用 `117343258+ahuai6@users.noreply.github.com`。公开前的全历史敏感信息扫描结论干净。仅 4 个提交的作者字段含个人邮箱，不改写历史。禁止提交令牌、订阅链接或真实节点。

| 工作流权限 | 用途 |
| --- | --- |
| Contents: write | 推 `main`、`upstream`、标签、PR 分支、`gh-pages`，以及创建 Release |
| Pull requests: write | sync 开、评论、关闭 PR |
| Actions: write | sync dispatch `publish-dist` |

## 必须保留的 fork 修改

| 区域 | 要保留的行为 |
| --- | --- |
| 页面与 CORS | 非 Node `/` 指向 `https://ahuai6.github.io/Sub-Store-Fork/`；默认 origin 含 `https://ahuai6.github.io` |
| 前端构建补丁 | Pages 子路径 `/Sub-Store-Fork/` 与 PWA；API 并发最多 2；刷新/恢复后重型预览等用户操作再开始 |
| 请求去重 | preview/download/node-info 同 realm 内共享；不能声称跨 Surge 独立脚本会话共享 |
| 输出缓存 | `resourceCacheTtl`，相关 noCache/noOutputCache，过期完整重算，响应转换和加密正常运行 |
| 检测与脚本缓存 | `scriptCacheTtl`；geo 的 cache 关闭后重测；仅运行中的请求可共享 |
| 资源与流量头缓存 | 各自全局 TTL，0 禁用读写；新条目跟随缩短后的有效期 |
| 存储分片 | 旧布局可读；迁移不延长 TTL；单值按 UTF-8 计数；clear-cache 清所有已登记分片 |
| geo operator | 参数/格式兼容，20 并发、预算控制、可选两阶段与目标去重；`keep_last` 默认关闭，开启后失败才沿用上次成功，且该存储不受 `scriptCacheTtl` 过期，刷新仍清除；随许可证和来源说明发布 |
| 编译与冷启动 | getFlag 匹配器只编译一次；Peggy 预编译，语法源保留；sub-store-0 不引入 ProxyUtils |
| 路由和写入 | file 路由在 sub-store-1，模块匹配同步；Node 单文件写入，脚本缓存批量 flush |
| Surge 构建开关 | 仅 Surge 两个 bundle 剥离其他宿主适配器；完整保留其他格式导出与其他宿主源码 |
| 模块生成 | 上游原文件不动；公开 URL、CORS、路由、默认关闭任务和参数由 renderer 重套、检查，并写入 `dist/Surge-Beta.sgmodule` |
| 发布 | Release 只上传明确列出的资产，不打包整个目录，不上传 Actions artifact，不推 `main` |

## 收到上游同步 PR 后的处理流程

1. 读取 PR、上游提交范围、冲突文件、CI 和 release/version 变更。以实际 main 为基准，保留用户提交。
2. 检查上表相关文件是否改动。人工解决冲突，使用普通 merge/commit，保留上游更新与 fork 语义。
   `parsers/peggy/surge.js` 再冲突时：保留上游语法和 fork 的预编译导入，`getParser()` 传入 `setSurgeXhttpOption`，不要恢复 `peggy.generate`。见 `AGENTS.md` 第 5 节。PR #19 按此解决了上游 2.44.12–2.44.14。
3. 运行 `node .github/scripts/apply-fork-frontend.mjs` 和
   `node .github/scripts/apply-fork-runtime.mjs --check`。前者能重套具体锚点，后者是保护检查，
   不会从任意重写后的上游代码中自动重建全部优化。
4. 在 backend 按 pinned pnpm/Node 安装 lockfile、运行适用测试和完整 `pnpm test`。
   golden snapshots 必须保留；性能相关改动跑前后 `pnpm bench`。
5. `pnpm bundle:esbuild`；运行模块 Python 回归测试和 renderer `--check`。
   `dist/Surge-Beta.sgmodule` 必须与渲染输出一致。
   前端变化还要验证 prepare_frontend_pages.py 补丁锚点、构建产物和 patch stamp。
6. PR 描述写明上游范围、冲突取舍、fork 保留情况、验证和手动升级事项。
   仓库已公开，`ci.yml` 会在 PR 上跑同样的检查。本地检查仍然要跑。
   确认符合既定约束后可直接合并；用户已授权常规 PR 无需逐个批准。确需用户作决定的重要取舍再确认。保留分支。
   上游同步 PR（`sync/*`，或任何并入上游提交的 PR）必须用 “Create a merge commit”
   合并，不要 squash，也不要 rebase。否则上游 ancestry 丢失，这些提交不再是
   `main` 的祖先，每日同步会在相同文件上再次冲突。
7. 合并后 main 的 SHA 变了。`publish-dist` 的 schedule 会在数小时内发布；
   要马上发布就手动 Run `publish-dist`。核对模块、geo 和 Release 说明里的
   `Built from`。需要前端时手动 Run `publish-frontend`，并说明原因。

已有项目约定见根目录 `AGENTS.md`。历史性能与兼容性核对见 `performance-plan-audit.md`。
