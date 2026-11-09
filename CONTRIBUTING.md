# 参与 CorePilot 开发

开始前读取[主开发宪章](../phytium/AGENTS.md)和[仓库工程指南](AGENTS.md)；主宪章不在克隆目录中，缺失时应先取得，再作依赖其中规则的开发决策。目录职责与文件保留规则见 [仓库结构](docs/development/repository-layout.md)，当前用户流程见 [文档索引](docs/README.md)，深度改进任务见 [性能工程清单](docs/roadmap/performance-depth.md)。

## 本地准备

准备 Git、ripgrep（命令 `rg`）、Node.js >=22.19.0、npm 和 Python 3（Windows 上可执行命令为 `python`，Linux 为 `python3`），并确认 `rg --version` 可以执行。Ubuntu 可使用 `sudo apt-get install ripgrep`；Windows 可以使用包管理器安装。从新克隆和 lockfile 安装依赖，并生成网页与服务端资源：

```text
npm ci
npm run typecheck
npm run build
npm run check:repo
npm test
npx playwright install chromium
npm run test:web
git diff --check
```

Linux 首次运行 Playwright 若缺少系统库，可使用 `npx playwright install --with-deps chromium` 安装 Chromium 及系统依赖（需要相应系统权限）。网页测试启动隔离的临时 Git 仓库、HTTP 服务和模型夹具，不使用真实优化机器；仍需先执行 `npm run build`。Windows 默认也可使用已安装的 Chrome 或 Edge，或用 `COREPILOT_BROWSER_PATH` 指定浏览器。更多操作见[网页指南](docs/guides/web-workbench.md)。根构建不覆盖 VS Code 扩展的独立检查。

GitHub Actions 对 Linux 的 Node 22.19.0 和 Node 24、Windows 的 Node 24 执行安装、构建、类型、仓库约定和 Node 测试，并在 Node 24 的两个系统上执行 Chromium 网页测试。CI 结果仅证明对应环境中的自动化检查，不证明真实硬件性能、人工审批或交付。

## 一个改动的完成条件

1. 从当前入口和调用链确认问题，保留已有未提交内容。
2. 在既有应用服务、领域、Package/evaluator 或 Runner 边界内实现一条完整用户路径。
3. 按行为验证，更新对应文档；新测试和必要 fixture 默认进入版本控制。
4. 检查类型、构建、仓库约定、适用测试与 diff。打包变动额外执行 CLI 打包和离线安装验证。
5. 说明用户行为变化、验证环境、结果及尚未验证的范围；待办和已完成能力分别表述。

普通离线测试不要求付费模型或内部机器。硬件性能结论使用真实实验与独立复验；不要把 fixture、单元测试或开发 benchmark 解释为正式性能证明。提交不包含运行数据库、凭据、用户源码工作区或本机调查产物。
