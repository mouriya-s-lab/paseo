---
alwaysApply: true
---

# Paseo fork 的发布边界

本仓库是 `getpaseo/paseo` 的 fork：`origin` 指向 `mouriya-s-lab/paseo`，`upstream` 指向 `getpaseo/paseo`。Fork 定制与上游同步必须保持可分离，避免把同步提交误当成产品发布。

## 上游同步

- 上游同步只通过 `.github/workflows/sync-upstream.yml` 进入 `main`；不要手动把 `upstream` 合并到 `main`。
- 无需人工判断的上游提交，由同步 workflow 先在 cachyos runner 上只构建两个镜像，构建通过后直接 fast-forward 推进 `main`，不开 PR；`main` 的 push 再按正常发布流程发布。只有真实冲突、上游新增 workflow 文件或候选构建失败时，才开带 `upstream-sync` label 的 PR。
- 同步 workflow 的 `sync/merge` 和 `sync/review` 分支由 CI 管理。存在带 `upstream-sync` label 的 open PR 时，不要删除、强推或重建这些分支。
- 同步 workflow 自身不打 release tag，不运行 release 命令。

## Fork 发布

- 这个 fork 只发布 Docker 镜像：daemon 镜像 `registry.237575.xyz/paseo/paseo` 和 web 镜像 `registry.237575.xyz/paseo/paseo-web`，两者同一 commit、同一 tag 成对发布。不发布 npm、Desktop、Android、iOS/EAS、Nix、网站或 relay 构建产物。
- `.github/workflows/fork-docker.yml` 在自有 GARM runner 上执行唯一的构建发布路径：同仓库 PR 只构建不推送；`main` push、每小时 upstream tag 检查和 `main` 上的手动 dispatch 执行发布。上游的 `docker.yml` 与 release skill 已删除。
- workflow 从当前 `main` 可达的最高 upstream `vX.Y.Z` 或 prerelease tag 解析基础版本；root `package.json` 必须与该基础版本一致。
- upstream 基础版本使用 `vX.Y.Z-fork.N`，`N` 从 `0` 开始；同一 commit 重试复用已有 fork tag，其他 fork commit 使用该基础版本的最大后缀加一。
- 每次发布（稳定版与 prerelease 一样）在两个精确 tag 都推送并核对 revision 后，把两个镜像的 `latest` 移到该 tag。`latest` 是部署通道：homelab 的 `paseo` Stack 只跑 `latest`，部署方仓库不写版本号。
- 两个镜像都构建、推送成功后才创建并推送 fork tag；失败时不留下未构建的 release tag。
- 发布成功后，同一 workflow 的 `deploy` job 让 homelab Komodo 只重新部署 Stack `paseo` 的 App 服务，并确认公开 origin 的 `/_paseo/version.json` 报告本次发布的 commit。手动 dispatch 重新部署当前发布。部署凭据只能操作这一个 Stack，存放在仅 `main` 可用的 `homelab-paseo` environment 中，由 homelab Komodo 的 IaC 创建和轮换，禁止手写或粘贴。
- registry 登录用短时 Keycloak token 经 `sa-registry` 登录；`KEYCLOAK_REGISTRY_CLIENT_SECRET` 由 IaC 同步到仓库 secret，禁止手写、粘贴或提交。
- 不运行上游的 npm、Desktop、Android、EAS、Nix、网站或 relay release 命令；Docker 之外的 Actions 已移除。

## Fork 代码放置

- Fork-only 实现和测试默认放在仓库根目录 `fork-features/<feature>/`。
- 当 package bundler 只允许 package root 下的源码时，使用 `<package>/src/fork-features/<feature>/`；根目录 `fork-features/ownership.tsv` 仍是所有权索引。
- 修改上游文件前先寻找 `register*`、handler、provider 或 callback 扩展点；有扩展点就从 `fork-features/` 注册。
- 没有扩展点时，只保留使 fork 模块进入执行路径的最小接入改动，并在 `fork-features/trunk-patches.md` 记录文件/符号、缺失的 seam、无法抽出的原因和验证方式。
- 每次上游同步都重新检查这些接入点；上游提供原生实现或注册 seam 后，迁移到 `fork-features/` 或删除过时 patch。
- 不改上游拥有的文档（`README*.md`、`docs/`、`public-docs/`、`docker/` 下的示例），保持与上游一致；fork 的说明写进 `fork-features/README.md`。`docs/release.md` 等上游文档描述的是上游自己的发布流程，不适用于本 fork。

## 边界

- Fork 定制的放置规则归全局 `fork-customization-placement` rule；发布细节归 `fork-features/README.md`。本 rule 只补充 Paseo fork 的入口/出口边界，不复制它们的内容。
- GitHub 账号、PAT 和 workflow 权限遵循全局 GitHub 与凭据规则；不要把 token 写入仓库或对话。
