# 仓库结构与持续维护

架构职责与开发规则参见[主开发宪章](../../../phytium/AGENTS.md)和[仓库开发指南](../../AGENTS.md)。本页说明文件放置与清理规则。

## 目录地图

```text
corepilot/
  src/                   Control、领域、Agent、RPC Runner、CLI 的实现
  web/                   React 工作台、浏览器测试、Vite 配置
  extensions/vscode/     VS Code 扩展及其独立构建/测试
  tests/                 后端行为测试和 TypeScript 测试辅助文件
  fixtures/              被测试/调查的小型源码库
  packages/              按 library/version 定位的 Library Package
  evaluators/            按 evaluator/version 定位的测试契约与资格资产
  testpacks/             兼容测试方案、冻结版本与原始资产
  testplans/             历史/版本化实验计划
  benchmark-assets/      版本化 benchmark 和身份描述
  build-inputs/          构建输入身份描述
  source-archives/       源码归档；大型压缩内容按既有规则忽略
  examples/              公开示例与真实案例的证据入口
  scripts/               当前构建、校验与打包工具
  deploy/linux/          服务与反向代理部署模板
  docs/
    README.md            当前文档导航
    guides/              当前用户指南
    architecture/        当前架构说明
    development/         开发维护说明与联调记录
    roadmap/             待实现能力及其验收清单
    design/              视觉设计素材
    history/             历史审计、设计、交接和旧指南
```

`packages/` 是产品领域资产，不是 npm workspace。版本号、manifest、资格记录、文件摘要之间有依赖；这些资产目录不按“文件重复”或“时间久”直接删除或搬迁。

## 本地生成内容

| 位置 | 用途 | 清理规则 |
| --- | --- | --- |
| `node_modules/` | 已安装依赖 | 可由 lockfile 安装；在进程不再使用时清理 |
| `dist/`、`web/dist/` | 后端与网页编译输出 | 不提交；`npm run build` 重建并移除无对应源码的旧 JS/map |
| `build/` | 打包、截图、人工调查、验证记录和临时工具 | 不提交；先辨认来源。现有真实验证记录和服务辅助入口不能视为纯缓存 |
| `web/test-results/`、`web/playwright-report/`、`.playwright-cli/` | 浏览器测试与会话产物 | 不提交；需要的截图可明确转为文档资产 |
| `corepilot-data/`、`.corepilot/` | 运行数据库、候选工作区、测试资产和任务记录 | 按部署备份与运行保留策略管理，不能作为代码整理直接删除或搬迁 |
| `.tmp-model-test/` | 本机模型测试配置 | 本地忽略；不混入公开 fixture 或安装包 |

项目配置统一命名为 `corepilot.yaml`，机器专用的本地配置可用 `corepilot-s5000c.yaml`。公共部署模板使用 `deploy/`；新增可公开示例放 `examples/`，不要复制维护者的环境配置。冻结实验资产保持原始身份，不参与普通命名整理。

## 开发检查

```text
npm run typecheck
npm run build
npm run check:repo
npm test
npm run test:web
git diff --check
```

`check:repo` 检查工作树中已跟踪和新建的文件：

- `src/` 模块可从 CLI、Runner、Web 或扩展的实际入口经静态/字面量动态 import 到达。
- 测试及 fixture 没有被 Git ignore 隐藏。
- Markdown 的仓库内文件链接指向实际文件（代码块、外部链接与克隆外引用除外）。
- 已编译目录没有对应源码已删除的旧 JS/map。

静态依赖检查不证明所有函数都有调用，也不理解计算得到的模块注册。发现未达模块先核对运行注册、外部 API 和测试，不自动删除。真正的新公共入口加入检查脚本的入口清单，并写明用途。

`prune-dist.mjs` 在 TypeScript 编译成功后只移除 `dist/` 内无对应 `.ts/.tsx` 源文件的 JS/map，不清理用户工作区、数据库、证据或其他资产。检查模式只读；`check:repo` 不执行清理。

CLI 打包变动额外运行：

```text
node scripts/package-cli.mjs
node scripts/verify-cli-install.mjs
```

CLI 打包成功后删除本次 `build/package/cli/` 临时装配目录，只保留 `.tgz` 安装包；打包失败时保留装配现场供诊断。该目录不承载用户运行数据。

扩展改动需执行扩展自己的构建/测试。真实模型与硬件测试单独记录环境和结论，不把离线 fixture 当作硬件证明。

## 文件如何归位

- 新业务能力先在既有领域或应用服务找到所有者，再接 Web/CLI；不要复制第二套规则。
- 测试辅助代码放 `tests/`；仅由测试导入的辅助模块不要放在生产 `src/`。
- 测试默认可跟踪，不增加逐文件的 ignore 放行清单。提交前确认新测试和必要 fixture 进入版本控制。
- 当前用户说明放 `docs/guides/`；待办放 `docs/roadmap/`，不能写成已经交付。
- 历史资料集中在 `docs/history/`；引用以其时间为准。历史正文中的代码块、命令记录和原始路径不改成新的实验事实。
- 调整文档位置同步更新相对链接。不可变测试资产及冻结 Evidence 不参与普通文档整理。
- 删除模块前检查入口、import、工具/子进程启动、测试和打包；删除源码后重建并校验安装包，防止旧 `dist` 掩盖缺失。

## 2026-10-30 整理记录

已将 26 份历史/开发文档归入对应职责目录，并修正仓库导航链接。原始 DOC/DOCX 文件移动时按 SHA-256 核对字节；没有改写测试包、baseline、qualification 或实验数据。

已删除以下无当前调用方的实现；它们的已提交版本仍可通过 Git 历史查看：

| 原文件 | 核查结论 |
| --- | --- |
| `src/core/task-service.ts` | 旧同步 mock service，无当前入口或测试调用；公开通用任务仍由 TaskHost 承接 |
| `src/cli-interactive/banner.ts` | 已被实际 homepage 取代，仅旧测试引用；对应失效测试一并移除，真实 homepage 测试保留 |
| `scripts/generate-knowledge-catalog.mjs` | 依赖已删除的 `dist/knowledge/*`，当前打包与运行均不调用 |
| `scripts/corepilot-remote-agent.sh` | 未接线的旧 SSH job 协议；当前实验由持久 RPC Runner 承接 |

同时移除测试逐文件 ignore 白名单，统一当前 Git/ZCode 忽略规则，增加过期编译输出清理与仓库校验。CLI 安装包仅保留需要的 postinstall 工具，不再复制整个开发脚本目录。

本地盘点中 `corepilot-data/` 有约 10.9 万个运行文件，`build/` 有约 1.9 万个文件（含打包依赖）。这些数字解释的是本机产物规模，不是冗余源文件数量；本轮不批量清理已有实验现场。
