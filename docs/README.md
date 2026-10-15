# CorePilot 当前产品文档

整理日期：2026-10-15。当前主线是通过 Library Package、Hypothesis/Candidate、S5000C Formal 实验、独立 Revalidation、冻结 Evidence 和显式 Owner Approval 形成可追溯优化结果。当前已完成的真实案例为 IPPI-FT Dilate3x3 C002。

## 阅读入口

| 阅读目的 | 当前文档 |
| --- | --- |
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
- 说明统计实现限制：缺 `ci_lower` 时 gate 使用 speedup ratio；配置 0.95 不代表已计算 95% CI。

C002 的首次 Formal 4.6976×、独立复验 4.5867×、两次 19/19 PASS 和 APPROVED 均有记录；C001 来自 Pi、C002 repair 来自 Codex，后续阶段由操作脚本衔接，尚未 merge/delivery。不要把它表述成从单条命令全自动完成并交付的 Workflow。

## 历史资料与非当前主线

[历史流程与外部 baseline 调查索引](history/legacy-and-external-baselines.md)保留旧配置、patch/多候选/ResourceGrant/导出流程及 HMiPPI 调查的定位和原始文件入口。这些资料不构成当前标准命令、当前接入前置条件或已完成的 Formal binary-bundle staging。

以下材料按其原始时间和用途阅读，不能替代上面的当前指南：

| 历史材料 | 定位 |
| --- | --- |
| [2026-09-23 Current State 审计](CURRENT-STATE.md)、[当时的核验材料](CURRENT-STATE-VERIFICATION.md)、[Gap Analysis](GAP-ANALYSIS.md) | 指定提交/日期的历史静态核查 |
| [V2-0 design](architecture/v2-0-design.md)、[Architecture](ARCHITECTURE.md) | 历史架构材料和设计讨论，非本轮架构变更 |
| [Vision](VISION.md)、[PRD](PRD.md)、[MCP Product Spec](PRODUCT-SPEC-MCP.md)、[Target Decisions](MCP-DECISIONS-01-TARGET.md) | 产品目标或方案，不等于实现与真实验收 |
| [PRD v1.2 原始 DOCX](product/PhyOpt_Agent_PRD_v1.2.docx) | 已存在的原始产品材料，保持原字节 |
| [模型适配交接](handoffs/model-adapter-handoff.md) | 阶段性交接，涉及命令/状态时须对照当前代码 |

旧索引曾引用的 `status/current-implementation-gaps.md`、`product/prd-v0.3.md` 和 v1.1/V0.3 的几份 DOCX 在当前工作区不存在，已移除失效导航；不根据名称补造正文或搬移其他文件充当原件。

## 尚存的产品能力缺口

这里只列出现状，不在本轮实现，也不据此新增架构：

- Package qualification 还没有与 Evaluator 同等的 Loader 强制状态 gate。
- Human Review、Baseline/Build Freeze、Target/Owner Qualification 仍需要操作者组织。
- Evidence Freeze 与领域 Approval Record 未形成统一公开 CLI；CLI approval/merge 是另一条路径。
- 历史 FAILED 优化任务的续跑与本案收尾仍通过操作脚本衔接。
- 当前统计 gate 不会根据 confidence_level 自动计算 95% CI。
- Onboarding 是有界静态发现，没有 build/test probe 或完整调用图/热点证明。

## 文档维护约定

当前入口与历史材料分开链接。命令必须能对应现有 dispatch/参数；状态必须注明所属对象和记录层级；证据须区分“已取得并校验”“只读到引用”“原件未取得/远端未访问”。新增案例说明或证据索引不改变既有 Evaluator、baseline、实验、测量和冻结文件。
