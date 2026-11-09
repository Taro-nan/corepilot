# PhyOpt Vision

本文定义 PhyOpt 的长期产品方向，不描述当前版本已经具备的全部能力，也不构成技术架构、实施计划或交付承诺。文中的“当前事实”以 `docs/CURRENT-STATE.md` 和 `docs/CURRENT-STATE-VERIFICATION.md` 为准；“产品假设”需要后续实验验证；“长期愿景”用于约束持续演进的方向。

## 1. Why PhyOpt Exists

CPU 企业交付的不只是芯片，也包括让关键软件能够实际利用芯片能力的软件工程过程。每一代 CPU 的微架构、核心数量、缓存与内存系统、向量能力和并行特征都可能变化。新硬件出现后，编译器、基础库、运行时和上层性能敏感软件通常需要重新适配、测量和调优，硬件峰值能力不会自动转化为用户能够获得的性能。

这一过程面对组合爆炸：软件版本、workload、数据规模、数据分布、线程数、编译器与编译选项、CPU 代际、操作系统和依赖库共同决定结果。一个局部优化可能只对某个规模有效，也可能改善吞吐却引入数值错误、尾延迟或其他测例回退。能够同时理解硬件、算法、汇编、工具链和测量方法的性能专家稀缺，而高水平调优仍大量依赖人工提出假设、改代码、构建、上机、测量、排除噪声和继续迭代。

基础软件和性能软件的数量持续增长，芯片迭代也不会停止。单纯增加人工，难以让这种工作随芯片数量、软件范围和测试组合线性扩展。PhyOpt 存在的原因，是把专家主导但高度重复的性能实验过程沉淀为可信、可复用、可逐步自动化的工程系统，从而缩短新飞腾 CPU 从“硬件可用”到“关键软件性能成熟”的时间。

长期核心指标可以概括为 **Time to Peak Performance**：从新飞腾 CPU 进入软件使能与调优阶段，到目标软件在代表性 workload 上达到经验证、可复现、工程上可接受的成熟性能所需的时间。这里的 Peak 不是脱离约束的理论峰值，而是明确正确性、工作负载和执行环境下的成熟软件性能。

## 2. Core Problem

PhyOpt 真正要解决的是 **Hardware Capability → Software Performance** 之间的转化缺口。

这个缺口并不只来自“代码写得不够快”。它还来自性能问题发现晚、假设形成慢、实验成本高、环境不可比、候选不可追踪、正确性与性能证据不可信、失败经验丢失，以及同类工作在新 CPU、新版本或新软件中被反复从头开展。即使模型能够生成高质量代码，如果没有受控实验和真实硬件裁决，也不能证明它缩小了这个缺口。

因此，PhyOpt 的目标不是最大化模型生成代码的数量，而是提高单位工程时间内产生**可信有效改进**的概率，并降低达到目标性能所需的实验次数、机器时间和专家时间。最终价值由真实软件结果决定，而不是由 Agent 的自信程度决定。

## 3. Product Definition

PhyOpt 是一个**面向飞腾 CPU 的自主式与 Agent 辅助式性能工程系统**。它将可插拔的 Model / Coding Agent 与受控源码、候选实验、真实硬件执行、独立验证和经验积累结合起来，使性能工程从一次性的人工活动逐步转变为可追踪、可重复、可学习的长期过程。

Model / Agent 承担开放式分析与候选探索；PhyOpt Runtime 管理实验边界与工程闭环；真实飞腾硬件和可信 Evaluator 提供最终证据；人类工程师定义目标、处理工程取舍并决定是否接受结果。系统追求的不是无人监管地修改代码，而是在明确责任边界下提高性能工程的速度、覆盖范围和知识复用程度。

### PhyOpt Is Not

PhyOpt 不是：

- 通用 Coding Agent 或面向任意编程任务的代码助手；
- 通用 Agent Platform 或让用户自由拼装任意流程的 Workflow Builder；
- Chatbot；
- 只优化一个算法、一个 BLAS 函数或一个固定 benchmark 的专项工具；
- 对某个模型或模型供应商的 Wrapper；
- 只负责展示测量结果的 Benchmark GUI；
- 把文档检索包装成自动优化的 RAG 搜索系统。

## 4. Primary Users

第一阶段用户是承担飞腾软件性能责任的专业团队，而不是所有普通开发者，主要包括：

- CPU 厂商的基础软件工程师和芯片软件使能团队；
- Performance Engineer 与性能分析、优化团队；
- 数学库、压缩库、图像库、网络库等高性能基础库工程师；
- 负责关键软件在飞腾 CPU 上适配、回归和性能验收的工程团队。

这些用户能够定义正确的 workload、baseline、正确性标准和工程约束，也能判断一个局部 speedup 是否值得进入产品。PhyOpt 应减少他们在机械实验、环境整理和重复探索上的投入，而不是绕过其专业判断。面向更广泛开发者的易用性可以是后续结果，但不能以牺牲测量可信度为代价成为第一阶段目标。

## 5. Core Optimization Loop

PhyOpt 的核心产品闭环是：

```text
Problem Definition
→ Inspect
→ Profile / Analyze
→ Hypothesis
→ Candidate
→ Build
→ Correctness
→ Benchmark
→ Feedback
→ Iterate
→ Independent Revalidation
→ Evidence
→ Experience
```

Problem Definition 固定目标、workload、baseline、约束和停止条件；Inspect 与 Profile / Analyze 建立对源码和瓶颈的认识；Hypothesis 把观察转化为可证伪的优化判断；Candidate 是该判断的可执行实现。Build、Correctness 和 Benchmark 将候选置于客观约束下，失败或回退成为下一轮 Feedback；达到门槛后仍需 Independent Revalidation，避免偶然结果、环境污染或对 evaluator 的不当影响。最终只有与上下文绑定的 Evidence 才能进入 Experience。

它是闭环，而不是一次模型调用，因为性能优化本质上是连续的实验性搜索。模型第一次给出的方案通常只是候选；构建错误、正确性失败、性能回退和 profile 变化都会更新下一轮判断。PhyOpt 的产品价值在于稳定管理这条反馈链，使开放式智能能够在确定的工程规则中反复试验，而不是把一次回答误认为结论。

## 6. Responsibility Boundaries

| Role | Responsibility |
| --- | --- |
| Human | 定义优化对象、业务优先级、正确性口径、baseline、资源预算和接受标准；处理可维护性、风险、兼容性等工程取舍；审阅证据并决定最终交付。 |
| Model / Agent | 阅读代码与上下文，分析潜在瓶颈，提出可证伪假设，生成和修改候选实现，根据构建、测量和 profile 反馈继续探索。它可以解释结果，但不能认证结果。 |
| PhyOpt Runtime | 固定任务与执行上下文，管理源码、Candidate、实验、构建、正确性、benchmark、profiling、资源、真机执行、比较、复验、Evidence 及经验记录，保证流程按规则发生。 |
| Evaluator / Real Hardware | 在可信边界内执行正确性与性能测量，返回原始事实和判定依据。真实飞腾 CPU 是性能主张的最终运行环境，Evaluator 是候选不能自行替代的裁判。 |

Human 决定“优化什么”和“是否工程接受”；Agent 提出“可能怎样优化”；PhyOpt 控制“如何形成可信实验”；Evaluator 与真实硬件回答“它是否正确、是否真的更快”。任何一方都不能越过这一边界：尤其不能让候选的提出者同时成为候选的最终裁判。

## 7. Product Principles

1. **Evidence over model confidence**：模型语言上的确定性不构成证据。每个性能结论必须能够回到实验、测量和执行上下文，否则只能被视为待验证假设。
2. **Correctness before performance**：错误结果的加速没有产品价值。只有通过既定正确性标准的候选，才有资格进入正式性能比较；性能收益不能抵消正确性退化。
3. **Real hardware over theoretical claims**：静态分析、成本模型和模拟可以指导搜索，但飞腾 CPU 上的受控测量才决定真实收益。微架构、编译器和系统噪声使纸面推断不足以完成裁决。
4. **Reproducibility**：结论应能由另一名工程师在已记录条件下重现。不可重现的单次提升不能成为稳定产品资产，也不应直接交付。
5. **Deterministic workflow around nondeterministic intelligence**：模型可以非确定地探索，但任务定义、候选身份、测量规则、停止条件和证据处理必须确定。这样才能比较不同模型、不同轮次和不同时间的结果。
6. **Human review before delivery**：性能数据不能覆盖维护成本、兼容性和发布风险。进入基准分支或产品版本前，必须由有责任边界的人类工程师审阅和接受。
7. **Hardware-aware**：优化必须理解具体飞腾 CPU 的执行特征，不能把硬件仅当作一个远端地址。硬件知识应影响分析和实验解释，但不能替代测量。
8. **Model-agnostic**：模型是可替换的智能来源，不是产品核心身份。更换模型或 Agent 应改变探索能力和成本，而不应改变证据标准与核心工程闭环。
9. **Software-domain extensibility**：不同软件领域有不同正确性、workload 和性能语义。产品应允许逐域接入，而不是用一个 BLAS schema 假装覆盖所有软件。
10. **Experiment traceability**：每个结论都应追溯到问题、baseline、候选、执行环境和原始测量。缺少因果链的数据无法用于审计、比较或学习。
11. **Failed experiments are valuable data**：失败揭示了无效假设、适用边界和风险。如果只保留成功样本，后续 Agent 会重复昂贵尝试，并形成有偏经验。

## 8. Product Invariants

无论未来采用何种模型或技术架构，PhyOpt 都必须保持以下不变量：

1. Agent 不能作为 correctness 的最终裁判，也不能通过自述替代独立检查。
2. Agent 不能作为 performance 的最终裁判；性能主张必须来自真实目标硬件上的测量。
3. Candidate 与 Evaluator 必须形成可信边界，候选不能不受约束地改变裁判、测试口径或正式 benchmark。
4. 正式结论必须绑定明确的 execution context，包括硬件身份、软件与工具链、构建条件、workload、数据规模、线程与资源条件等关键因素。
5. 优化成功必须有可追溯 Evidence；没有证据、证据缺失或测量失败时，不得推导成功。
6. baseline 与 candidate 必须在可比较条件下接受同一口径的评估，不得通过选择性测例或不对称环境制造收益。
7. 失败、无提升、回退和无效测量都必须作为实验结果被区分和保存，不能只留下胜者。
8. 更换 Model / Agent 不应要求重写核心实验系统，也不能降低正确性和性能证据标准。
9. 接入新飞腾 CPU 不应要求重写整个核心系统；代际差异应成为明确的硬件上下文和知识，而不是散落的隐含假设。
10. 接入新软件领域不应把领域专有逻辑写入通用 Core；领域必须显式定义自身任务、正确性和性能语义。
11. 每个性能结论的适用范围必须与证据一致；单一 workload 的结果不能被扩大为对整个库或所有 CPU 的结论。
12. 进入正式交付前必须有人类审阅；自动化程度提高不能取消责任归属。
13. 产品优先级始终是 **可信 → 自动化 → 智能化**。不能用更高自主性换取更弱的证据或更模糊的边界。

## 9. Product Assets

PhyOpt 长期应积累的核心资产不是支持了多少模型、多少供应商或多少 UI 功能，而是能够提高后续性能工程质量和效率的事实基础：

- 飞腾硬件知识：代际特征、瓶颈模式、工具链行为和已验证的适用边界；
- 可靠的真实硬件实验能力：稳定执行、资源控制、测量校准和独立复验形成的信任；
- 标准化实验记录：问题、上下文、候选、原始测量、判定和结果之间的完整关联；
- 成功与失败的优化历史：什么在何种条件下有效、无效或产生回退；
- workload 与性能 Evidence：代表性负载、基线表现、波动和跨版本变化；
- Optimization Patterns：经过多个情境验证的优化模式及其前置条件和副作用；
- 历史 Candidate 数据：候选谱系、修改内容、构建有效性、正确性和性能结果；
- 最终可能形成的检索、候选排序和搜索策略。

这些资产具有复利潜力：更多高质量实验可以减少重复诊断，改进候选优先级，并帮助新 CPU 或新版本更快建立性能基线。但复利来自数据的真实性、上下文完整性和可比较性，而不是记录数量。没有执行身份和原始证据的数据堆积不会自然变成 Performance Intelligence。

## 10. Knowledge Flywheel

长期产品假设是：

```text
Experiment → Evidence → Experience → Retrieval
→ Better Candidate → Fewer Experiments
→ More Optimization Tasks → More Experience
```

该飞轮不是当前已经证明的能力。**Raw Experiment 不等于 Knowledge，Observation 不等于 Rule。** 一次优化成功只说明某个候选在某组已记录条件下有效；它可能依赖特定 CPU 代际、数据规模、编译器或源码结构。只有经过归因、重复验证、适用范围标注和跨任务检验后，观察才可能成为可复用经验。

“历史经验能够减少达到目标所需的实验数”本身也是需要验证的 Product Hypothesis。未来应通过受控 A/B experiment 比较有无经验检索或经验引导时的首个有效改进时间、实验数量、最终结果和成本，避免把相关性误认为提升。

失败实验必须保存，因为它们定义搜索空间的排除区域：某种转换为何构建失败、在哪些 case 上破坏正确性、在哪个 CPU 上回退、某条假设为何不成立。缺少失败数据会导致幸存者偏差，使系统反复尝试同一无效方向，也无法学习模式的边界。

## 11. Plug-in Philosophy

“可插拔”意味着 Hardware、Intelligence、Software / Optimization Target 可以在稳定产品边界内逐步接入，而不是承诺“任意 Git repository + 任意硬件 + 任意模型，点击一次即可得到最佳代码”。每类接入都必须满足自身的可验证前提。

- Hardware 接入需要能够明确描述目标飞腾 CPU、执行环境、资源约束和可信测量条件。
- Intelligence 接入需要能够在 PhyOpt 规定的工具、候选和证据边界内工作，且不能接管最终判定。
- Software / Optimization Target 接入需要明确优化任务、构建方式、正确性 oracle、代表性 workload、baseline 和性能接受语义。

可插拔的目标是隔离变化：新飞腾 CPU 应扩展硬件认知，新 Model / Coding Agent 应扩展探索能力，新基础软件领域应扩展领域定义；三者都不应迫使产品重新定义可信实验的核心原则。可接入不等于未经资格验证即可宣称支持。

## 12. Product Scope

### Current Focus

第一阶段聚焦：

- 飞腾 CPU 与 Linux 环境；
- C、C++ 和 Assembly；
- 性能敏感软件，优先基础库；
- 自动 build、自动 correctness、自动 benchmark；
- 真实飞腾硬件执行和基于证据的比较；
- 通过后等待人类审核与接受。

这里的“自动”表示流程可由系统重复执行，不表示无需领域定义、无需可信 evaluator 或无需人工承担最终交付责任。

### Near-term Expansion

在核心实验可信后，可以探索多种基础库接入、multi-candidate exploration、历史经验检索、autotuning、profiling-assisted optimization 和 library-level optimization。它们是否进入产品，应取决于能否在不削弱正确性、可复现性和责任边界的前提下带来可测量收益。

### Long-term Possibility

更长期可以研究 Compiler、Runtime、Database Kernel、Storage、Network、AI Inference、System Performance 和 Continuous Performance Optimization。这些方向代表潜在适用空间，不是当前产品能力，也不是已经承诺的范围；每个领域都需要独立证明其 evaluator、workload 和工程闭环成立。

## 13. Non-goals

当前明确不以以下事项为目标：

- 一开始支持任意 CPU、GPU 或 NPU；
- 成为通用 Coding Agent、通用 Agent Platform 或通用低代码 Workflow；
- 自动优化任意 Git repository；
- 自研 Foundation Model；
- 当前就建设 RL 平台或大型 Knowledge Graph；
- 当前就实现整个 OS 自动优化或整机自动调优；
- 用系统替代所有性能专家；
- 无人工审核地直接交付生产代码。

这些非目标用于约束投入，避免在真实硬件实验与可信 evaluator 尚未成熟时，用范围扩张掩盖核心问题。

## 14. Product Success Metrics

产品指标应衡量可信优化的效率和质量，而不是模型或供应商数量：

| Metric | Meaning |
| --- | --- |
| Time to first valid improvement | 从任务定义到第一个同时通过正确性与性能门槛的候选所需时间，反映早期搜索效率。 |
| Time to target performance | 从任务开始到达到工程目标并完成复验所需时间，直接对应 Time to Peak Performance。 |
| Experiments to target | 达到目标前实际完成的有效实验数量，衡量搜索和经验复用效率。 |
| Best verified speedup | 在指定 workload、baseline 和执行上下文中的最佳复验收益；必须同时报告适用范围和回退。 |
| Correctness pass rate | 候选通过可信正确性检查的比例，反映候选质量，但不能通过降低测试强度改善。 |
| Candidate build-valid rate | 候选能够成功构建的比例，反映 Agent 输出与源码上下文匹配程度。 |
| Human engineering hours saved | 相对于可比人工流程减少的专家投入，关注释放的真实工程时间。 |
| Regression rate | 被接受优化在其他受约束 workload、后续版本或复验中产生回退的比例。 |
| Reproducibility | 独立重复实验得到一致结论的程度，是可信度而非附加指标。 |
| Cost per accepted optimization | 每个最终接受优化消耗的模型、工程和基础设施成本。 |
| Machine time per accepted optimization | 每个接受结果消耗的目标机时间，约束无效暴力搜索。 |

这些指标需要按 CPU、软件领域和 workload 分层解释，并组合使用。单独追求 speedup、通过率或实验数量都可能产生错误激励；只有与正确性、复现性、成本和工程接受同时观察，才能反映产品价值。暂不为这些指标设定具体 KPI。

## 15. Product Evolution Hypothesis

以下是长期能力演进假设，不是当前 Roadmap，也不表示各阶段一定按顺序或必然实现：

1. **Stage 1 — Reliable Experiment System**：从分散人工命令转变为可重复、可追踪、由真实硬件裁决的实验过程，首先建立信任。
2. **Stage 2 — Agent-assisted Optimization**：Agent 能在受控闭环中提出候选并消费实验反馈，人的角色从执行每一步转向定义、监督和判断。
3. **Stage 3 — Multi-candidate Search**：从单一候选连续修改转变为多个独立方向的生成、比较与选择，搜索过程成为显式对象。
4. **Stage 4 — Experience Reuse**：历史实验能够按上下文被检索并辅助分析，减少明显重复的诊断和无效尝试。
5. **Stage 5 — Experience-guided Search**：经过验证的经验开始影响候选生成、排序和资源分配，并通过对照实验证明其确实减少时间或实验数。
6. **Stage 6 — Library-level Optimization**：优化对象从单函数扩展到函数族、调度、数据布局和库级回归，能够处理更广的相互作用与工程约束。
7. **Stage 7 — Platform Performance Intelligence**：在多个飞腾 CPU 代际和软件领域间形成可验证的性能认知，支持持续发现、迁移和管理系统性性能机会。

每个阶段的质变都必须由可测量能力和可信证据确认。若前一阶段的可靠性基础不足，增加搜索规模或智能程度只会更快地产生不可相信的结果。

## 16. Long-term Moat

PhyOpt 的长期竞争力可能来自真实飞腾硬件实验基础设施、飞腾 Hardware Knowledge、高质量且上下文完整的 Experiment Dataset、成功与失败经验、经过验证的 Optimization Patterns、候选 Search / Ranking 能力、跨 CPU 代际经验迁移，以及由这些要素长期形成的 Performance Intelligence。

壁垒不只是“有数据”，而是能够证明数据来自什么候选、在哪个环境执行、如何判定、能否复现，并知道结论的适用边界。跨代迁移也不能靠相似性叙述成立，必须通过新硬件实验验证。随着真实任务积累，这种可信事实链、专家语义和实验能力比单次生成质量更难复制。

API adapter、Prompt、UI，以及短期支持某个热门模型，本身都不是长期壁垒。它们可以改善体验或阶段性效率，但容易被替换。真正可持续的差异在于：能否更快提出高价值候选，并用更少成本在真实飞腾 CPU 上可靠证明或否定它。

## 17. Relationship to Current Implementation

根据 `docs/CURRENT-STATE.md`，当前实现已经存在部分基础骨架，包括 Model / Agent 调用、Git candidate worktree、Build、Validation、SSH transport、Revalidation 和 Approval。根据 `docs/CURRENT-STATE-VERIFICATION.md`，主项目能够 clean build，关键模块和 CLI 可加载，本地 ignored 测试能够通过；同时，真实模型、真实 SSH、真实飞腾硬件 correctness 与 benchmark 并未在该次验证中执行。

因此，当前实现可以作为继续验证产品方向的起点，但不能等同于本文 Vision。它在可信 evaluator、资源与测量控制、实验持久化、恢复、候选搜索、经验复用、跨领域接入和真实 ARM E2E 等方面仍与目标存在明显距离。本文不展开详细 Gap Analysis；下一阶段应单独以 **CURRENT STATE × VISION = GAP ANALYSIS** 的方式评估差距。
