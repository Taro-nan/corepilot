# 工程工具

| 文件 | 用途 | 常用入口 |
| --- | --- | --- |
| `prune-dist.mjs` | 编译成功后清除源码已删除的旧 JS/map | `npm run build` 自动调用 |
| `check-repository.mjs` | 源码入口可达性、测试跟踪、文档链接与编译残留检查 | `npm run check:repo` |
| `apply-ink-patch.mjs` | Ink 终端重绘依赖补丁 | `npm ci` 的 postinstall；随 CLI 安装包分发 |
| `package-cli.mjs` | 含生产依赖与网页的 CLI/Control 安装包 | `node scripts/package-cli.mjs` |
| `verify-cli-install.mjs` | 在干净临时目录离线验证安装包、网页与 CLI 共用 API | `node scripts/verify-cli-install.mjs` |
| `package-runner-runtime.mjs` | 使用指定官方 Linux Node 归档装配 Runner | 参数见 [机器部署指南](../docs/guides/execution-machines.md) |
| `verify-vsix-install.mjs` | VS Code 安装包验证 | 扩展改动时按工具参数执行 |

一次性调查脚本和本机截图放本地 `build/`，有长期产品用途的能力接入公开服务与命令。旧远端 helper 和失效知识 catalog 脚本已移除，定位见 [整理记录](../docs/development/repository-layout.md)。
