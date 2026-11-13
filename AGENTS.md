# Sub-Store-Fork 协作约定

这是 `sub-store-org/Sub-Store` 的持续同步与二次开发仓库，不是一次性改版。
先读 `docs/fork-maintenance.md` 和当前 `.github/workflows/sync-upstream.yml`，
再处理上游同步、模块发布或运行时改动。`docs/performance-plan-audit.md` 是
2026-11-13 的历史核对表，部署状态以实际工作流和公开版本元数据为准。

- 从当前 `origin/main` 开始；保留上游来源和 Git 历史。
- 源文件不删；保留全部 producers、parsers（含 Loon/QX）和 lodash。
- 不 force-push，不删除分支，不添加 upload-artifact。
- 用户已授权：常规维护、上游同步和修复 PR，在符合既定约束且检查通过后可直接合并，
  不必逐个请求批准。确实需要用户作决定的重要取舍再确认。手动触发的工作流仍由用户点 Run。
- 所有缓存必须受相应全局 TTL 约束；指纹只是 TTL 内的键，不得成为永久跳过重测的理由。
  TTL 为 0 不读写缓存；刷新/清缓存必须覆盖所有分片。
- 发布模块中的同步、定时处理、prefetch 默认全部关闭。安装不得要求填写 prefetch 参数。
- `config/Surge-Beta.sgmodule` 保留上游版本，fork 改动通过渲染脚本套用并检查可逆差异。
- 用户已明确要求发布 geo.js。只发布该源码及其许可证/来源说明，避免扩大发布私有源码范围。
- 运行适用测试，保留 golden snapshots。性能相关 PR 跑 `pnpm bench`，记录真实收益与开销。
- 无法在对话外自行持续监控 GitHub；后续同步 PR 需要用户唤起处理。
