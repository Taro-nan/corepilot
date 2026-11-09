# PhyOpt 产品需求文档（PRD）

> 面向飞腾 CPU 的自动性能工程系统
> 版本：v1.0｜日期：2026-09-24｜参考：Meta KernelEvolve / Capacity Efficiency Agent

PhyOpt

产品需求文档（PRD）

面向飞腾 CPU 的自动性能工程系统

参考 Meta KernelEvolve 的“搜索 + 真实评测 + 知识复用”范式，并针对 CPU 基础软件优化重新设计

版本：v1.0日期：2026-09-24状态：总体架构 / 产品基线

## 文档控制

| 字段 | 内容 |
| --- | --- |
| 产品名称 | PhyOpt |
| 文档 | Product Requirements Document |
| 版本 | v1.0 |
| 日期 | 2026-09-24 |
| 产品定位 | 面向飞腾 CPU 的自动性能工程系统 |
| 当前实现基线 | 现有 phyopt-agent 项目：CLI、Model/Agent、Git Candidate、SSH、Validation、Revalidation、Approval 等骨架 |
| 主要外部参考 | Meta KernelEvolve（2026）及 Meta Capacity Efficiency Agent 平台（2026） |
| 原则 | 渐进改造现有项目；不推倒重写；先建立可信真机闭环，再演进搜索与经验复用 |

## 0. 执行摘要

PhyOpt 的目标不是再做一个 Coding Agent，而是把“性能工程师在真实 CPU 上反复分析、修改、构建、验证、测量、比较、复验”的过程产品化。系统的智能来源可以替换，但最终裁判必须是受控的真实飞腾 CPU 实验。

产品采用 Control Plane + Execution Plane 的总体架构：控制面运行在开发机或管理节点，负责任务、Agent、候选、实验、证据、恢复与人工审批；执行面运行在飞腾 ARM Linux 目标机，以轻量 phyopt-runner 执行 Machine Probe、资源控制、构建、Formal Correctness、Formal Benchmark 与原始数据采集。控制面与执行面使用稳定 RPC Contract 通信；SSH 保留为 runner 的部署、初始化、升级和应急运维通道。

长期上，PhyOpt 将逐步从“单候选闭环”演进为“多候选搜索 + 历史经验复用 + Experience-guided Search + 跨飞腾 CPU 代际的 Performance Intelligence”。但这些能力必须建立在可信 Experiment / Measurement / Evidence 数据之上。

核心产品公式：Model/Agent 提出候选 + PhyOpt 管理实验 + 真实硬件裁决 + Evidence 记忆 + Search/Experience 持续进化。

第一优先级：可信 > 可恢复 > 可复现 > 自动化 > 智能程度。

当前首个真实目标：S5000C 上的 SGEMV-N，用它验证系统，而不是把产品绑定到 BLAS。

V1 不以“支持多少模型”或“有多少 Agent”作为价值指标；以真实可验证的性能工程效率作为指标。

## 1. 外部参照：Meta KernelEvolve 给 PhyOpt 的启发

用户记忆中的 Meta 类似系统是 KernelEvolve。Meta 公开披露的 KernelEvolve 将 kernel 优化形式化为搜索问题：LLM 生成候选，长期 job harness 编译并验证 correctness/performance，搜索引擎在大量候选间选择与继续探索，同时利用硬件知识、历史信号与持续积累的数据来改进后续搜索。[R1][R2]

Meta 公开架构中最值得 PhyOpt 参照的不是某个具体模型，而是六类系统能力：LLM Synthesizer、Tree Search Engine、Retrieval-Augmented Knowledge Base、Automated Evaluation Framework、Shared Data Foundation，以及后续 Agentic Reinforcement Learning。Meta 还公开了另一个更高层的 Capacity Efficiency Agent 平台，以标准化工具接口和 Skills 编码性能工程知识，用于性能机会发现与回归修复。[R3]

| Meta KernelEvolve 能力 | PhyOpt 对应设计 | V1 是否实现 | 说明 |
| --- | --- | --- | --- |
| LLM Synthesizer | Model / Agent Adapter + Optimization Agent | 是（基础版） | 保留现有 Pi Agent / 多模型适配，Agent 负责分析与候选生成。 |
| Tree Search Engine | Search Engine / Candidate Set | 否，后续 | V1 先单 lineage；可信 Experiment 成熟后再增加多候选搜索。 |
| RAG Knowledge Base | Hardware Knowledge + Optimization Experience | 部分/后续 | V1 先保存可靠事实；不把历史文档直接当知识规则。 |
| Automated Evaluation Framework | Trusted Evaluator + phyopt-runner | 是（核心） | 这是 V1 最关键能力：正确性、性能、资源、身份和证据都由真实硬件裁决。 |
| Shared Data Foundation | Experiment / Measurement / Evidence Store | 是（核心） | 所有成功/失败实验都成为长期资产。 |
| Agentic RL | Specialized Performance Model / RL | 否，远期 | 只有有足够高质量 reward/evidence 数据后才有意义。 |

关键差异：KernelEvolve 主要公开聚焦 AI kernel 与异构加速器；PhyOpt 第一阶段聚焦飞腾 CPU、Linux、C/C++/Assembly 和基础软件。CPU 场景要求更强的线程、CPU affinity、NUMA、cache/memory、toolchain、动态链接和系统噪声控制，因此 PhyOpt 的 Execution Context 与 Resource Control 必须成为一等能力。

## 2. 产品背景与问题定义

### 2.1 背景

CPU 的峰值硬件能力不会自动转化为软件性能。每一代 CPU 的微架构、缓存、内存、核心拓扑、NUMA、向量/矩阵指令和编译器行为变化，都会要求基础库与关键软件重新调优。性能工程师需要重复完成代码理解、profiling、假设、改写、构建、正确性、真机 benchmark、回退检查和复验。

问题的规模来自组合爆炸：CPU 代际 × 软件版本 × 函数/Kernel × workload × 数据规模 × 线程数 × 编译器 × 运行环境。单靠少数性能专家无法线性扩展。

### 2.2 核心问题

PhyOpt 要解决的核心不是“AI 会不会写优化代码”，而是 Hardware Capability → Software Performance 之间的转化效率。系统必须提高单位工程时间内产生可信有效改进的概率，并降低达到目标性能所需的人力、实验次数与机器时间。

### 2.3 产品机会

把性能优化从一次性人工活动变为可恢复、可重复、可审计的实验闭环。

把 Model/Agent 的开放式推理约束在确定性 evaluator 与真实硬件事实中。

把每次优化产生的成功/失败 Experiment 变成结构化资产，为后续搜索与经验复用提供燃料。

让新飞腾 CPU 到来后可以复用既有软件、实验协议和知识，而不是从零开始。

## 3. 产品定位

产品定义：PhyOpt 是一个面向飞腾 CPU 的自动性能工程系统。它连接可插拔 Model/Agent、受控代码 Candidate、真实 ARM 执行环境、Trusted Evaluator、结构化 Experiment/Evidence 与 Human Approval，使性能优化成为连续、可验证、可积累的工程过程。

### 3.1 PhyOpt 不是什么

不是通用 Coding Agent；Agent 只是候选生成与分析组件。

不是通用 Workflow Builder；流程围绕性能工程的确定语义。

不是 Benchmark GUI；性能数字必须绑定 Candidate、Baseline、Evaluator 与 Context。

不是单一 BLAS Agent；SGEMV 只是首个 domain package。

不是单纯 RAG；历史材料没有 Evidence 不能自动升级成知识。

不是一开始就做 RL / Knowledge Graph / 任意硬件平台。

## 4. 产品愿景与目标

### 4.1 北极星

长期北极星：缩短飞腾 CPU 从“硬件可用”到“关键软件性能成熟”的 Time to Peak Performance。这里的 Peak 不是理论峰值，而是在明确 workload、正确性、资源和工程约束下经验证的成熟性能。

### 4.2 V1 目标

在一台真实飞腾 ARM Linux 机器上，对一个真实基础库函数完成 Agent → Candidate → Build → Correctness → Benchmark → Feedback → Revalidation → Approval 的闭环。

所有正式结果都有可追溯的 Candidate、Binary、Baseline、Evaluator、Execution Context、Raw Measurement 与 Failure Semantics。

控制面与执行面解耦；RPC 承载正式实验语义，SSH 仅用于 bootstrap / maintenance / fallback。

不推倒现有项目；逐步把 public optimize、TaskHost 中有价值的 runtime 能力和当前 SSH/Validation 资产统一到新模型。

### 4.3 中长期目标

多候选搜索：Candidate Set、公平 Comparison、Selection、Tree/Evolutionary Search。

硬件知识：飞腾 CPU 代际、拓扑、ISA、cache/memory 与已验证优化模式。

Experience：从多次 Evidence 中形成带适用范围与置信度的可复用经验。

Experience-guided Search：历史经验参与候选生成、排序与机器预算分配，并通过 A/B 实验证明价值。

从函数/Kernel 扩展到库级、Runtime、Compiler、Database/Storage/Network/AI inference 等性能领域。

## 5. 用户与典型角色

| 角色 | 主要诉求 | PhyOpt 提供的价值 |
| --- | --- | --- |
| 基础软件/高性能库工程师 | 快速定位并优化热点函数；保证正确性与跨 case 回归 | 自动实验闭环、候选管理、真机评测、Evidence、复验 |
| Performance Engineer | 硬件-aware 分析、资源控制、稳定测量、问题归因 | Machine/Resource Context、benchmark、profiling hooks、历史实验 |
| CPU 软件使能团队 | 新 CPU 上快速建立软件性能成熟度 | 硬件接入、自动重新验证、跨代经验迁移 |
| Evaluator / 验证负责人 | 确保测试、benchmark、policy 不被候选污染 | Trusted Evaluator、版本/identity、formal gate |
| 工程负责人 / Approver | 决定候选是否可交付 | Evidence Package、diff、回退、适用范围、审计记录 |

## 6. 总体架构

架构原则：Control Plane 与 Target Execution Plane 必须分离。Control Plane 负责不确定智能与全局编排；Execution Plane 负责确定、可审计的真实执行。Runner 应尽量“笨”：它不负责产生优化想法，只负责严格执行实验。

### 6.1 部署模型

| 组件 | 默认部署位置 | 职责 |
| --- | --- | --- |
| CLI / Web UI | 开发机/管理节点 | 任务创建、状态、结果、审批 |
| Model / Agent | Control Plane | 分析、假设、候选代码、反馈迭代 |
| Optimization Runtime | Control Plane | 状态机、调度、恢复、预算、门禁 |
| SQLite / Artifact Store | Control Plane（初期） | Task/Candidate/Experiment/Measurement/Evidence/Approval |
| phyopt-runner | 飞腾 ARM 目标机 | 稳定 RPC、job lifecycle、Machine/Resource/Build/Evaluator/Artifact |
| Formal Evaluator | 目标机受控信任域 | 正确性与性能裁判 |
| SSH | Control ↔ ARM | bootstrap、部署、升级、诊断、fallback；不作为核心 Experiment 生命周期 |

## 7. 核心产品对象与关系

Optimization Task

├─ Baseline

├─ Evaluator + Evaluation Policy

├─ Declared Execution Context

└─ Candidate lineage

└─ Candidate

└─ Experiment(s)

├─ Observed Execution Context

├─ Measurement(s)

└─ Evaluation Result

└─ Evidence

└─ Revalidation

└─ Human Approval

| 对象 | 定义 | 关键身份/关系 |
| --- | --- | --- |
| Optimization Task | 一个有目标、范围、baseline、workload、资源、预算和接受条件的优化任务 | task_id；包含多个 Candidate |
| Candidate | 某一轮冻结的待验证代码状态 | candidate_id、parent、source tree/hash、diff、agent identity |
| Experiment | 固定 Candidate 在固定 Evaluator/Context 下的一次可追踪执行 | experiment_id、purpose、candidate、baseline、evaluator、context |
| Measurement | Evaluator 直接产生的原始观察 | sample/case id、raw value、unit、stdout/stderr、artifact refs |
| Evaluation Result | 按冻结 policy 对 measurements 的判定 | correctness/perf/validity/threshold result |
| Evidence | 支持有限 claim 的 Measurement + identities + context + result | claim scope、completeness、validity |
| Approval | 人类对 Candidate + 限定 claim 的工程决定 | approver、decision、reason、time、scope |
| Experience（后续） | 从多个 Evidence 归纳且经过验证的可复用知识 | scope、confidence、provenance、supersession |

## 8. 核心优化闭环

工程师创建 Optimization Task，定义目标函数/Kernel、source baseline、performance baseline、workload、correctness、性能门槛、资源和预算。

Agent 读取源码、硬件上下文、允许的历史知识与上一轮 Evidence，形成可证伪 Hypothesis。

Agent 修改 Candidate domain；checkpoint 后形成不可歧义的 candidate identity。

Control Plane 通过 RPC 提交 Experiment；Runner staging Candidate，并核验 evaluator/baseline/candidate identities。

Runner 按资源策略在飞腾 ARM 上 build → formal correctness → formal performance，持续写入 durable job state 与 raw results。

Control Plane 持久化 Experiment / Measurement / Evidence，并把结构化反馈而非大段日志发送给 Agent。

未达目标则 Agent 创建后继 Candidate；达到门槛则冻结 Candidate 并执行独立 Revalidation。

Evidence 完整且复验通过后，Human Approver 查看 diff、context、raw/summary、回退与风险后批准或拒绝。

## 9. Control Plane 产品需求

### 9.1 Optimization Runtime

| ID | 优先级 | 需求 | 验收条件 |
| --- | --- | --- | --- |
| CP-RUNTIME-001 | P0 | 系统必须只有一套正式 Optimization Runtime；public optimize 与旧 TaskHost 不得长期维持两套正式产品语义。 | CLI 创建的真实任务、恢复、取消、状态、审批均通过同一 runtime。 |
| CP-RUNTIME-002 | P0 | 运行状态必须可持久恢复，不能依赖进程内 Promise/AbortController 作为唯一事实。 | 后台重启后可列出 Task/Candidate/Experiment，非终态远端执行进入 reconcile。 |
| CP-RUNTIME-003 | P0 | 运行时必须区分 Candidate failure、Evaluator/Infrastructure failure、INVALID 与 UNKNOWN。 | 任一场景不会被压缩为单一 FAILED；UI/记录能展示原因。 |
| CP-RUNTIME-004 | P1 | 支持预算与停止条件。 | 达到实验数/模型预算/时间/人工停止后安全结束，不制造成功状态。 |

### 9.2 Model / Agent Adapter

| ID | 优先级 | 需求 | 验收条件 |
| --- | --- | --- | --- |
| AGENT-001 | P0 | 模型/Agent 是可替换的 Intelligence Provider，不能绑定核心实验语义。 | 替换模型不改变 Experiment/Evidence 结构及 evaluator 规则。 |
| AGENT-002 | P0 | Agent 只能写 Candidate domain。 | 对 formal evaluator、baseline、policy 的写请求被拒绝并记录。 |
| AGENT-003 | P0 | Agent 必须接收结构化反馈：build error、failed correctness cases、per-workload performance、regression。 | 下一轮 prompt/context 可定位上一轮失败/收益；原始日志仍保留在 store。 |
| AGENT-004 | P1 | 记录 Agent identity、provider/model、关键配置、hypothesis、candidate reason、使用成本。 | 任一 Candidate 可追溯其生成来源。 |
| AGENT-005 | P2 | 未来允许多 Agent/专用 Agent，但不影响 evaluator 与 runtime contract。 | 新增 Agent 不要求修改 Runner/Evidence 语义。 |

### 9.3 Candidate Manager

| ID | 优先级 | 需求 | 验收条件 |
| --- | --- | --- | --- |
| CAND-001 | P0 | 每轮 checkpoint 都必须形成稳定 Candidate identity，不能只保存“当前 HEAD”。 | 失败/旧 Candidate 可恢复，且性能结果能绑定精确源码状态。 |
| CAND-002 | P0 | 记录 parent、diff、source tree/hash、changed files、hypothesis、agent identity。 | 任一 candidate lineage 可被重建。 |
| CAND-003 | P0 | Candidate 进入 formal experiment 后冻结；修改必须产生新 Candidate。 | 同一 experiment 执行期间 candidate identity 不变。 |
| CAND-004 | P1 | 为未来 Candidate Set/Search 保留并列候选能力，但 V1 不要求多候选调度。 | 数据模型不依赖单一“latest_candidate”字段。 |

### 9.4 Experiment / Evidence Manager

| ID | 优先级 | 需求 | 验收条件 |
| --- | --- | --- | --- |
| EXP-001 | P0 | Formal Experiment 在开始前获得 stable experiment_id 并持久化计划。 | 进程崩溃后可知道它原计划做什么。 |
| EXP-002 | P0 | 每个关键步骤完成后 durable 保存状态、时间、artifact identity、stdout/stderr、raw measurements。 | 重启后不会因为 summary 丢失而无法审计。 |
| EXP-003 | P0 | Measurement 与 Evidence 分离。 | 单次 timing 不会自动成为“性能提升”结论。 |
| EXP-004 | P0 | 失败、回退、未达标、取消、INVALID、UNKNOWN 均保留。 | 下一轮不会覆盖上一轮数据。 |
| EVID-001 | P0 | Evidence claim 必须绑定 Candidate/Baseline/Evaluator/Context/Measurements。 | 缺任一关键 identity 时 claim 标记 incomplete 且不可批准。 |
| EVID-002 | P1 | Evidence 可导出为可审阅 package。 | 第二名工程师可据包理解和复现实验。 |

## 10. Execution Plane / phyopt-runner 产品需求

Runner 是飞腾目标机上的轻量执行服务。它负责“可靠地做”，不负责“决定做什么”。Runner 接收已声明的 Experiment，管理本机资源和作业状态，执行 Build/Correctness/Benchmark，并返回可核验事实。

| ID | 优先级 | 需求 | 验收条件 |
| --- | --- | --- | --- |
| RUNNER-001 | P0 | 提供稳定版本化 RPC Contract。 | Control Plane 不需要拼接 shell 即可提交/查询/取消实验。 |
| RUNNER-002 | P0 | 远端 job identity 与网络连接解耦。 | RPC/SSH 中断后 job 状态仍可查询。 |
| RUNNER-003 | P0 | Machine Probe 返回实际 CPU/NUMA/OS/kernel/toolchain/runner version。 | 每个 experiment 保存 observed machine context。 |
| RUNNER-004 | P0 | Resource Manager 强制 CPU affinity、NUMA、thread policy。 | 故意配置冲突时实验不启动或标 INVALID。 |
| RUNNER-005 | P0 | Candidate Staging 只接收固定 candidate artifact/source，并核验 digest。 | 远端运行的源码/二进制能追溯到 candidate。 |
| RUNNER-006 | P0 | Build Service 记录命令、env、toolchain、stdout/stderr、binary identity。 | build 成功后能证明测的是哪个 binary。 |
| RUNNER-007 | P0 | Formal Evaluator 与 Candidate 写域隔离。 | candidate 修改 evaluator 的尝试无法影响正式结果。 |
| RUNNER-008 | P0 | Benchmark Runner 实现 warmup、repeated samples、raw retention、per-workload output。 | 正式性能结论不依赖单次 timing。 |
| RUNNER-009 | P0 | Artifact Manager 保存 binary/log/raw result，并提供 digest。 | Control Plane 拉取结果后可验证内容身份。 |
| RUNNER-010 | P1 | Runner 支持安全 cancel/reconcile。 | Cancel request 与真正 CANCELLED 状态可区分。 |

## 11. RPC 与 Transport 设计要求

V1 建议实现 HTTP/JSON RPC，后续如出现多语言、高吞吐、强流式需求，可无损迁移为 gRPC。产品抽象是 RPC Contract，不把 HTTP/JSON 固化为业务语义。

| RPC | 用途 | 最低语义 |
| --- | --- | --- |
| GET /health | Runner 健康/版本 | runner_id、version、time、capabilities |
| GET /machine | 机器事实 | machine/CPU/topology/NUMA/OS/kernel/toolchain/resources |
| POST /experiments | 提交实验 | experiment_id、candidate/evaluator/baseline refs、resource policy、steps |
| GET /experiments/{id} | 状态查询 | PENDING/RUNNING/SUCCEEDED/FAILED/CANCELLED/UNKNOWN + current step |
| POST /experiments/{id}/cancel | 请求取消 | cancel_requested；只有确认终止后才 CANCELLED |
| GET /experiments/{id}/measurements | 拉取 measurement | raw case/sample values + identities/context refs |
| GET /experiments/{id}/artifacts | 获取产物索引 | binary/log/result refs + digest |
| POST /experiments/{id}/reconcile | 状态核对 | 网络中断/后台恢复后的远端事实确认 |

SSH 保留为 runner bootstrap/update/diagnostics/fallback；不得继续让“SSH 子进程是否还连接”成为 Experiment 是否存在的唯一依据。

## 12. Trusted Evaluator

Trusted Evaluator 是 PhyOpt 与普通 Coding Agent 的分水岭。Agent 负责提出答案，Evaluator 负责否定或支持答案。二者必须有清晰信任边界。

| ID | 优先级 | 需求 | 验收条件 |
| --- | --- | --- | --- |
| EVAL-001 | P0 | Formal Evaluator 必须有 owner、version、identity。 | 每个正式 Experiment 指向唯一 evaluator identity。 |
| EVAL-002 | P0 | Candidate 无法修改 correctness oracle/cases、benchmark/workload、baseline artifact、measurement policy。 | 受控越界测试会被拒绝；digest 在执行前后匹配。 |
| EVAL-003 | P0 | Development Feedback 与 Formal Evaluation 必须在数据/UX 中区分。 | Agent 自测 success 永远不能满足 approval gate。 |
| EVAL-004 | P0 | Evaluator 输出必须可解析且 raw output 保留。 | parser failure 归类为 Evaluator Failure，不得推导成功。 |
| EVAL-005 | P1 | Evaluator policy 变更产生新 identity，不静默覆盖旧 Evidence。 | 历史结果仍可解释其原评测口径。 |

## 13. Correctness 需求

| ID | 优先级 | 需求 | 验收条件 |
| --- | --- | --- | --- |
| CORR-001 | P0 | 正式 correctness 不能仅以 exit code == 0 判定。 | 记录计划/实际 case、每 case 结果、coverage、failed/inconclusive。 |
| CORR-002 | P0 | 每个 case 有 case/input/reference/tolerance identity。 | 结果可解释并可复验。 |
| CORR-003 | P0 | Build Failure 时 correctness=NOT_EXECUTED。 | 状态语义不混淆。 |
| CORR-004 | P0 | 必需 case 未运行、reference/tolerance/context 不可核验时结果为 INVALID/UNKNOWN。 | 不得误判 PASS。 |
| CORR-005 | P1 | 领域 evaluator 可以自定义 correctness semantics，但通用 Core 不携带 BLAS 专用 m/n 字段。 | 未来 Image/Compression 能接入而无需修改 Core。 |

## 14. Performance Measurement 需求

| ID | 优先级 | 需求 | 验收条件 |
| --- | --- | --- | --- |
| PERF-001 | P0 | Baseline/Candidate 在相同 workload、Evaluator 和关键 context 下测量。 | 上下文差异会使实验 INVALID 或重新执行。 |
| PERF-002 | P0 | 每 workload 支持 warmup + N 个 raw samples。 | 所有样本可下钻，N 来自 policy/calibration。 |
| PERF-003 | P0 | 保存执行顺序；建议 baseline/candidate 成对或平衡交错。 | 避免固定顺序偏差。 |
| PERF-004 | P0 | V1 至少支持 median 与 per-workload speedup；raw samples 永远保留。 | summary 可从 raw data 重算。 |
| PERF-005 | P0 | critical workload 有独立 regression gate，aggregate gain 不能掩盖关键回退。 | 历史 SGEMV 类“总体快但 wide case 退化”能被拒绝。 |
| PERF-006 | P0 | Outlier 不得事后随意删除；只有预声明无效原因可标 invalid。 | 被排除样本及原因仍保留。 |
| PERF-007 | P1 | 支持简单 uncertainty/stability 规则；复杂 bootstrap 可作为可选策略。 | V1 不因追求完美统计变成 HPC 平台。 |
| PERF-008 | P2 | Profiling counters 可作为诊断信号反馈 Agent，不是 V1 speedup 必需证据。 | 无 profiler 也能完成 V1 正式评测。 |

## 15. Hardware Context 与 Resource Control

| 维度 | 必须记录/控制的内容 |
| --- | --- |
| Hardware | machine identity、Phytium CPU identity、architecture、core/socket/topology、NUMA |
| Resources | CPU set、NUMA nodes、thread count、formal resource reservation/conflict state |
| Software | OS、kernel、compiler/toolchain、关键依赖、环境变量、动态链接对象 |
| Machine State | 至少记录影响首个 workload 的关键负载/频率/运行时状态；具体 policy 通过校准确定 |
| Artifacts | source baseline、performance baseline binary、candidate source/binary、benchmark/evaluator identity |
| Measurement | workload、policy、sample order、timestamps、runner/evaluator version |

| ID | 优先级 | 需求 | 验收条件 |
| --- | --- | --- | --- |
| HW-001 | P0 | Declared Context 与 Observed Context 同时保存。 | 不能仅保存 YAML 声明值并假设它已生效。 |
| HW-002 | P0 | CPU affinity/NUMA/threads 必须由 Runner 实际施加并观测。 | 配置不存在/失效时正式性能实验 INVALID。 |
| HW-003 | P0 | 两个冲突的 Formal Experiments 不得同时占用同一受控资源。 | 资源冲突测试会等待/拒绝而不是并发测量。 |
| HW-004 | P1 | Hardware Adapter 允许新增飞腾 CPU 代际，而不改 Task/Candidate/Evidence 核心语义。 | 新增 CPU 主要扩展 probe/knowledge/policy。 |

## 16. Persistence 与数据模型（产品层）

V1 继续使用 SQLite；不因架构升级引入分布式数据库。关键是把“latest workflow summary”演进为 append-oriented 的真实实验事实。

| 实体 | V1 必须持久化 |
| --- | --- |
| Task | 目标、范围、baseline、evaluator、workload、资源、budget、status |
| Candidate | candidate_id、parent、source/tree/hash、diff、hypothesis、agent identity、created_at |
| Experiment | experiment_id、candidate/baseline/evaluator、declared/observed context、lifecycle、validity、failure category |
| Measurement | case/sample id、role、raw value、unit、stdout/stderr refs、timestamps、artifact refs |
| Evidence | claim、scope、summary、measurement refs、correctness/perf/revalidation completeness |
| Approval | approver、decision、reason、time、scope、delivery result |
| Artifact | type、path/ref、digest、size、producer、retention class |

设计约束：失败实验必须和成功实验一样被保存；重试创建新 attempt/Experiment，不覆盖原记录；未来 Experience 不能直接读取“日志”作为规则，而必须从 Evidence 开始归纳。

## 17. Failure Semantics 与状态

| 类别 | 含义 | 后续行为 |
| --- | --- | --- |
| Build Failure | Candidate 无法产生 artifact | 反馈 Agent；Correctness/Performance=NOT_EXECUTED |
| Correctness Failure | 有效 formal case 失败 | 不得进入正式 performance acceptance；可生成后继 Candidate |
| Performance Regression | 有效测量触发回退边界 | 保存并反馈；不得批准 |
| Performance Target Not Met | 无阻塞回退但未达到目标 | 可继续迭代或按预算结束 |
| Infrastructure Failure | 网络/磁盘/宿主故障 | 不归因 Candidate；按 policy 重试 |
| Resource Unavailable | CPU/NUMA 等资源不可获得 | 等待/拒绝/重排，不产生 claim |
| Evaluator Failure | oracle/benchmark/parser 故障 | 不判 Candidate 对错；修复 evaluator 后新实验 |
| Remote UNKNOWN | 无法确认远端状态 | reconcile；不得自动 success/fail/retry |
| Cancelled | 已确认终止 | 保留取消人、时间、阶段、远端确认 |
| Agent Failure | 模型/工具/预算失败 | 不破坏已有 Candidate/Experiment 事实 |
| Invalid Experiment | 边界/identity/context/policy 违反 | 数据可诊断但不得进入 Formal Evidence |

## 18. Revalidation 与 Human Approval

| ID | 优先级 | 需求 | 验收条件 |
| --- | --- | --- | --- |
| REVAL-001 | P0 | 候选达到门槛后冻结，不再允许 Agent 修改。 | 任何修改产生新 Candidate 并重新 formal evaluation。 |
| REVAL-002 | P0 | Revalidation 创建独立 Experiment，重新跑完整 Formal Correctness 与 primary Performance。 | 不能复用旧 summary；产生新 raw samples/evidence。 |
| REVAL-003 | P0 | 复验失败/INVALID/UNKNOWN 均阻止 Approval。 | 系统无法绕过 gate。 |
| APP-001 | P0 | Approval 页面/CLI 展示 diff、hypothesis、correctness、performance、raw/summary、context、revalidation、limitations。 | Approver 无需读 DB/日志即可判断。 |
| APP-002 | P0 | Approve/Reject/Request another iteration 都是 durable decision。 | 审批历史不可被后续候选覆盖。 |
| APP-003 | P0 | 只有 Human Approval 后才能 merge/deliver。 | Agent/自动阈值无法自行交付。 |

## 19. CLI / UX 需求

| 能力 | 用户看到/能做什么 |
| --- | --- |
| Create Task | 定义 target/function/baseline/evaluator/workload/resources/budget；显示缺失项 |
| Run | 启动前显示冻结摘要、目标机、Evaluator、资源和预算 |
| Observe | 当前 Task/Candidate/Experiment/remote job/step/resource/confirmed events |
| Inspect Candidate | identity、parent、diff、hypothesis、Agent、关联 Experiment |
| Inspect Experiment | lifecycle、validity、context、commands/actions、logs、failure category |
| Inspect Evidence | claim、case/coverage、raw/summary performance、revalidation、scope/limitation |
| Cancel | 显示 cancel requested 与 confirmed cancelled 的差异 |
| Resume/Reconcile | 重启后区分 safe resume、rerun、UNKNOWN、human intervention |
| Approve/Reject | 展示责任范围并记录具名理由 |
| History | 列出真实 Optimization Tasks；Mock task 不再混入正式 UX |

## 20. 安全与信任边界

| ID | 优先级 | 需求 | 验收条件 |
| --- | --- | --- | --- |
| SEC-001 | P0 | API Key/私钥不得进入 Experiment Evidence、stdout 导出或 Artifact Package。 | 安全扫描/测试无明文 secret。 |
| SEC-002 | P0 | Runner 采用最小权限；Candidate 不得写 evaluator/baseline/policy 路径。 | 越权写入失败并有审计事件。 |
| SEC-003 | P0 | RPC 必须有身份认证；默认不允许匿名远端提交。 | 未认证请求不能创建/查询敏感 Experiment。 |
| SEC-004 | P1 | Artifact/命令输出需防路径穿越与任意文件读取。 | 恶意 path/ref 测试被拒绝。 |
| SEC-005 | P1 | 正式命令模板与 user-provided args 分离并严格转义/白名单。 | 避免 shell injection 破坏目标机。 |

## 21. 可恢复性、可靠性与运维

| ID | 优先级 | 需求 | 验收条件 |
| --- | --- | --- | --- |
| REL-001 | P0 | Control Plane 重启后能恢复所有已知 Task/Candidate/Experiment 事实。 | 故障注入后不丢完成步骤。 |
| REL-002 | P0 | Runner job 状态独立于单次 RPC/SSH 连接。 | 客户端断开后 status 可重新查询。 |
| REL-003 | P0 | UNKNOWN 状态必须显式存在。 | 远端不确定时不会误报成功或重复执行。 |
| REL-004 | P1 | Runner/Control 协议版本兼容并可拒绝不兼容任务。 | 版本不匹配时明确失败，不产生不可解释结果。 |
| REL-005 | P1 | Artifact 与 DB 之间有一致性检查。 | 缺失/损坏 artifact 会标记 Evidence incomplete。 |

## 22. Observability

结构化事件：Task/Candidate/Experiment lifecycle、RPC、resource acquire/release、evaluator result、approval。

指标：active experiments、queue/wait、build/correctness/perf durations、failure categories、runner availability、resource utilization。

日志：Control 与 Runner 分开，但可通过 task_id/experiment_id/candidate_id 关联。

用户可见 status 不直接暴露秘密或海量 stdout；原始日志作为 Artifact 下钻。

## 23. 第一套 Domain Package：SGEMV-N / S5000C

首个目标用于验证 PhyOpt 系统，不代表产品长期绑定 SGEMV。目标：S5000C / TARGET=FT2000 环境中的 float32、column-major、NoTrans cblas_sgemv；主要代码入口 kernel/arm64/gemv_n.S，必要时涉及 driver/level2/gemv_thread.c 及相关调用链。

| 部分 | V1 设计 |
| --- | --- |
| Source Baseline | 优先从可恢复的 pre-opt baseline 开始；否则使用当前已验证源码状态。最终选项需在真机构建前确认。 |
| Formal Correctness | 以现有参数化 suite/guard/reference 素材为基础统一成唯一 inventory；覆盖 zero/small/odd/LDA/stride/alpha-beta/boundary/multithread/shared-path regression。 |
| Formal Benchmark | 复用现有 benchmark asset 思路：相同 benchmark source 分别绑定 baseline/candidate，运行时核验实际动态加载对象。 |
| Workload | 从现有 square/wide/tall/large/boundary/1-8-16 thread matrix 中由性能负责人冻结 critical + diagnostic workloads。 |
| Measurement | warmup + repeated samples + median + raw retention + critical regression gate；sample count/loops 通过 S5000C A/A calibration 决定。 |
| Resources | CPU set/NUMA/thread 由 Runner 实际施加并记录；历史 0-15/NUMA0 只作为候选配置，不自动视为事实。 |
| Approval | Candidate 达标后完整 revalidation，再由负责 SGEMV 代码与性能的工程师批准。 |

## 24. 产品需求优先级汇总

| 级别 | 定义 | 当前重点 |
| --- | --- | --- |
| P0 | 没有就无法形成可信产品核心 | 统一 Runtime、Runner/RPC、Evaluator isolation、Experiment/Measurement/Evidence、真实资源控制、raw data、revalidation、approval |
| P1 | 核心成立后必须尽快补足 | 更完整恢复、Hardware Adapter、Evidence Package、Agent identity/cost、protocol compatibility、security hardening |
| P2 | 有明显价值但不阻塞 V1 | Profiling integration、OpenBLAS/KML secondary context、更丰富 UI、model comparison |
| P3/未来 | 依赖高质量数据基础 | Multi-candidate Search、Knowledge/Experience、Agentic RL、自动 Model Router、跨平台/跨代大规模优化 |

## 25. 非功能需求（NFR）

| ID | 优先级 | 需求 | 验收条件 |
| --- | --- | --- | --- |
| NFR-001 | P0 | 可复现：同一 Evidence Package 必须包含足够信息供另一名工程师复跑。 | 独立复现实验达到预定义一致性标准。 |
| NFR-002 | P0 | 可审计：每个正式结论能回到 raw Measurement。 | summary 删除后仍可基于 raw data/policy 重算。 |
| NFR-003 | P0 | 隔离：Formal Experiment 不被并发冲突资源污染。 | 冲突实验被等待/拒绝。 |
| NFR-004 | P0 | 兼容：控制面不要求与目标机相同架构。 | x86/Windows/Linux 控制端可管理 ARM Runner。 |
| NFR-005 | P1 | 可扩展：新 CPU/Agent/domain 不重写核心 Task/Candidate/Experiment/Evidence。 | 新增 adapter/package 的变更局部化。 |
| NFR-006 | P1 | 性能：Runner 控制开销不得显著污染被测 CPU workload。 | 正式 benchmark 时 Runner 控制线程避开受测资源或满足校准策略。 |
| NFR-007 | P1 | 可维护：clean checkout build/typecheck/test/package 均可复现。 | CI/本地 clean tree 通过。 |

## 26. 成功指标与产品 KPI

| 指标 | 定义 | 为什么重要 |
| --- | --- | --- |
| Time to First Valid Improvement | 从 Task 启动到首个通过 correctness 且有正向可信性能结果的时间 | 衡量早期搜索/Agent效率 |
| Time to Target Performance | 到达接受门槛并完成 Revalidation 的时间 | 对应 Time to Peak Performance |
| Experiments to Target | 达到目标前有效正式实验数 | 衡量搜索与经验复用效率 |
| Best Verified Speedup | 限定 workload/context 下复验后的最佳收益 | 核心输出但不得脱离 scope |
| Candidate Build-valid Rate | 候选可成功构建比例 | Agent 与代码理解质量 |
| Correctness Pass Rate | 通过 formal correctness 的候选比例 | 候选质量；不能通过削弱测试改善 |
| Regression Rate | 已接受优化在其他规定 workload/复验中的回退率 | 衡量稳定性 |
| Reproducibility Rate | 独立复现实验结论一致比例 | 产品可信度 |
| Human Engineering Hours Saved | 相对人工流程节省的专家时间 | 产品真实 ROI |
| Machine Time / Accepted Optimization | 每个接受结果消耗的目标机时间 | 防止暴力搜索失控 |
| Model Cost / Accepted Optimization | 模型 token/API 成本 | 为未来模型路由提供依据 |
| Knowledge Reuse Lift（后续） | 有/无 Experience 时对 Time/Experiments 的改善 | 验证知识飞轮而非假设它存在 |

## 27. 版本路线图

| 版本 | 目标 | 关键能力 | 明确不做 |
| --- | --- | --- | --- |
| V1 — Reliable Closed Loop | 把现有产品变成可信的真实 ARM 单候选自动优化系统 | Control/Execution split、Runner/RPC、统一 runtime、Candidate/Experiment/Measurement/Evidence、Formal Evaluator、SGEMV 真机、revalidation/approval | Multi-candidate、Knowledge/RL、复杂 GUI |
| V1.5 — Domain & Hardware Extensibility | 证明不是 SGEMV 专项工具 | 第二个非 BLAS domain package、新飞腾 CPU adapter、Evidence Package、better profiling | 大规模 search |
| V2 — Search | 把候选探索变成显式搜索 | Candidate Set、Comparison、Selection、Search budget、AutoTuner、并行实验 | RL/自训练 |
| V3 — Experience | 让历史数据真正减少重复探索 | Experience curation/retrieval、scope/confidence、A/B validation、anti-knowledge | 未经验证规则自动注入 |
| V4 — Performance Intelligence | 跨代、跨库持续优化 | Experience-guided search、model routing/ranking、specialized performance model、CPO | 无限制全栈自治 |

## 28. 从现有项目到目标架构的渐进改造

改造原则：保留已经工作的真实资产，重构错误责任边界，停止投入与新产品不一致的旧路径。

| 现有模块/能力 | 处理方式 | 目标去向 |
| --- | --- | --- |
| CLI / Interactive UI | EVOLVE | 继续作为用户入口，改为展示真实 Task/Experiment/Evidence；不展示 mock recent activity。 |
| Model integration / Pi Agent | KEEP + EVOLVE | 保留；补 identity、structured feedback、权限边界。 |
| Git candidate/worktree | KEEP + EVOLVE | 保留强 source identity；把每轮 checkpoint 变成独立 Candidate。 |
| OptimizationWorkflowService / public workflow | REWORK | 真实功能保留并迁入统一 Optimization Runtime。 |
| TaskHost state/lease/reconcile 思想 | REUSE | 把 durable lifecycle 能力融合到真实 runtime；MockRunner 留作测试。 |
| Validation runner | REWORK | 从“命令启动器”变成 Experiment step adapter；formal evaluator 由 Runner 执行。 |
| SSH transport | EVOLVE | 降级为 bootstrap/maintenance；正式 Experiment 通过 Runner RPC。 |
| SQLite | KEEP + EVOLVE | 保留存储技术，重构为 Task/Candidate/Experiment/Measurement/Evidence/Approval。 |
| SGEMV assets | REWORK | 形成第一个 domain evaluator package；消除 YAML/script/CSV-JSON 不一致。 |
| VS Code extension | RETIRE/PAUSE | 不进入 V1；待核心模型稳定后重新评估。 |
| 旧 knowledge runtime/packaging | RETIRE/PAUSE | 不再阻塞 clean package；历史材料保留 reference。 |
| Mock task product path | TEST ONLY | 不再作为正式产品任务入口。 |

### 28.1 建议代码实施顺序

建立领域模型与持久化：Task / Candidate / Experiment / Measurement / Evidence / Approval；先兼容旧 workflow。

统一 Optimization Runtime：把 public optimize 的真实逻辑接到 durable state/recovery；MockRunner 保持测试角色。

实现最小 phyopt-runner + HTTP/JSON RPC：Health/Machine/Submit/Status/Cancel/Measurements/Artifacts/Reconcile。

迁移 remote build/correctness/performance 到 Runner；SSH 改为 runner bootstrap。

建立 Formal Evaluator trust domain 与 SGEMV domain package；修复 correctness/benchmark contract。

实现 CPU/NUMA/thread 资源控制、重复采样、raw Measurement persistence。

Revalidation + Evidence + Approval gate 完整闭环。

执行 S5000C 真实 E2E；根据真实失败再收敛 runtime、measurement、UX。

清理 legacy：旧 mock UX、VS Code、旧 knowledge packaging、双执行路径。

## 29. V1 验收标准

| ID | 验收标准 |
| --- | --- |
| AC-01 | 真实飞腾 CPU Linux 机器完成闭环，Evidence 有实际 machine/CPU identity。 |
| AC-02 | 真实基础库函数（首个 SGEMV-N）完成至少两轮 Candidate 修改。 |
| AC-03 | Formal Evaluator 有 owner/version/identity，Candidate 无法修改。 |
| AC-04 | 每轮 Candidate 独立持久化，不被下一轮覆盖。 |
| AC-05 | 每次 formal validation 形成独立 Experiment，build/correctness/performance 状态与失败语义清晰。 |
| AC-06 | Formal Correctness 记录实际 cases/coverage/reference/tolerance，而非只看 exit code。 |
| AC-07 | Performance 有 warmup、多个 raw samples、median、per-workload comparison 与 regression gate。 |
| AC-08 | CPU affinity、NUMA、thread 实际由 Runner 施加并记录。 |
| AC-09 | Candidate/Baseline 实际 binary identity 在 Measurement 中可核验。 |
| AC-10 | stdout/stderr/raw samples 重启后仍可下钻。 |
| AC-11 | SSH/RPC 中断不会把未知远端状态误判为成功/失败。 |
| AC-12 | 达到性能门槛后重新执行独立 Revalidation，生成新 raw Evidence。 |
| AC-13 | Revalidation 失败/INVALID/UNKNOWN 无法 Approve。 |
| AC-14 | 只有具名 Human Approver 才能交付/merge。 |
| AC-15 | 第二名工程师可以依据 Evidence Package 理解并在记录范围内复现实验。 |
| AC-16 | clean checkout 的 build/typecheck/tests/package 可复现，tests 不再依赖 ignored 本地资产。 |

## 30. 风险与缓解

| 风险 | 表现 | 缓解策略 |
| --- | --- | --- |
| 过度基础设施化 | 为了“可信”先造半年平台 | V1 只实现一台 S5000C、一个 domain、HTTP/JSON Runner、SQLite；复杂 scheduler/统计后置。 |
| Evaluator 被污染 | Agent 修改测试/benchmark 获得虚假 speedup | 物理/权限信任域 + digest + formal/development 双轨。 |
| 测量噪声污染知识 | 错误 +8% 被永久复用 | A/A calibration、重复样本、context/resource validity、revalidation，只有 Evidence 才可进入 Experience。 |
| 双 runtime 长期共存 | public optimize 与 TaskHost继续分裂 | 明确单一 Optimization Runtime；旧 task path 降级测试。 |
| Runner 变成复杂 Agent | 目标机资源被后台智能逻辑污染 | Runner 保持 deterministic/thin；Agent 只在 Control Plane。 |
| SGEMV 污染通用 Core | m/n/threads 等 BLAS 字段进入核心表/接口 | 领域 case/workload 放在 evaluator/domain package；Core 只认识通用 identity/context/result。 |
| 只追求 speedup | 通过选 workload/benchmark hack 得到漂亮数字 | scope、critical regression、baseline identity、human approval。 |
| 知识飞轮过早 | 把历史文档/RAG当“学习” | Experience 必须来自高质量 Evidence；先 A/B 验证再提升为核心能力。 |
| 模型依赖 | 某模型能力下降导致产品失效 | Model-agnostic adapter；核心价值是 runtime/evaluator/data/search。 |

## 31. 与 Meta KernelEvolve 的产品对照

| 维度 | Meta KernelEvolve（公开信息） | PhyOpt 设计 |
| --- | --- | --- |
| 主要对象 | AI kernels/operators across heterogeneous accelerators | CPU 基础软件/性能敏感函数，先飞腾 CPU |
| 智能生成 | LLM synthesizer，多语言/DSL | 可插拔 Model/Agent，C/C++/ASM 优先 |
| 搜索 | Tree/graph search，MCTS/evolutionary strategies | V1 单 lineage；V2 Candidate Set/Search/AutoTuner |
| 评估 | 自动 correctness/performance + profiling stack | Trusted Evaluator + Runner；CPU/NUMA/thread/context 更强约束 |
| 硬件知识 | RAG 注入平台文档/优化模式 | Phytium Hardware Knowledge，硬件 fact 与实验 Observation 分层 |
| 数据 | Shared Data Foundation，session/search tree persistence | Experiment/Measurement/Evidence Store，成功与失败全部保存 |
| 学习 | Skill distillation + agentic RL | 先 Experience A/B，后续 ranking/specialized model/RL |
| 部署 | Meta distributed infrastructure | 先单机/少量飞腾 Runner；RPC contract 可扩展到多机 |
| 工程裁决 | production validation pipeline | Formal Evaluator + independent revalidation + Human Approval |
| 差异化重点 | 大规模 heterogeneous AI kernel authoring | 飞腾 CPU 软件生态的 Time to Peak Performance |

结论：PhyOpt 可以借鉴 KernelEvolve 的系统范式，但不应照搬其规模和技术栈。最该复制的是“候选生成与真实评测解耦、将优化当搜索、数据长期积累”的思想；最不该复制的是在可信 CPU 实验基础尚未建立时就上大规模 tree search、复杂 RAG 或 RL。

## 32. 关键产品决策（已确定 / 待确定）

| 决策 | 状态 | 当前结论 |
| --- | --- | --- |
| Control Plane 与 Execution Plane 分离 | 已确定 | 是；Runner 在飞腾 ARM，Agent/DB/Orchestrator 在控制面。 |
| 正式通信模式 | 已确定（方向） | RPC Contract；V1 推荐 HTTP/JSON；SSH 为 bootstrap/maintenance。 |
| 首个真实 target | 已确定 | S5000C + SGEMV-N。 |
| 首个 Agent 模式 | 已确定 | 单 Agent、单 Candidate lineage，多轮迭代。 |
| V1 数据库 | 已确定 | 继续 SQLite。 |
| Formal Evaluator owner/具体部署 | 待确定 | 由具名性能/验证负责人拥有；Candidate 不可写。 |
| SGEMV Source Baseline | 待真机前确认 | 优先 pre-opt 可恢复版本，否则当前可验证版本。 |
| 正式 sampling/threshold/regression 数值 | 待校准 | 先做 S5000C A/A calibration 后冻结 policy。 |
| Human Approver | 待指定 | 必须是对 SGEMV 代码和性能交付负责的工程角色。 |

## 33. 不在当前版本实现的内容

大规模 multi-candidate tree search / MCTS / evolutionary search。

Knowledge Graph、通用 RAG 平台、自动技能沉淀。

Agentic RL、自训练 performance model、自动 model router。

GPU/NPU/任意 CPU Vendor。

复杂 Web/VS Code 工作台。

系统级/整机/OS 自动优化。

未经人工审核的自动生产 merge。

“任意 Git repo 一键优化”的产品承诺。

## 34. 未来演进：从实验系统到 Performance Intelligence

V1  Reliable Experiment + Agent-assisted Optimization

↓

V2  Candidate Set + Search + AutoTuner

↓

V3  Evidence → Experience + Retrieval + A/B Validation

↓

V4  Experience-guided Search + Model/Strategy Ranking

↓

V5  Cross-generation Phytium Performance Intelligence

↓

Continuous Performance Optimization

长期“自我增强”不能依赖 LLM 自动记住过去。真正的复利链路应是：Experiment → Raw Measurement → Validated Evidence → Scoped Experience → Retrieval/Ranking → Better Search → 新 Experiment。任何一步缺失，所谓“学习”都容易退化成不可审计的提示词堆叠。

## 35. 产品原则 / Invariants

Agent 不能作为 correctness 的最终裁判。

Agent 不能作为 performance 的最终裁判。

Candidate 与 Formal Evaluator 必须形成可信边界。

正式性能 claim 必须绑定真实 observed execution context。

优化成功必须有可追溯 Evidence；缺证据即不能成功。

Baseline 与 Candidate 必须在对称口径下比较。

失败实验也是产品数据，不能只保留 winner。

换 Model/Agent 不应要求重写实验系统。

新飞腾 CPU 不应要求重写 Task/Candidate/Experiment/Evidence 核心语义。

新软件领域不应把领域专用字段写入 Core。

单一 workload 的结果不能扩大为整个库/所有 CPU 的结论。

自动化程度提升不能取消 Human Approval 与责任归属。

产品演进顺序始终是：可信 → 自动化 → 智能化。

## 36. 术语表

| 术语 | 定义 |
| --- | --- |
| Control Plane | 用户交互、Agent、任务/候选/实验编排、数据和审批所在的控制侧。 |
| Execution Plane | 运行在飞腾目标机的真实执行侧。 |
| phyopt-runner | Execution Plane 的轻量确定性服务。 |
| Candidate | 一份被冻结、具有稳定 identity 的待验证代码状态。 |
| Experiment | 固定 Candidate/Baseline/Evaluator/Context 下的一次可追踪正式执行。 |
| Measurement | Evaluator 直接产生的原始观察。 |
| Evidence | 支持有限 claim 的已核验 Measurement + identity + context + result。 |
| Experience | 从多个 Evidence 归纳、带 scope/confidence/provenance 的可复用认识。 |
| Formal Evaluator | Candidate 无法影响、可版本化和审计的 correctness/benchmark/policy 信任域。 |
| Development Feedback | Agent 可使用的快速测试/benchmark/profile，不具有正式裁决力。 |
| Revalidation | 冻结 Candidate 后重新产生一套独立正式 Evidence。 |
| UNKNOWN | 系统无法确认远端是否执行/完成/终止，不能自动转成 success/fail。 |
| Time to Peak Performance | 从硬件进入软件使能到目标软件达到经验证成熟性能的时间。 |

## 37. 参考资料

[R1] Meta Engineering. “KernelEvolve: How Meta’s Ranking Engineer Agent Optimizes AI Infrastructure.” 2026-04-02. https://engineering.fb.com/2026/04/02/developer-tools/kernelevolve-how-metas-ranking-engineer-agent-optimizes-ai-infrastructure/

[R2] Gang Liao et al. “KernelEvolve: Scaling Agentic Kernel Coding for Heterogeneous AI Accelerators at Meta.” arXiv:2512.23236; ISCA 2026.

[R3] Meta Engineering. “Capacity Efficiency at Meta: How Unified AI Agents Optimize Performance at Hyperscale.” 2026-04-16. https://engineering.fb.com/2026/04/16/developer-tools/capacity-efficiency-at-meta-how-unified-ai-agents-optimize-performance-at-hyperscale/

[R4] PhyOpt internal baseline: CURRENT-STATE.md / CURRENT-STATE-VERIFICATION.md / VISION.md / GAP-ANALYSIS.md / PRODUCT-SPEC-MCP.md（本次讨论中形成）。

## 38. 最终结论

PhyOpt 的正确产品形态不是“在 ARM 上跑一个 Agent”，也不是“通过 SSH 远程执行几个 benchmark”。它是一套控制面与执行面分离、以真实硬件 Evidence 为裁判、以 Agent 为候选生成器、以 Experiment Data 为长期资产的自动性能工程系统。

对 Meta KernelEvolve 最值得学习的是系统方法：把优化视为搜索，把真实评测作为闭环，把历史优化转化为后续能力；但 PhyOpt 当前最重要的不是复制 Meta 的大规模 tree search，而是先把飞腾 CPU 上的可信 Experiment / Measurement / Evidence 基础打牢。做到这一点，后续 Candidate Search、Hardware Knowledge、Experience、模型排序甚至专用性能模型都可以自然叠加，而不用再推翻底座。

