# 参与 CorePilot 开发

先读取根目录的统一[开发宪章与工程指南](AGENTS.md)，无需另行读取兄弟目录中的文档。目录职责与文件保留规则见 [仓库结构](docs/development/repository-layout.md)，当前用户流程见 [文档索引](docs/README.md)，深度改进任务见 [性能工程清单](docs/roadmap/performance-depth.md)。

## 本地准备

使用 Node.js >=22.19.0，从 lockfile 安装依赖：

```text
npm ci
npm run typecheck
npm run build
npm run check:repo
npm test
```

网页改动再运行 `npm run test:web`；浏览器准备见 [网页指南](docs/guides/web-workbench.md)。根构建不覆盖 VS Code 扩展的独立检查。

## 一个改动的完成条件

1. 从当前入口和调用链确认问题，保留已有未提交内容。
2. 在既有应用服务、领域、Package/evaluator 或 Runner 边界内实现一条完整用户路径。
3. 按行为验证，更新对应文档；新测试和必要 fixture 默认进入版本控制。
4. 检查类型、构建、仓库约定、适用测试与 diff。打包变动额外执行 CLI 打包和离线安装验证。
5. 说明用户行为变化、验证环境、结果及尚未验证的范围；待办和已完成能力分别表述。

普通离线测试不要求付费模型或内部机器。硬件性能结论使用真实实验与独立复验；不要把 fixture、单元测试或开发 benchmark 解释为正式性能证明。提交不包含运行数据库、凭据、用户源码工作区或本机调查产物。
