# Library Package v1

Library Package 是基础库的声明式领域描述，不是新的 Runtime。
新库通过添加版本化目录接入，不在 Loader、Core、Workflow 或 Runner 注册库名分支。

当前接入与审批的操作顺序见[生命周期指南](optimization-workflow.md)；生成 Draft 见 [Onboarding](library-onboarding.md)；真实结果见 [IPPI C002](../../examples/ippi-dilate3x3-success-case/README.md)。以下是实现现状，不把 schema 可表达的内容自动视为可执行能力。

## 目录

```text
packages/
  ftblas/1.0.0/
    package.json
    build/shared.json
  example-vector/0.1.0/
    package.json
    build/shared.json
    fixtures/vector.c
  ippi-ft/0.1.0/
    package.json
    build/frozen-cmake.json
    baselines/self-baseline.json
evaluators/
  sgemv-n/1.0.0/     # 原正式评估器，原地引用，不复制、不修改
  saxpy/0.1.0/       # 现有未 qualified 的向量领域评估器
  ippi-dilate3x3-64f-c1r/0.1.0/
```

example-vector 仅用于接入与 Task 创建验证。若执行其构建，需要把 fixture 源码复制到
候选源码根目录下的 fixtures/vector.c；它不宣称具备正式执行资格或真实 baseline。

## Manifest 与边界

唯一权威 schema：src/contracts/library-package.ts 的 LibraryPackageManifestSchema。
TypeBox schema 可直接序列化为 JSON Schema；schema_version 当前为 1。
身份使用小写字母、数字及单连字符；版本为精确 major.minor.patch，不选择 latest。

必填字段：package_id、version、owner、library、qualification、functions、
build_definitions、formal_evaluators、targets。
每个 target 声明 target_id、function_id、build_id、evaluator 引用、candidate_scope、
development_benchmark、artifacts、performance_acceptance、analysis_sampling、domain_payload。
结构化对象拒绝未知字段；只有 domain_payload 接受领域自定义 JSON。
build 使用已有 executable / args / cwd / environment / timeout_ms 命令形状。
candidate_scope 使用精确相对文件名或以 / 结尾的目录前缀，不支持 glob；排除规则优先。
Loader 拒绝路径穿越及引用路径上的符号链接，不导入或执行 Package 中的 JS/TS。

Core 保持 Task / Candidate / Experiment / Measurement / Evidence、Agent、Runtime、
持久化、恢复、审批；Runner / RPC 保持执行、资源强制与证据核验。
Package 声明构建、目标、修改范围、开发 workload、产物身份和性能接受阈值。
oracle、tolerance、完整 correctness/performance inventories、sampling、CPU/NUMA/thread
policy、baseline 对称性和 evaluator assets 均由其引用的原 Formal Evaluator 提供。

## 资格与 Task

Package qualification 是独立的接入描述审查记录；Evaluator qualification 是特定 evaluator 内容的可信资格，两者不能合并。

| Catalog（2026-10-15 核对） | Package state | 引用 Evaluator 的 status |
| --- | --- | --- |
| `ippi-ft@0.1.0` | `QUALIFIED` | `ippi-dilate3x3-64f-c1r@0.1.0`：`QUALIFIED` |
| `ftblas@1.0.0` | `DRAFT` | `sgemv-n@1.0.0`：`QUALIFIED` |
| `example-vector@0.1.0` | `DRAFT` | `saxpy@0.1.0`：`QUALIFICATION_PENDING` |

offline load / inspect / Task 创建允许结构合法的未 Qualified Evaluator 引用。正式 public Package workflow 必须使用 RPC，且由 `loadFormalEvaluatorBundle(requireQualified: true)` 验证指定 owner/id/version/digest；Runner 再次核验 qualification 和内容。

当前 Loader 的 `requireQualified` 实际传给 Evaluator loader，不强制检查 Package 的 `qualification.state`。Owner review 是需要记录的操作要求，不能写成已经实现的同等 Package 执行 gate。Package 标记 QUALIFIED 不能绕过 Evaluator gate。

通用 evaluator loader 存在精确 `TARGET_VALIDATED` digest 的 bootstrap 参数，标准 public Package preflight 不传入它。本案使用已 QUALIFIED 的 evaluator；不能把这个内部选项当作 Draft 的普通执行入口。来源见 [loader](../../src/library-package/loader.ts)、[preflight](../../src/workflow/public-optimization.ts) 和 [evaluator loader](../../src/evaluator/formal-evaluator.ts)。

Task 新增可选 library_package：package_id、package_version、package_digest、target_id、
function_id、evaluator_id、evaluator_version。旧 Task/testpack 兼容，Package 映射复用已有持久化与 RPC contract；实际 domain tables 以当前 SQLite 实现为准。
src/library-package/task-definition.ts 仅映射到已有 Task 输入和 ValidationTestpack 形状，
不运行 Agent、不调度 Experiment、不执行命令。Workspace 写入和 Runtime checkpoint
持久化均检查 candidate_scope。

已有配置保留 model / target / runner / output_dir，移除 build 和 validation.testpack：

```yaml
validation:
  library_package:
    package_id: ippi-ft
    package_version: 0.1.0
    target_id: ippi-dilate3x3-64f-c1r
    evaluator_id: ippi-dilate3x3-64f-c1r
    evaluator_version: 0.1.0
  baseline_artifact: /your/runtime/baseline.so
```

baseline_artifact 是外部运行绑定；身份及预期 SHA-256 由 Package 固定。
模型配置、SSH / Runner endpoint、凭据、机器路径不属于 Package。
Package 与旧 testpack、外部 build 覆盖互斥，避免多个领域事实来源。
配置保存时不写入兼容性空 testpack 或有效 build 副本。

以上只是 `validation` 配置片段，`baseline_artifact` 是待绑定路径；实际运行还要提供 model、target、RPC runner endpoint/token 和 output_dir。它不是完整复现配置，更不会自动构建或冻结 baseline。

`performance_acceptance` 映射到现有通用 gate；缺少 `ci_lower` 时使用 median speedup ratio，`confidence_level` 配置本身不证明 95% CI。准确口径见[统计说明](optimization-workflow.md#统计口径)。

```text
corepilot package list
corepilot package inspect ippi-ft 0.1.0
corepilot optimize --config phyopt.yaml --function ippiDilate3x3_64f_C1R --performance
```

inspect <id> 仅在恰好一个版本时省略版本。CLI 发行包携带 packages 与 evaluators。
这里的 optimize 是准备好配置后的新任务入口，不是重放已批准案例或创建其 Approval Record 的命令。

## 已有验证与当前边界

tests/library-package.test.ts 先创建仅含 ftblas 的临时 catalog，再只复制第二个 Package
目录，用同一个 Loader 创建持久化 Task，并比较 Core / Workflow / Runner 文件快照。
SGEMV content digest 固定为 e1d2effa606f2ef4f028a490ffef8dc7a9b2968fc15128250a281a2539c8ae58；
qualification digest 固定为 06c50b60eb7de07861c39c87b4ab46030b881a9b2dcea352293df4c6a5656eab。
同时验证原 formal plan、29 个 correctness cases、18 个 workloads 和资格状态。

Onboarding 的 build/API/test/benchmark 静态发现、Pi 只读调查、声明式 Draft 与调查 evidence 已实现。它不执行 build/test probe，build proposal 和静态 call_path 尚未经执行证明；未知字段、占位命令和待审 oracle 必须交由 Owner。

Baseline/Build Freeze、目标机 qualification、Owner Qualification 和 Evidence/Approval 仍需要操作者组织；不存在一个从 package init 自动执行到 Approved 的命令。当前成功案例的领域审批与 CLI 审批并合并是不同路径，见[生命周期指南](optimization-workflow.md#qualification-与-approval-的区别)。

Schema/Loader 能记录 generic binary-bundle identity，但 [task-definition](../../src/library-package/task-definition.ts) 的正式执行映射仍拒绝该 baseline kind；不能把“可加载描述”写成“Formal staging 已可用”。相关外部 baseline 资料属于[历史调查](../history/legacy-and-external-baselines.md)，IPPI 当前使用 frozen self baseline。
