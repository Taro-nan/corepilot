# 历史流程与外部 baseline 调查索引

整理日期：2026-10-15。这份索引保留历史材料的定位与读取入口，不重新执行调查、实验、审批、merge 或 delivery。当前产品流程见 [Optimization Lifecycle](../guides/optimization-workflow.md)，真实已审批结果见 [IPPI C002](../../examples/ippi-dilate3x3-success-case/README.md)。

## 旧命令、配置与规划

| 保留材料 | 历史内容 | 当前读取方式 |
| --- | --- | --- |
| [旧配置指南](../guides/configuration.md) | `phyopt config init`、旧 schema、backend/ResourceGrant/exploration 字段 | 历史兼容与迁移参考；当前 public schema 以 [optimization-config](../../src/config/optimization-config.ts) 为准 |
| [旧多候选指南](../guides/multi-candidate-optimize.md) | positional source、patch gate、多候选优选、workflow export | 不是当前标准入口；当前为有界 Hypothesis/反馈迭代，不据旧示例声明 Search 能力 |
| [旧知识检索指南](../guides/knowledge-retrieval.md) | 本地知识检索、候选生成上下文与打包流程 | 保留历史说明，不作为当前 Onboarding/优化闭环的前置条件或本轮交付能力 |
| [V2-0 design](../architecture/v2-0-design.md) | 特定历史提交的实现审计和设计 | 按原始基线阅读，不把其命令、状态和待办视为今天的事实 |
| [2026-09-23 审计](../CURRENT-STATE.md) | 指定日期、指定提交的 As-Is 内容 | 不是新的 Approved Result 状态页 |

原优化工作流指南里的 `candidate generate/diff`、`test`、`benchmark`、`workflow export`、ResourceGrant、默认 mock 与旧配置语法已经从当前生命周期说明中移除。这里只保留其名称以解释历史资料；不提供为 C002 重放这些步骤的指令。

## 外部 binary baseline 调查

HMiPPI/HMPP、KML runtime、CPU compatibility policy 与 symbol closure 是已经退出当前主线的历史调查。当前 IPPI C002 Performance Baseline 为 IPPI-FT `main@23a39f8de2272c150e168a824b7839de3844661c` 构建的冻结 `libftppi.so`，并不依赖外部库。

下面列出的文件在本工作区存在，原字节保留。日期与状态属于各原记录，不推导为当前 Formal baseline 资格：

| 原始记录 | 作用 |
| --- | --- |
| [Binary bundle definition](../../packages/ippi-ft/0.1.0/baselines/performance.json) | 历史外部 bundle identity 描述；不是 active self baseline |
| [Binary baseline discovery evidence](../../packages/ippi-ft/0.1.0/onboarding/binary-baseline-evidence.json) | 原始资产调查依据 |
| [Target runtime investigation](../../packages/ippi-ft/0.1.0/qualification/target-runtime-2026-10-08.json) | 历史 target loader/API 调查 |
| [Runtime symbol closure](../../packages/ippi-ft/0.1.0/qualification/runtime-symbol-closure-2026-10-08.json) | symbol provider、dependency graph 和原始失败事实 |
| [Historical compatibility runtime](../../packages/ippi-ft/0.1.0/qualification/historical-compatibility-runtime-2026-10-08.json) | 历史兼容性恢复方法、binary identity 与 owner-review 要求 |
| [当前 self-baseline definition](../../packages/ippi-ft/0.1.0/baselines/self-baseline.json) | 与历史外部 bundle 区分的 IPPI-FT self baseline |

Schema/Loader 可读取 binary bundle 的描述，不代表正式 bundle staging 已支持。[Package Task 映射](../../src/library-package/task-definition.ts)当前明确拒绝将 `binary_bundle` 转成正式执行 testpack。本文不补齐该能力，也不重评历史 vendor runtime 或兼容性 policy。

这些历史记录的冻结 snapshot 同时保留在 C002 原 Evidence inventory 内。[证据索引](../../examples/ippi-dilate3x3-success-case/evidence-index.md)列出已经核验的冻结文件 SHA；原始 vendor 资产和远端 runtime 路径本轮未重新访问，不能用调查摘要替代其字节核验。
