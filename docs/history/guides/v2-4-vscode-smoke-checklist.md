# VS Code 扩展冒烟清单

本文检查 VS Code 扩展是否与当前 CLI 命令和共享配置保持一致。`WIRED` 表示代码入口已接通，`VERIFIED` 表示自动化测试通过；真实 Extension Host 仍需人工点击验收。

## 打包和安装

```powershell
node extensions/vscode/build.mjs
code --install-extension extensions/vscode/phyopt-agent-vscode-0.4.0.vsix
```

## 核心路径

| 场景 | 操作 | 通过标准 |
| --- | --- | --- |
| 配置 | 执行“PhyOpt: 初始化配置”或打开 `phyopt.yaml` | 使用 YAML，保存后保留注释，凭据不落盘 |
| 模型 | 执行“PhyOpt: 配置模型”/“验证模型” | 与 `phyopt model configure/show/verify` 语义一致，使用 SecretStorage 或环境变量 |
| 目标 | 执行“PhyOpt: 选择目标机器” | 写入命名 profile，等价于 `phyopt target select <profile>` |
| 候选 | 对源码执行“开始优化” | 等价于 `candidate generate`，显示候选 ID 和原生 Diff |
| 测试 | 对候选执行正确性/性能验证 | 分别对应 `phyopt test` 和 `phyopt benchmark`，候选补丁与冻结基线一致 |
| 任务 | 在 TreeView 中查看、取消、重试、恢复和导出 | 与 `phyopt task list/status/cancel/retry/resume/diff/export` 一致 |
| 工作流 | 查看完整优化进度并导出 | 与 `phyopt workflow status/cancel/export` 一致 |
| 后台 | 启动、查看、停止受管 backend | 与 `phyopt backend start/status/stop` 一致，停止后端口不可达 |

## 验收边界

自动化测试覆盖共享业务层、HTTP 后台、配置服务和候选 Diff；未覆盖真实 VS Code UI 的鼠标、SecretStorage、窗口重启和长时间后台恢复。验收时应确认：

- 状态为空时显示真实空态，不伪造任务或候选；
- Mock/Experiment 和 `simulated` 标识清晰；
- 导出只写 `.phyopt/exports/` 或交付目录，不修改源码、提交或推送；
- 配置覆盖优先级与 CLI 相同：CLI > 环境变量 > YAML > 默认值；
- 已删除的旧命令不会重新出现在命令面板或提示文本中。
