---
alwaysApply: true
---

# Paseo fork 的发布边界

本仓库是 `getpaseo/paseo` 的 fork：`origin` 指向 `mouriya-s-lab/paseo`，`upstream` 指向 `getpaseo/paseo`。Fork 定制与上游同步必须保持可分离，避免把同步提交误当成产品发布。

## 上游同步

- 上游同步只通过 `.github/workflows/sync-upstream.yml` 进入 `main`；不要手动把 `upstream` 合并到 `main`。
- 同步 workflow 的 `sync/merge` 和 `sync/review` 分支由 CI 管理。存在带 `upstream-sync` label 的 open PR 时，不要删除、强推或重建这些分支。
- 同步 PR 只处理上游代码进入 fork，不打 release tag，不运行 release 命令。

## Fork 发布

- 合并到 `main` 不等于已发布。Runtime 改动必须按照 `docs/release.md` 和对应 release skill 走用户授权的 release 流程。
- 默认 release source 是已核实且 CI 通过的 `origin/main`。不要从 `upstream/main` 或未推送的本地分支发布。
- 未经用户明确授权，不创建 release commit、tag，不发布 npm 或部署构建产物。
- 只改文档、网站、测试配置或 workflow 的提交不自动进入 runtime release；是否部署由对应 workflow 和用户明确的发布意图决定。

## 边界

- Fork 定制的放置规则归全局 `fork-customization-placement` rule；发布细节归 `docs/release.md` 与 release skill。本 rule 只补充 Paseo fork 的入口/出口边界，不复制它们的内容。
- GitHub 账号、PAT 和 workflow 权限遵循全局 GitHub 与凭据规则；不要把 token 写入仓库或对话。
