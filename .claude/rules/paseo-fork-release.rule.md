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

- 这个 fork 只发布 Docker 镜像，不发布 npm、Desktop、Android、iOS/EAS、Nix、网站或 relay 构建产物。
- `.github/workflows/docker.yml` 在自有 GARM runner 上执行唯一的构建发布路径：同仓库 PR 只构建不推送；`main` push、每小时 upstream tag 检查和 `main` 上的手动 dispatch 执行发布。
- workflow 从当前 `main` 可达的最高 upstream `vX.Y.Z` 或 prerelease tag 解析基础版本；root `package.json` 必须与该基础版本一致。
- upstream 基础版本使用 `vX.Y.Z-fork.N`，`N` 从 `0` 开始；同一 commit 重试复用已有 fork tag，其他 fork commit 使用该基础版本的最大后缀加一。
- 稳定基础版本同时发布 `ghcr.io/mouriya-s-lab/paseo:X.Y.Z-fork.N` 和 `latest`；prerelease 只发布精确版本镜像，不移动 `latest`。
- 镜像构建成功后才创建并推送 fork tag；失败时不留下未构建的 release tag。
- 不运行上游的 npm、Desktop、Android、EAS、Nix、网站或 relay release 命令；Docker 之外的 Actions 已移除。

## Fork 代码放置

- Fork-only 实现和测试默认放在仓库根目录 `fork-features/<feature>/`。
- 当 package bundler 只允许 package root 下的源码时，使用 `<package>/src/fork-features/<feature>/`；根目录 `fork-features/ownership.tsv` 仍是所有权索引。
- 修改上游文件前先寻找 `register*`、handler、provider 或 callback 扩展点；有扩展点就从 `fork-features/` 注册。
- 没有扩展点时，只保留使 fork 模块进入执行路径的最小接入改动，并在 `fork-features/trunk-patches.md` 记录文件/符号、缺失的 seam、无法抽出的原因和验证方式。
- 每次上游同步都重新检查这些接入点；上游提供原生实现或注册 seam 后，迁移到 `fork-features/` 或删除过时 patch。

## 边界

- Fork 定制的放置规则归全局 `fork-customization-placement` rule；发布细节归 `docs/release.md` 与 release skill。本 rule 只补充 Paseo fork 的入口/出口边界，不复制它们的内容。
- GitHub 账号、PAT 和 workflow 权限遵循全局 GitHub 与凭据规则；不要把 token 写入仓库或对话。
