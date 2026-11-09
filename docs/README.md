# CorePilot 当前产品文档

后续开发先读 [主开发宪章](../../phytium/AGENTS.md)，再读根目录的[仓库开发指南](../AGENTS.md)；两者关系与适用例外见后者。[此前的重写讨论](history/rewrite/README.md)保留作备选参考，不作为当前实施计划。

整理日期：2026-10-30。当前主线是通过 Library Package、Hypothesis/Candidate、真实 Runner 实验、独立 Revalidation 和人工审阅形成可追溯优化结果。下文 C002 是已有 S5000C 历史案例；当前入口与实现以指南和源码为依据。

## 阅读入口

| 阅读目的 | 当前文档 |
| --- | --- |
| 当前调用链、状态所有权、目标模块边界与迁移条件 | [系统架构与演进边界](architecture/corepilot-system.md) |
| 下一阶段深度改进、优先级与验收标准 | [性能工程清单](roadmap/performance-depth.md) |
| 技术评审整改状态、验证结果与外部阻塞 | [技术评审整改记录](engineering/corepilot-review-execution.md) |
| 测试辨别力、Runner 排队、统计区间、A/A 校准与源码复现 | [性能可信度与复现](guides/performance-assurance.md) |
| 目录职责、文件保留/清理和工程检查 | [仓库结构与维护](development/repository-layout.md) |
| 贡献流程和本地验证 | [贡献指南](../CONTRIBUTING.md) |
| 网页使用、CLI 互通、Linux 常驻部署和备份 | [网页工作台指南](guides/web-workbench.md) |
| 维护者注册机器、项目选择、状态检测与 CLI 复用 | [共享执行机器](guides/execution-machines.md) |
| 接入新库、源码识别、构建命令与验证方案配置 | [新库接入配置](guides/library-setup.md) |
| 自主控制测试条件、接入/生成代码、两库对比与测试包下载 | [测试方案指南](guides/test-plans.md) |
| 分别使用源码优化与独立测试、比较源码和库包 | [优化与独立测试](guides/optimization-and-testing.md) |
| 优化与测试分离的入口、恢复、UI 及离线验证范围 | [分离流程验证记录](development/optimization-testing-validation.md) |
| 网页首次使用、配置保存、错误反馈与前后端联调 | [网页联调与改进记录](development/frontend-integration-review.md) |
| 网页架构、已实现范围和后续边界 | [网页工作台 V1](architecture/web-workbench-v1.md) |
| 尽快使用：交互配置、启动优化、观察测试并导出报告 | [CLI 到报告快速指南](guides/quickstart-report.md) |
| 产品入口、安装与兼容配置 | [仓库 README](../README.md) |
| 先看真实结果与适用范围 | [IPPI Dilate3x3 Success Case](../examples/ippi-dilate3x3-success-case/README.md) |
| 从结论追到 Experiment、Approval、文件 SHA | [C002 Evidence 索引与只读核验](../examples/ippi-dilate3x3-success-case/evidence-index.md) |
| 从 Package onboarding 到 Approval 的阶段、入口、执行者、状态和人工操作 | [Optimization Lifecycle](guides/optimization-workflow.md) |
| 只读调查、离线/Pi 模式、Draft 与 UNKNOWN | [Library Onboarding](guides/library-onboarding.md) |
| Manifest、Loader、scope、Package/Evaluator 资格与运行配置 | [Library Package](guides/library-packages.md) |
| 失败 case、资源/contract/execution 故障与下一轮输入 | [Candidate Evaluation Feedback](guides/candidate-feedback.md) |
| 假设、Candidate lineage、outcomes 与 REPAIR/ABANDON/NEW_HYPOTHESIS | [Optimization Hypotheses](guides/optimization-hypotheses.md) |

当前命令来源是 [CLI dispatch](../src/cli.ts) 与 [command spec](../src/cli-command-spec.ts)，运行配置来源是 [optimization-config](../src/config/optimization-config.ts)。概念阶段不能推导出尚不存在的命令或自动状态转换。新任务的正式 Package 路径使用 RPC；旧 build/testpack 模式仍作为兼容入口说明。

## 如何判断已交付的能力

- 以当前源码调用关系判断是否实现、接线以及实际执行 gate；schema 能表达不等于执行已支持。
- 以真实目标机冻结 Evidence 判断已执行的实验、资源条件、版本与 claim scope；普通文档摘要不能替代原始核验。
- 以审批记录判断当前 approved result；保留冻结时的 FROZEN/NOT_REQUESTED snapshot 与历史 FAILED Task/Workflow，不回写历史。
- 区分 Development、Formal、Revalidation、Owner Qualification、Human Approval 与 merge/delivery；`ACCEPTED` outcome 不是 Owner Approval。
- 区分 Package qualification 记录与当前实际强制执行的 Evaluator qualification gate。
- 区分统计版本：历史 gate v2 缺 `ci_lower` 时使用 ratio；新方案显式启用 gate v3 配对分块 bootstrap。配置 0.95 本身不代表已有区间，历史结果保持原含义。

C002 的首次 Formal 4.6976×、独立复验 4.5867×、两次 19/19 PASS 和 APPROVED 均有记录；C001 来自 Pi、C002 repair 来自 Codex，后续阶段由操作脚本衔接，尚未 merge/delivery。不要把它表述成从单条命令全自动完成并交付的 Workflow。

## 历史资料与非当前主线

[历史资料总索引](history/README.md)集中收录旧审计、设计、交接、指南与重写备选。[历史流程与外部 baseline 调查索引](history/legacy-and-external-baselines.md)保留原始调查入口。当前外部库接入与运行行为见[新库接入配置](guides/library-setup.md)，不由旧调查记录推导当前能力。

以下材料按其原始时间和用途阅读，不能替代上面的当前指南：

| 历史材料 | 定位 |
| --- | --- |
| [2026-09-23 Current State 审计](history/assessments/CURRENT-STATE.md)、[当时的核验材料](history/assessments/CURRENT-STATE-VERIFICATION.md)、[Gap Analysis](history/assessments/GAP-ANALYSIS.md) | 指定提交/日期的历史静态核查 |
| [V2-0 design](history/design/v2-0-design.md)、[Architecture](history/design/ARCHITECTURE.md) | 历史架构材料和设计讨论，非本轮架构变更 |
| [Vision](history/design/VISION.md)、[PRD](history/design/PRD.md)、[MCP Product Spec](history/design/PRODUCT-SPEC-MCP.md)、[Target Decisions](history/design/MCP-DECISIONS-01-TARGET.md) | 产品目标或方案，不等于实现与真实验收 |
| [PRD v1.2 原始 DOCX](history/product/CorePilot_Agent_PRD_v1.2.docx) | 已存在的原始产品材料，保持原字节 |
| [模型适配交接](history/handoffs/model-adapter-handoff.md) | 阶段性交接，涉及命令/状态时须对照当前代码 |

旧索引曾引用的 `status/current-implementation-gaps.md`、`product/prd-v0.3.md` 和 v1.1/V0.3 的几份 DOCX 在当前工作区不存在，已移除失效导航；不根据名称补造正文或搬移其他文件充当原件。

## 尚存的产品能力缺口

完整优先级与验收项目见[性能工程清单](roadmap/performance-depth.md)。以下补充既有主线的实际边界：

- Package qualification 还没有与 Evaluator 同等的 Loader 强制状态 gate。
- 项目自建方案支持覆盖清单和已知错误实现检验；识别结果进入资格审阅，具体库的检验资产仍需实际执行，不能用 fixture 代替。
- Evidence Freeze 与领域 Approval Record 未形成统一公开 CLI；CLI approval/merge 是另一条路径。
- 新任务已有持久会话继续与冻结候选重新验证；没有检查点的旧任务不能假装恢复，C002 的历史操作过程按原记录理解。
- 新统计方案计算真实区间，旧方案保持点估计；A/A 入口已接线，目标机噪声和经验误报率仍需独立校准。
- Onboarding 是有界静态发现，没有 build/test probe 或完整调用图/热点证明。

## 文档维护约定

当前入口与历史材料分开链接。命令必须能对应现有 dispatch/参数；状态必须注明所属对象和记录层级；证据须区分“已取得并校验”“只读到引用”“原件未取得/远端未访问”。新增案例说明或证据索引不改变既有 Evaluator、baseline、实验、测量和冻结文件。
