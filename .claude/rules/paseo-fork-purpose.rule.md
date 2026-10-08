---
alwaysApply: true
---

# Paseo fork 的目的

这个 fork 只服务操作员自己，按优先级有两个目的：

1. **自托管 web 与 daemon 分离的 Paseo。** 浏览器 UI 部署在一个独立的 web origin 上，一个或多个 daemon 部署在别处，经同一 origin 下的 `/daemons/<id>` 访问。任何设备只要打开这个 origin，看到和操作的都是同一组 daemon 及其状态，不依赖本机桌面 App 或 relay。
2. **给 Paseo 做定制。** 在不破坏第 1 点的前提下，按操作员的需要改变产品行为。

## 取舍

- 第 1 点优先。任何改动，包括上游同步时的冲突解决，都不能让分离部署失效：web 构建能以 `EXPO_PUBLIC_PASEO_SELFHOSTED=true` 从 `/_paseo/hosts.json` 发现 daemon，经 `basePath` 连接、下载和打开服务链接，并只使用托管连接。实现位置和接入点见 `fork-features/trunk-patches.md`。
- 上游新功能如果与分离部署冲突，在 fork 里适配它，不删除分离部署能力，也不为它新增只在本机桌面场景成立的假设。
- 定制服务于操作员本人，不为外部用户提供兼容层、迁移路径或公开分发。
- fork 的改动不向 `getpaseo/paseo` 提交 PR 或 issue。

## 验证

- 触及分离部署路径的改动（连接、host 注册表、URL 构建、下载、服务链接、web 构建参数、web 镜像的代理与 manifest 生成）必须在真实分离拓扑里走浏览器路径验证：web origin 加代理后的至少两个 daemon，观察实际 WebSocket 走 `/daemons/<id>`、刷新后持久化正确、manifest 移除后不复现。单元测试不能替代。

## 边界

- 本仓库发布分离部署的两种镜像：daemon 镜像，以及 web 镜像（self-hosted 模式的浏览器 bundle，加上启动时从 daemon 清单生成 `/daemons/<id>` 反向代理和 `/_paseo/hosts.json` 的逻辑）。manifest 的格式由本仓库的 web 代码解析，所以生成它的代码也放在本仓库。
- 部署方 `mouriya-s-lab/homelab-apps` 的 `stacks/paseo/compose.yaml` 声明 daemon 清单（id、名称、上游地址）、服务和密钥，以 `latest` 运行本仓库发布的镜像；它不写版本号，不构建 web 镜像，也不持有代理生成逻辑。新版本由本仓库的发布 workflow 上线。
- 定制代码放在哪里、上游同步与发布怎么做，见 `paseo-fork-release.rule.md`。本 rule 只说明 fork 为什么存在，以及由此产生的取舍。
