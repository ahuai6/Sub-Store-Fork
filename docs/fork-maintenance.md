# 持续同步与二次开发维护说明

本仓库的职责是跟随 Sub-Store 上游，同时保留 Surge iOS 使用场景需要的修改。
不要把一次无冲突 Git 合并等同于兼容性验证完成。

## 仓库与发布关系

| 位置 | 职责 |
| --- | --- |
| `sub-store-org/Sub-Store` 的 `master` | 后端上游来源 |
| 私有 `ahuai6/Sub-Store-Fork` 的 `upstream` | 上游原样镜像，只允许快进，不放 fork 改动 |
| 私有仓库 `main` | 上游代码 + 已审核的 fork 修改 |
| 私有仓库 `sync/upstream` | 冲突时的同步 PR 分支，已有解决提交时不强推 |
| 私有仓库 `sync/tests-failed` | 合并无冲突但 publish-dist 同款检查失败时的 PR 分支，不强推 |
| `ahuai6/Sub-Store-Fork-Dist` 的 `main` 和 Release | 公开模块、构建产物、用户明确要求发布的 geo.js 及其来源/许可证 |
| Dist 的 `gh-pages` | 从独立前端上游构建的页面，不是本仓库后端的源码目录 |
| Dist 的 Actions | 实际执行 publish-dist、publish-frontend、sync-upstream、verify-private |

本私有仓库的 Actions 账单已停止，任务在开始前被拒绝。构建、发布、上游同步和
PR 验证都改由公开仓库 `ahuai6/Sub-Store-Fork-Dist` 执行。Dist 用仓库 secret
`FORK_REPO_TOKEN` checkout 本仓库，再调用本仓库的脚本。脚本仍以本仓库为唯一
来源，不在 Dist 复制一份。发布仍走 `publish_public_dist.sh` 和
`publish_frontend_pages.sh`，不扩大公开的私有源码范围，不上传 Actions artifact，
不强推，不删分支。

本仓库里的 `publish-dist.yml`、`publish-frontend.yml`、`sync-upstream.yml`
保留，但 `on` 只剩 `workflow_dispatch`。不要把自动触发加回来。上游的
`main.yml` 只监听 `master`，本仓库默认分支是 `main`，不会跑。上游的
`star-history.yml` 仍有每日 schedule，文件保持与上游一致，不在这里改；账单
停止时它同样无法启动。

Dist 的时间表：

| 工作流 | 触发 |
| --- | --- |
| `sync-upstream` | 每天 04:17 UTC，外加 workflow_dispatch |
| `publish-frontend` | 每天 05:23 UTC，外加 workflow_dispatch |
| `publish-dist` | 每 3 小时的第 47 分（`47 */3 * * *`），外加 workflow_dispatch |
| `verify-private` | 只有 workflow_dispatch，输入私有分支名或 SHA |

`publish-dist` 的 schedule 只在私有 `main` 的 SHA 与 Dist `main` 上 README
版本表里的 `Built from` 不同时才构建。那一行就是现有的版本记录，由
`publish_public_dist.sh` 在发布时写上。手动 Run 会构建，即使 SHA 相同。
`publish-frontend` 仍按 `gh-pages` 上 `frontend-version.txt` 的 sha、base、
api 和 patches 决定是否跳过。后端合并不会自动让前端补丁上线。

`verify-private` 跑与 publish-dist 相同的检查，不发布。token 若有 Commit
statuses 写权限，会在该 SHA 上写入提交状态 `Sub-Store-Fork-Dist/verify`，
私有 PR 的检查列表能看到它。私有 PR 不会自动触发这次验证，需要到 Dist 的
Actions 里手动 Run。没有该权限时，工作流给出警告，Actions 运行结果仍在。

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

运行的文件是 Dist 的 `.github/workflows/sync-upstream.yml`，每天 **04:17 UTC**。
本仓库里的同名文件不再按 schedule 启动。Dist 那份在 `git merge` 之前设置
`github-actions[bot]` 的 `user.name` / `user.email`。没有身份时，runner 上的
git 会以 `fatal: empty ident name` 立刻失败，并且列不出冲突文件。冲突路径用
`git ls-files -u` 列出。合并在写出任何冲突之前失败时开 issue，不开一份空白
冲突 PR。

1. 取上游 master，将私有 `upstream` 分支快进；只镜像 origin 尚无的标签，不移动已有标签。
2. 尝试合并到私有 main。无冲突时重套 URL/CORS，并检查运行时 fork 标记。
3. 无冲突、fork 标记仍在，且与 publish-dist 相同的检查通过时，才推私有 main。
   检查包括 fork 脚本 `--check`、`pnpm test`（含 golden snapshots）、模块
   renderer 的 Python 回归、`pnpm bundle:esbuild` 和 renderer `--check`。
   冲突时把上游 tip 推到 `sync/upstream` 并开 PR。检查失败时把合并结果推到
   `sync/tests-failed` 并开 PR。两条分支都不是快进时不强推，改为开 issue。
   缺少 fork 标记会停止并开 issue，不推 main。这并不是“每次更新都先提 PR”。
4. 推送到私有仓库不会启动 Dist 的发布。sync 仅在 `backend/package.json` 变化
   或重套 fork 补丁提交时，用 Dist 自己的 `GITHUB_TOKEN` dispatch Dist 的
   `publish-dist`。其他 main 提交由 publish-dist 的 schedule 在 SHA 变化后发布。
   不要把“每日取上游”和“每日必须发布”混成一件事。

同步 PR 合入 `main` 时必须使用 merge commit。规则见下文「收到上游同步 PR 后的处理流程」。

手动 workflow_dispatch 由用户操作。CI 内既有的自动调用属于工作流逻辑，不能被误当作
助手可以自行点击 Run 的授权。用户把同步 PR 或失败链接发来后，可以在对话内继续处理。

## Dist 上的 `FORK_REPO_TOKEN`

Secret 建在 **`ahuai6/Sub-Store-Fork-Dist`** 的 Actions secrets，名字必须是
`FORK_REPO_TOKEN`。它是 fine-grained PAT，资源只选私有的 `ahuai6/Sub-Store-Fork`。
权限只开这四项，其余保持 No access：

| 权限 | 级别 | 用途 |
| --- | --- | --- |
| Contents | Read and write | checkout，以及 sync 推 main、`upstream`、标签和 PR 分支 |
| Pull requests | Read and write | sync 开、评论、关闭私有 PR |
| Issues | Read and write | 补丁对不上或无法快进时开 issue |
| Commit statuses | Read and write | `verify-private` 写 `Sub-Store-Fork-Dist/verify` |

Metadata 的 Read 是 fine-grained PAT 自带的，不用改。这个 token 不要授予 Dist
仓库。Dist 的 `main`、Release 和 `gh-pages` 由工作流自带的 `GITHUB_TOKEN` 推送，
因此 Dist 的 Actions → General → Workflow permissions 需要 Read and write。
不再使用本私有仓库上的 `PUBLIC_DIST_TOKEN` 来发布；那个 secret 可以留着，新工作流不读它。

## 必须保留的 fork 修改

| 区域 | 要保留的行为 |
| --- | --- |
| 页面与 CORS | 非 Node `/` 指向 Dist Pages；默认 origin 含 `https://ahuai6.github.io` |
| 前端构建补丁 | Pages 子路径/PWA；API 并发最多 2；刷新/恢复后重型预览等用户操作再开始 |
| 请求去重 | preview/download/node-info 同 realm 内共享；不能声称跨 Surge 独立脚本会话共享 |
| 输出缓存 | `resourceCacheTtl`，相关 noCache/noOutputCache，过期完整重算，响应转换和加密正常运行 |
| 检测与脚本缓存 | `scriptCacheTtl`；geo 的 cache 关闭后重测；仅运行中的请求可共享 |
| 资源与流量头缓存 | 各自全局 TTL，0 禁用读写；新条目跟随缩短后的有效期 |
| 存储分片 | 旧布局可读；迁移不延长 TTL；单值按 UTF-8 计数；clear-cache 清所有已登记分片 |
| geo operator | 参数/格式兼容，20 并发、预算控制、可选两阶段与目标去重；`keep_last` 默认关闭，开启后失败才沿用上次成功，且该存储不受 `scriptCacheTtl` 过期，刷新仍清除；随许可证和来源说明发布 |
| 编译与冷启动 | getFlag 匹配器只编译一次；Peggy 预编译，语法源保留；sub-store-0 不引入 ProxyUtils |
| 路由和写入 | file 路由在 sub-store-1，模块匹配同步；Node 单文件写入，脚本缓存批量 flush |
| Surge 构建开关 | 仅 Surge 两个 bundle 剥离其他宿主适配器；完整保留其他格式导出与其他宿主源码 |
| 模块生成 | 上游原文件不动；公开 URL、CORS、路由、默认关闭任务和参数由 renderer 重套、检查 |
| 发布 | 明确复制产物，不打包整个私有目录，不上传 Actions artifact |

## 收到上游同步 PR 后的处理流程

1. 读取 PR、上游提交范围、冲突文件、CI 和 release/version 变更。以实际 main 为基准，保留用户提交。
2. 检查上表相关文件是否改动。人工解决冲突，使用普通 merge/commit，保留上游更新与 fork 语义。
3. 运行 `node .github/scripts/apply-fork-frontend.mjs` 和
   `node .github/scripts/apply-fork-runtime.mjs --check`。前者能重套具体锚点，后者是保护检查，
   不会从任意重写后的上游代码中自动重建全部优化。
4. 在 backend 按 pinned pnpm/Node 安装 lockfile、运行适用测试和完整 `pnpm test`。
   golden snapshots 必须保留；性能相关改动跑前后 `pnpm bench`。
5. `pnpm bundle:esbuild`；运行模块 Python 回归测试和 renderer `--check`。
   前端变化还要验证 prepare_frontend_pages.py 补丁锚点、构建产物和 patch stamp。
6. PR 描述写明上游范围、冲突取舍、fork 保留情况、验证和手动升级事项。
   私有 PR 不会自动跑检查。到 Dist Actions 手动运行 `verify-private`，输入该
   PR 的分支或 head SHA。通过后，该 SHA 上出现提交状态
   `Sub-Store-Fork-Dist/verify`。确认符合既定约束后可直接合并；用户已授权常规
   PR 无需逐个批准。确需用户作决定的重要取舍再确认。保留分支。
   上游同步 PR（`sync/*`，或任何并入上游提交的 PR）必须用 “Create a merge commit”
   合并，不要 squash，也不要 rebase。否则上游 ancestry 丢失，这些提交不再是
   `main` 的祖先，每日同步会在相同文件上再次冲突。
7. 合并后私有 main 的 SHA 变了。Dist 的 publish-dist schedule 会在数小时内发布；
   要马上发布就手动 Run `publish-dist`。核对公开 module/geo 内容和 release 的
   source SHA。需要前端时手动 Run `publish-frontend`，并说明原因。

已有项目约定见根目录 `AGENTS.md`。历史性能与兼容性核对见 `performance-plan-audit.md`。
