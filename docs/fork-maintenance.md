# 持续同步与二次开发维护说明

本仓库的职责是跟随 Sub-Store 上游，同时保留 Surge iOS 使用场景需要的修改。
不要把一次无冲突 Git 合并等同于兼容性验证完成。

## 仓库与发布关系

| 位置 | 职责 |
| --- | --- |
| `sub-store-org/Sub-Store` 的 `master` | 后端上游来源 |
| 私有 `ahuai6/Sub-Store-Fork` 的 `upstream` | 上游原样镜像，只允许快进，不放 fork 改动 |
| 私有仓库 `main` | 上游代码 + 已审核的 fork 修改 |
| 私有仓库 `sync/upstream` | 当前工作流在冲突时使用的同步 PR 分支，已有解决提交时不强推 |
| `ahuai6/Sub-Store-Fork-Dist` 的 `main` 和 Release | 公开模块、构建产物、用户明确要求发布的 geo.js 及其来源/许可证 |
| Dist 的 `gh-pages` | 从独立前端上游构建的页面，不是本仓库后端的源码目录 |

`publish-dist` 在后端/模块/发布逻辑等相关 main push 后自动测试、构建、发布。
PR 事件只验证，不发布。`publish-frontend` 是独立的定时/手动工作流；后端合并不会
自动让前端补丁上线。判断前端实际状态要看公开 `frontend-version.txt` 的 sha 和 patches。

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

审查时的 `.github/workflows/sync-upstream.yml` 每天 **04:17 UTC** 运行：

1. 取上游 master，将 `upstream` 分支快进；只镜像本地 origin 尚无的标签，不移动已有标签。
2. 尝试合并到 main。无冲突时重套 URL/CORS，并检查运行时 fork 标记。
3. **现状是无冲突且检查通过就直接推 main，只有冲突才开 PR**；缺少 fork 标记会停止并开 issue。
   这并不是“每次更新都先提 PR”。如用户选择统一走 PR，应修改工作流，不依赖口头约定。
4. 使用 GITHUB_TOKEN 的 push 不会自动触发另一个 push 工作流。当前同步逻辑仅在
   backend/package.json 变化或重套 fork 补丁提交时显式 dispatch publish-dist。
   以后改成 PR 合并流程时也要重新核对触发链，避免把“每日取上游”和“每日必须发布”混淆。

手动 workflow_dispatch 由用户操作。CI 内既有的自动调用属于工作流逻辑，不能被误当作
助手可以自行点击 Run 的授权。用户把同步 PR 或失败链接发来后，可以在对话内继续处理。

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
   等 publish-dist PR 检查绿，确认符合既定约束后可直接合并；用户已授权常规 PR 无需逐个批准。
   确需用户作决定的重要取舍再确认。保留分支。
7. 合并后核对 main 发布检查、公开 module/geo 内容和 release source SHA；需要前端手动构建时明确告诉用户。

已有项目约定见根目录 `AGENTS.md`。历史性能与兼容性核对见 `performance-plan-audit.md`。
