# PhyOpt MCP First Target Decision Analysis

## 1. Purpose

本文只分析 `docs/PRODUCT-SPEC-MCP.md` 中 OD-01 至 OD-07，目标是把第一场真实 MCP 验收实验缩小到可由性能负责人确认的选项集合。本文不是架构设计、实现方案或已批准实验协议。

分析基线为：

- 仓库分支：`main`
- 仓库 commit：`09d4d9e7b2080b77037837145c9333e34f059f1a`
- 分析日期：2026-09-24
- 产品事实：`docs/CURRENT-STATE.md`、`docs/CURRENT-STATE-VERIFICATION.md`
- 产品目标：`docs/VISION.md`、`docs/PRODUCT-SPEC-MCP.md`
- 差距优先级：`docs/GAP-ANALYSIS.md`

本文使用以下状态：

- `PROPOSED`：基于当前资产和 MCP 阶段给出的推荐，尚未成为最终决定。
- `OPEN`：必须由用户、性能负责人或 Evaluator owner 确认，本文不代替其决定。
- `REQUIRES_CALIBRATION`：必须先在指定飞腾目标机上取得校准数据，才能确定数值。

本文对提出的产品要求统一标注：

- `MCP_REQUIRED`：没有该要求就不能形成首个可信结论。
- `MCP_OPTIONAL`：有价值，但不阻塞第一场 MCP 验收。
- `POST_MCP`：不应进入第一场 MCP 的范围。

首场实验的目标是证明“可信真机闭环成立”，不是证明 PhyOpt 已能自动解决任意算法，也不是追求最大 speedup。因此，已有资产只构成决策证据；历史脚本、历史 PASS、已有阈值和已有目录路径都不会自动升级为正式产品决定。

## 2. Current Assets

### 2.1 已有资产清单

| 资产 | 当前源码事实 | 对首个 MCP 的价值 | 当前可用性 |
| --- | --- | --- | --- |
| SGEMV-N 运行时 testpack | `testpacks/sgemv-n.yaml` 声明 `cblas_sgemv`、18 个 correctness case、18 个 performance point、1/8/16 线程、CPU `0-15`、NUMA 0、warmup 3、7 samples 和历史阈值 | 已把目标、workload、资源与门槛放在同一份描述中，可作为需求素材 | 不能直接作为 Formal Evaluator；命令参数、输出格式和 runtime 执行语义不一致 |
| SGEMV-N 版本化 correctness 资产 | `testpacks/sgemv-n/versions/1.0.1/` 有 manifest、29-case `cases.json`、oracle、C harness、脚本、guard 和 qualification report | 是仓库中最完整的 correctness 起点 | 需要重新接线、目标机资格确认和 tolerance 审批；29-case 描述未被旧脚本实际执行 |
| SGEMV-N benchmark asset | `benchmark-assets/sgemv-n/1.0.2/` 有带 digest 的 manifest、统一 C benchmark、parser、output schema、build scripts，以及 `dlsym`/`dladdr` 运行时库身份探针 | 是最接近 Formal Benchmark 的现有资产 | benchmark 核心可复用，但路径、构建与正式 runner 仍需受控；不能按当前 runtime YAML 原样执行 |
| SGEMV-N test plan | `testplans/sgemv-n/1.0.4/manifest.json` 定义 18 个点、median、7 samples、bootstrap、阈值、资源和 artifact identity | 提供了真实历史实验的可检查协议和 workload 候选集 | 其权重是 synthetic equal weight，candidate/baseline/path 绑定历史实验；阈值没有成为本 MCP 的已批准标准 |
| S5000C build input | `build-inputs/sgemv-s5000c/1.0.1/manifest.json` 记录 source commit `5e55d541...`、pre-opt baseline commit `23b977e6...`、构建命令、关键源码 hash 和 OpenBLAS baseline SHA | 使 S5000C 上重建候选、追踪源码和比较对象有现实基础 | manifest 可用；其中记录的 candidate artifact 当前 `found: false`，baseline 与 source 仍须重新核验 |
| SGEMV-N source archive | `source-archives/sgemv-n/5e55d5419/manifest.json` 记录 12,629 个文件、commit 和 archive SHA `3a688b...` | 能定义已优化源码版本的精确身份 | tarball 仅存在于本地 ignored 路径，当前 tracked checkout 不能单独恢复 archive；pre-opt commit 无对应 archive |
| 旧 benchmark/testplan 版本 | `benchmark-assets/sgemv-n/1.0.0/`、`1.0.1/` 和 `testplans/sgemv-n/1.0.1/`、`1.0.2/` 保留 invalidation/supersession 记录；另有历史命名目录 `benchmark-assets/sgemv-formal/` | 可说明失败原因和资产演进 | 只能作审计参考；不得回退为 Formal Evaluator |
| S2500 build input | `build-inputs/s2500/1.0.0/manifest.json` 有 topology、ISA audit 和拟定 binding | 为以后换飞腾 CPU 提供参考 | 明确记录 required artifacts missing、real correctness/performance not executed，不适合作为第一场实验的低风险目标 |
| 历史 S5000C evidence | 本地 ignored `evidence/d10-r1/report/report.json` 记录 252/252 valid samples、candidate/baseline SHA、18 点结果和拒绝原因 | 证明 SGEMV benchmark 在真实 S5000C 上可运行，并暴露总体提升掩盖关键点回退的风险 | 只用于选择目标和校准；未被 tracked commit 管理，不能作为本 MCP 的正式 Evidence |
| dot-product fixture | `fixtures/dot-product/` 有简单源码、Makefile、reference 和 8 个 correctness case | 适合本地开发反馈、工具链和隔离机制测试 | 没有正式性能 benchmark、真实基础库集成或飞腾专属性，不足以验收 MCP |
| public optimize / Candidate flow | `src/config/optimize-cli-input.ts` 要求 `--function`，`--file` 仅为可选入口；`src/workflow/public-agent-workflow.ts` 允许全仓调查并多轮 checkpoint；`src/workspace/candidate-workspace.ts` 建立 editing/validation worktree 和 Git/source identity | 已能围绕一个函数在真实仓库中形成单一 Candidate lineage | 当前 Workspace tools 只保护 `.git`、`.phyopt`、`node_modules`，普通 test/benchmark 文件仍可写；不能据此宣称 Evaluator 已隔离 |

### 2.2 必须先承认的资产不一致

1. `testpacks/sgemv-n.yaml` 的 correctness command 没有传参数，而 `run_sgemv_v1_correctness.sh` 要求 `CANDIDATE_EXE OUTPUT_FILE [CPU_LIST]`。旧脚本实际运行 10 个硬编码调用，不读取 YAML 的 18 个 case，也不读取冻结目录的 29 个 case。
2. 29-case `cases.json` 包括 zero dimension、strides、LDA、alpha/beta 与多组边界，但没有线程字段；旧 10-case 脚本另行包含 1/8/16 线程，以及 SGEMV-T、DGEMV-N 隔离检查。两者不是同一个已执行套件。
3. `oracle/oracle.json` 声明 `float64` accumulator、`atol=rtol=1e-4` 且 `provisional: true`；现有 C harness 使用 `long double` reference 和另一套随运算长度缩放的 tolerance。正式 reference 与 tolerance 尚未统一。
4. qualification report 状态为 `PROVISIONALLY_QUALIFIED`，并注明真实 ARM 执行仍待完成；它与版本目录中的冻结标记不能共同证明该套件已经具备正式资格。
5. YAML 的 performance command 同样不传参数；被引用的 three-way 脚本要求 5～6 个参数并输出 CSV，而 `parsePerformanceMeasurements()` 在 `src/workspace/validation-runner.ts` 中读取 JSON。
6. 当前通用 runner 只执行给定命令并依据退出码/解析结果判断。它不主动执行声明的 case matrix、warmup、samples、CPU/NUMA/thread policy 或 bootstrap；`runRevalidationCycle()` 也没有重新计算完整性能 acceptance。
7. test plan 1.0.4 的 18 点等权汇总是 synthetic score，边界点占三分之一；manifest 已明确它不能被解释为真实业务 workload 的整体收益。
8. 历史 report 中 weighted geomean 约为 `1.244`，但 `wide_1024x16384_t1` 的 speedup 约为 `0.889`，因此最终结论为 `REJECTED`。这说明 aggregate improvement 不能替代 key-workload regression gate。
9. benchmark asset 1.0.0 因 manifest 自引用/digest 问题被明确 invalidated，1.0.1 又有 `argc` off-by-one；test plan 1.0.1/1.0.2 也有对应 invalidation。1.0.2 benchmark 与 1.0.4 test plan 是当前最新起点，但“修复已知旧缺陷”仍不等于“已完成本 MCP 的正式资格确认”。

结论：仓库已有“首个领域实验包的原料”，尚不存在一个可以原样声明为 Trusted Evaluator 的完整包。

### 2.3 当前实际候选目标

| 候选 | Correctness / benchmark / baseline 成熟度 | 真机基础 | 对 MCP 的适配性 | 结论 |
| --- | --- | --- | --- | --- |
| FT-BLAS/OpenBLAS-derived SGEMV-N on S5000C | correctness、benchmark、test plan、build input、source identity 和历史结果均有基础；仍需统一和重新资格化 | 有真实 S5000C 历史运行与已用 SSH target | 能同时验证汇编 kernel、线程 driver、真实构建、正确性、性能、回退与 revalidation | 唯一成熟度明显较高的候选，`PROPOSED` |
| 同一 SGEMV-N on S2500 | 可继承部分软件资产，但 baseline/artifact 未确认 | 只有 profile/ISA audit；真实 correctness 和 performance 未执行 | 会把“首个可信闭环”和“新机器 onboarding”两个风险叠加 | 不推荐作为第一场；可作为后续 hardware portability 验证 |
| `fixtures/dot-product` | 8 个本地 correctness case，无正式 benchmark、artifact identity 或 library integration | 无真实飞腾证据 | 容易跑通，但只能证明开发工具链，不足以证明真实性能工程产品 | Development Feedback；不是 MCP acceptance target |
| source archive 中其他 BLAS 函数 | 源码存在 | 未发现对应 evaluator/testplan/baseline 资产 | 选择后需从头建立领域实验包，无法利用现有成熟度 | 当前不是现实首选；函数存在不等于目标已准备好 |

## 3. OD-01 First Target

### 3.1 选择标准

第一场 MCP 目标应满足：

- `[MCP_REQUIRED]` 是真实基础库中的明确函数或 Kernel，而非演示 fixture。
- `[MCP_REQUIRED]` 能在一台可控飞腾 CPU 上构建和运行。
- `[MCP_REQUIRED]` correctness、benchmark、baseline 和 claim scope 至少已有可审查起点。
- `[MCP_REQUIRED]` 优化空间足以产生可测差异，但实验成败不能主要取决于是否解决新的高难算法研究问题。
- `[MCP_REQUIRED]` 能把性能主张限制在明确 API、参数、workload、线程与硬件范围内。
- `[MCP_OPTIONAL]` 目标具有跨线程或汇编/调度边界，可额外检验 PhyOpt 对复杂优化的反馈能力。

### 3.2 推荐目标

**Recommended First MCP Target — `PROPOSED`**

> 在现有受控 S5000C / `TARGET=FT2000` 环境上，优化 FT-BLAS/OpenBLAS-derived 实现中的 single-precision、column-major、NoTrans `cblas_sgemv`（SGEMV-N）；核心调查入口为 `kernel/arm64/gemv_n.S`，并允许检查与该路径相关的 `driver/level2/gemv_thread.c` 和必要调用链。

推荐理由：

1. 它是当前唯一同时具备 source identity、build input、correctness 素材、正式 benchmark 素材、test plan 和真实飞腾历史测量的目标。
2. S5000C 路径已实际运行过；选择它能把第一场实验的主要未知量集中在 Trusted Evaluator 与 Evidence 闭环，而不是同时承担 S2500 artifact onboarding 风险。
3. `cblas_sgemv` 有明确 API 和输入语义，SGEMV-N 可把 claim 限定到具体 operation；不需要声称整个 BLAS 库被优化。
4. 历史数据既显示明显整体提升，也显示关键 workload 回退，适合验证“正确测量、识别回退、拒绝看似成功 Candidate”这一 MCP 核心能力。
5. 候选涉及 AArch64 汇编 kernel 和多线程 dispatcher，是真实性能工程目标；同时已有历史实现，避免把 MCP 验收完全变成开放式算法研究。

该推荐不是最终决定，也不表示 PhyOpt 的长期方向绑定 SGEMV 或 BLAS。它仅表示：以当前仓库事实衡量，SGEMV-N 能以最低额外 onboarding 成本验证 MCP。

### 3.3 推荐的 claim boundary

- `[MCP_REQUIRED]` 主张只覆盖经批准的 `cblas_sgemv`、column-major、NoTrans、float32 语义。
- `[MCP_REQUIRED]` 性能主张只覆盖冻结 workload matrix、指定线程数、指定 S5000C machine identity、指定 toolchain 和实际观测 execution context。
- `[MCP_REQUIRED]` 正确性应覆盖比性能 workload 更广的合法 SGEMV-N API 语义，因为性能矩阵不能代替 API correctness。
- `[MCP_REQUIRED]` 如果 Candidate 修改共享 dispatcher，必须验证被触及共享路径的最小隔离回归范围；不得把“SGEMV-N 更快”建立在邻接 API 被破坏的基础上。
- `[MCP_OPTIONAL]` 把 OpenBLAS/KML 作为外部性能参考。
- `[POST_MCP]` 声称整个 GEMV、整个 BLAS、所有尺寸、所有线程数或所有飞腾 CPU 均获得提升。

目标采用 SGEMV-N/S5000C 仍需 Human Confirmation；在确认之前状态保持 `PROPOSED`。

## 4. OD-02 Baseline

### 4.1 Source Baseline 与 Performance Baseline

两种 baseline 解决不同问题，不能合并成一个模糊字段：

- **Source Baseline**：Candidate lineage 从哪一个源码状态开始；它定义 Agent 实际改变了什么。
- **Performance Baseline**：正式性能 claim 与哪一个冻结 binary/artifact 比较；它定义“更快”的参照。

一个 source commit 不自动等于一个可用 performance artifact。即使二者来源相同，也必须分别核验 source identity、build context 与 binary identity。

### 4.2 Source Baseline 选项

| 选项 | 内容 | 优点 | 风险 / 缺口 | 评估 |
| --- | --- | --- | --- | --- |
| A | pre-optimization commit `23b977e646e8ad96bab94f5c7c02f7a6c247197e` | 最能证明 Agent 从未优化状态产生实际改进；预期优化空间更大；验收重点更接近闭环而非挤压已优化 kernel | 当前只有 build-input manifest 引用；没有 tracked source archive、已冻结 build artifact 或本次可构建证据；commit 可恢复性和 API/toolchain 兼容性未知 | 条件式首选，`PROPOSED`，恢复并资格确认前为 `OPEN` |
| B | 已优化 commit `5e55d54192e3f9b9c876f989b78a43e937ad670d` | manifest、关键源码 hash、构建输入和本地 source archive 均有基础；已有真实测量 | 已包含历史 SGEMV 优化，进一步获得被接受提升更难；容易把首场 MCP 变成高难算法研究；tracked checkout 不包含 tarball 本体 | Option A 不可恢复时的现实 fallback，`PROPOSED` |
| C | OpenBLAS release033 源码 | 有稳定外部实现概念，接口可比 | 当前没有其 tracked source package/commit；历史资产主要是 binary；把外部实现当 Candidate 源码起点会改变 FT-BLAS lineage 的问题定义 | 不推荐作为首场 Candidate Source Baseline |

**Source Baseline recommendation — `PROPOSED`：**先验证 Option A `23b977...` 是否可恢复、干净构建、通过正式 correctness 并支持同一 `cblas_sgemv` 接口；全部成立则采用 A。任一关键条件不成立，则明确记录原因并使用 Option B `5e55d...`，而不是静默切换。

### 4.3 Performance Baseline 选项

| 选项 | 内容 | 优点 | 风险 / 缺口 | 建议用途 |
| --- | --- | --- | --- | --- |
| A | 从最终选择的 Source Baseline 在冻结 toolchain/config 下重建的 binary | 最公平地回答“Agent 的 Candidate 是否优于出发点”；baseline/candidate 可使用同一构建与接口口径 | 当前 artifact 尚不存在，必须在优化前构建、核验并冻结；构建不确定性必须消除 | `[MCP_REQUIRED]` primary Product Acceptance baseline，`PROPOSED` |
| B | OpenBLAS 0.3.33 release033，历史 SHA `6c5246e4...` | 有现成 test plan 和真实历史比较；能给出外部实现参照 | artifact 不在 tracked repo；路径来自历史机器；来源、实际文件 SHA、动态加载、工具链和兼容语义必须重新核验 | `[MCP_OPTIONAL]` secondary reference baseline，`PROPOSED` |
| C | KML v2.0.0 | 可提供另一种外部性能参照 | 所有权、版本、许可、artifact identity 与可恢复性带来额外依赖；不是证明 Agent 相对 source baseline 有改进所必需 | `[POST_MCP]`，不进入首场 acceptance gate |

**Performance Baseline recommendation — `PROPOSED`：**采用 dual-baseline 解释，但只有 source-baseline rebuild 是首场产品验收的 primary baseline；OpenBLAS release033 只作为 secondary context。Candidate 不必击败 OpenBLAS 才能证明 MCP 闭环成立，也不能因为击败 OpenBLAS 就跳过相对 Source Baseline 的因果比较。

### 4.4 Baseline 成为正式对象前的条件

- `[MCP_REQUIRED]` Source Baseline commit/archive 可恢复，且身份在 Agent 开始修改前冻结。
- `[MCP_REQUIRED]` primary performance baseline 由已确认 Source Baseline 构建，记录实际 binary identity；不能只记录预期路径。
- `[MCP_REQUIRED]` baseline 和 Candidate 使用相同 API/语义、benchmark source、workload、资源口径与等价 build policy；不可比较不同输入或不同线程限制。
- `[MCP_REQUIRED]` 正式执行前确认实际加载的是指定 baseline/Candidate library；`benchmark-assets/sgemv-n/1.0.2` 的 `dlsym`/`dladdr` 探针可作为复用基础。
- `[MCP_REQUIRED]` baseline artifact 在一个 Task 内不得漂移；任何重建或替换都产生新 identity，并使既有比较不再自动适用。
- `[MCP_OPTIONAL]` 保留 OpenBLAS 外部对照以解释当前成熟度，但其结果不得与 primary baseline 混成一个未标识 speedup。

最终 Source Baseline 以及是否采用 OpenBLAS secondary baseline 均为 `OPEN`。

## 5. OD-03 Performance Acceptance

### 5.1 Product Acceptance 与 Optimization Ambition

**Product Acceptance** 回答：在冻结范围内，Candidate 是否正确、是否相对自己的 Source Baseline 产生可重复的正向性能变化、是否没有不可接受的关键回退，并能通过独立复验。它服务于 MCP 的可信闭环验证。

**Optimization Ambition** 回答：Candidate 是否达到或超过 OpenBLAS/KML、是否取得尽可能大 speedup、是否覆盖更多 workload。这些目标可以指导 Agent，但不应成为第一场 MCP 成立的必要条件。

- `[MCP_REQUIRED]` Product Acceptance 必须在优化开始前明确。
- `[MCP_OPTIONAL]` OpenBLAS 相对表现作为工程参考。
- `[POST_MCP]` “所有 workload 都达到行业最佳”或“最大化整体 speedup”作为 MCP 成功定义。

### 5.2 Primary metric

**推荐 — `PROPOSED`：**

- `[MCP_REQUIRED]` 每个 workload 的 primary observation 为 `cblas_sgemv` 平均每次调用的 elapsed time，使用统一 benchmark 产生。
- `[MCP_REQUIRED]` 每个 workload 的 primary comparison 为 `baseline median time / candidate median time`；大于 1 表示 Candidate 更快。
- `[MCP_REQUIRED]` 所有汇总都能回溯到 per-workload raw samples；weighted aggregate 不能替代单个 critical workload 检查。
- `[MCP_OPTIONAL]` GFLOPS 作为由相同 timing 推导的可读指标，不作为另一套独立裁决事实。

### 5.3 Workload 与 regression boundary

现有 test plan 1.0.4 包含：

- 4096×4096 square、1024×16384 wide、16384×1024 tall，各自 1/8/16 线程；
- 8192×8192@16 和 16384×16384@8 两个 large 点；
- 15/16/17 行边界和 2047/2048/2049 行边界；
- 512×512@1 的 small 点。

其中 17/18 被标记为 critical，全部等权；这是一组有价值的候选矩阵，但尚没有证据说明“几乎所有点都是 key workload”或“边界点占三分之一权重”符合产品使用分布。

**推荐 — `PROPOSED`：**

- `[MCP_REQUIRED]` 由性能负责人从 square/wide/tall、large、thread scaling 中指定少量真正决定接受与否的 critical workloads。
- `[MCP_REQUIRED]` 边界尺寸保留为性能诊断与回退检查，但是否进入 primary aggregate、如何加权保持 `OPEN`；极短耗时点必须先证明计时分辨率足够。
- `[MCP_REQUIRED]` 每个 critical workload 都有独立 regression gate；aggregate gain 不能抵消超出边界的关键回退。
- `[MCP_REQUIRED]` non-critical workload 的回退仍完整报告，但只有预先批准的规则决定其是否阻止 acceptance。
- `[MCP_OPTIONAL]` secondary OpenBLAS 比较使用同一已批准矩阵。

### 5.4 Proposed acceptance semantics

第一场 MCP 推荐采用以下思想，而不是先写一个缺少依据的百分比：

1. `[MCP_REQUIRED]` Formal Correctness 全部 required cases 通过。
2. `[MCP_REQUIRED]` Candidate 相对冻结 source-baseline binary，在预先批准的 primary metric/aggregate 上表现出超过测量不确定性的正向提升。
3. `[MCP_REQUIRED]` 所有 critical workloads 均未出现超过批准 regression boundary 的可重复回退。
4. `[MCP_REQUIRED]` 实验 context 有效，baseline/Candidate identity 一致，raw samples 完整。
5. `[MCP_REQUIRED]` Independent Revalidation 得到相同的定性结论：正确性仍通过、正向提升仍成立、无阻塞性关键回退。
6. `[MCP_REQUIRED]` Human Approver 接受该 Candidate、主张范围与已知限制。

具体 minimum improvement、critical regression allowance 和 stability/uncertainty boundary 均为 `OPEN / REQUIRES_CALIBRATION`。历史的 `weighted_geomean_min=1.03`、`overall_ci_lower_min=1.0`、`key_case_ci_lower_min=0.98` 只能作为校准输入，不能直接沿用为本 MCP 决策。

确定数值至少需要：在最终目标机、最终 CPU/NUMA/thread policy、最终 benchmark loops 下执行多轮 baseline-vs-same-baseline（A/A）与跨时段重复测量，获得 per-workload 噪声、漂移和耗时分辨率；随后由性能负责人确定“可区分于噪声的最小提升”和“可接受回退”。

## 6. OD-04 Evaluator Ownership

### 6.1 所有权选项

| 选项 | 信任边界 | 优点 | 问题 | 结论 |
| --- | --- | --- | --- | --- |
| Candidate repository 内 | Agent 与 Candidate 可写 | 使用方便，项目测试贴近源码 | Candidate 可以修改裁判、case、benchmark 或 policy；不能产生正式 Evidence | 只允许 Development Feedback；不能拥有 Formal Evaluator |
| PhyOpt repository 管理 | 与被优化仓库可分离，由 PhyOpt 团队版本化 | 利用现有 testpacks/benchmark-assets/testplans，首场成本最低 | “在 PhyOpt repo 中”本身不保证运行时不可写；仍需明确 owner、冻结 identity 和 Candidate 无法影响的执行域 | 首场可行载体，需建立受控信任域 |
| 独立 evaluator package | 与 Candidate、Agent runtime 分别版本化和发布 | 所有权与版本边界最清晰 | 第一场就建设完整独立产品包可能过重 | 长期方向有价值；不是 MCP 必需的包装形态 |
| 外部受控目录 | 由性能验证团队部署，Candidate 无写权限 | 可快速形成物理信任边界，适合单机首场实验 | 如果缺少版本/digest/owner，目录本身仍不可信；人工维护风险较高 | 首场可接受的 staging 方式之一 |

### 6.2 推荐责任边界

**Formal Evaluator ownership — `PROPOSED`：**由具名的 PhyOpt/性能验证负责人拥有、审核和批准；Evaluator 独立于 Candidate 版本化，并从 Candidate 无法修改的受控位置进入正式实验。第一场可以使用 PhyOpt 管理的版本化资产加受控 staging，不要求先建设完整独立 package 产品。

- `[MCP_REQUIRED]` owner 必须是人或明确团队，而不是 Agent；其负责 case/workload、reference、阈值、版本变更与资格确认。
- `[MCP_REQUIRED]` Candidate 和 Agent 不能修改正式 correctness harness/oracle/cases/inputs、benchmark/workload、baseline artifacts、measurement/acceptance policy。
- `[MCP_REQUIRED]` Evaluator 内容与 policy 在 Task 开始前有固定 identity；运行时读取的实际内容必须与该 identity 一致。
- `[MCP_REQUIRED]` Agent 可以看见足够规则与失败反馈来改进 Candidate，但“可读”不等于“可写”或“可选择性跳过”。
- `[MCP_OPTIONAL]` 将相同 evaluator 发布成独立安装包。
- `[POST_MCP]` 建设通用 evaluator marketplace 或跨领域 package registry。

### 6.3 现有资产的复用等级

| 资产 | 复用判断 | 原因 |
| --- | --- | --- |
| `benchmark-assets/sgemv-n/1.0.2/sgemv_bench_formal.c`、parser、schema、manifest | **经过修改/集成并重新资格化后复用** | 已有统一 source、`CLOCK_MONOTONIC_RAW`、warmup/loops、structured output 和运行时库探针；仍需去除历史路径假设并纳入正式受控执行 |
| `testplans/sgemv-n/1.0.4/manifest.json` 的 18-point matrix | **经过人工审查与校准后复用** | workload 有真实运行基础，但关键点、权重、样本和阈值未被本 MCP owner 批准 |
| `testpacks/.../1.0.1/cases/cases.json` 与 guard 思路 | **经过 runner 接线、ARM 资格化后复用** | case 覆盖基础较好，但实际旧脚本不执行该集合，线程/隔离仍需补齐 |
| `oracle/oracle.json` | **只能作为候选配置参考** | tolerance 仍 provisional，且与 C harness 的 reference/tolerance 表达不一致 |
| 旧 10-case correctness script/C harness | **Development Feedback；或修改后作为 Formal Correctness 的组成部分** | 有大尺寸、多线程和邻接 API 隔离价值，但硬编码且不对应 29-case manifest |
| `testpacks/sgemv-n.yaml` | **需求参考，不能作为 Formal Evaluator** | 命令参数缺失，case 数与脚本不一致，资源/sampling 字段未由 runner 强制 |
| build/source manifests | **可直接复用为 provenance 输入，但不能单独充当 Evidence** | digest 和 commit 有价值；artifact 仍须实际恢复、构建和核验 |
| 历史 CSV/log/report | **Reference Only** | 可用于识别 workload、回退和校准范围；不是本 Task 的受控正式实验 |
| 已标记 invalid/superseded 的旧 benchmark/testplan 版本 | **不能用于 Formal Evaluator** | 仓库已有 invalidation/supersession 事实；使用会恢复已知缺陷 |

当前不存在“无需任何重新资格确认即可直接执行”的完整 Formal Evaluator。

## 7. OD-05 Development vs Formal Evaluation

### 7.1 资产分类

| 资产或检查 | 分类 | Agent 权限 | 能否形成正式 Evidence |
| --- | --- | --- | --- |
| Candidate 仓库自己的 unit/integration tests、Makefile test | Development Feedback | 可运行、可读取；如果在 Candidate worktree 内，可能被 Candidate 影响 | 否 |
| Agent 临时 microbenchmark、profiling 脚本、快速 case | Development Feedback | 可创建、修改和运行 | 否 |
| `fixtures/dot-product` 8-case test | Development Feedback / runtime 自测 | 可运行 | 否，与 SGEMV MCP 目标无关 |
| 当前 `testpacks/sgemv-n.yaml` 经 public workflow 调用的 correctness/performance 命令 | Development Feedback | 当前调用链可触发，且相关普通 worktree 资产未形成可信隔离 | 否 |
| 旧 `run_sgemv_v1_correctness.sh` 的 10 个硬编码 case | Development Feedback；Formal Correctness Candidate 的素材 | Agent 可看到；正式版本必须移出 Candidate 写域 | 现状不能；重新定义并冻结后部分可用 |
| 版本化 29-case suite + independent reference + guards | Formal Correctness Candidate | Agent可读规则；正式副本不可写、不可替换 | 只有通过一致性修复、目标机 qualification 和 owner 审批后才能 |
| 多线程与 SGEMV-T/DGEMV-N isolation checks | Formal Correctness Candidate | 正式副本不可写 | 若 Candidate 修改共享 dispatcher，则应进入正式 gate |
| benchmark asset 1.0.2 + 经批准 test plan | Formal Performance Candidate | Agent 可用开发副本快速反馈；正式副本不可写 | 经 identity、context、sampling 和 owner 资格确认后可以 |
| 历史 PASS log、correctness record、performance report | Historical Reference | 可读 | 否；只能证明历史对象在历史 context 中的结果 |

### 7.2 推荐边界

- `[MCP_REQUIRED]` Development Feedback 和 Formal Evaluation 使用不同信任语义，即使命令或 case 内容有重叠，也必须在结果中明确标识。
- `[MCP_REQUIRED]` Agent 自测失败可直接用于下一轮修改；Agent 自测成功只能表示“值得提交 formal experiment”，不能产生 acceptance。
- `[MCP_REQUIRED]` Formal Evaluation 只能使用冻结 evaluator identity，并核验实际 Candidate binary、baseline binary 和执行 context。
- `[MCP_REQUIRED]` formal case 不必对 Agent 保密；防篡改与完整执行才是信任来源。
- `[MCP_OPTIONAL]` 为提高反馈速度，提供与 Formal Evaluator 语义相近但不具裁决权的开发副本或缩小 case 子集。
- `[POST_MCP]` 通过隐藏测试、对抗式 case 生成或自动 fuzzing 建立第一场 MCP 的主要信任。

## 8. OD-06 Correctness Policy

### 8.1 Current Correctness Coverage

当前不是一个统一的 correctness suite，而是三份相互不等价的描述：

1. `testpacks/sgemv-n.yaml`：18 个声明 case，包括 zero dimension、small/odd、padded LDA、positive/negative stride、alpha/beta、16-row/32-row 边界和 1/8/16 线程；但命令不会逐项消费这些参数。
2. version 1.0.1 `cases.json`：29 个参数化 case，覆盖 2 个 zero dimension、small/odd、padded LDA、stride、alpha/beta、16/32 row boundary neighborhoods 和 N-block 3/4/5；没有线程字段，且没有被旧脚本执行。
3. `run_sgemv_v1_correctness.sh`：实际运行 10 个硬编码 case，包含 kernel/tail、negative stride、1/8/16 线程、大尺寸，以及 SGEMV-T、DGEMV-N isolation；C harness 固定使用 `alpha=0.7`、`beta=-0.3`，不等价于前两份参数集。

| 覆盖类别 | 当前基础 | 主要缺口 |
| --- | --- | --- |
| fast return / zero dimension | 29-case 和 YAML 有 M=0/N=0 | 必须确认 reference、输出未修改语义和真实 runner 执行 |
| small、odd、normal shape | 多个小尺寸、127×129 和大尺寸脚本 | 三份 case 集不一致；缺少唯一 formal inventory |
| padded LDA | 有 `lda_padded` 及部分硬编码 padded LDA | 需逐 case 记录 actual parameters/result |
| non-unit / negative stride | 有 inc=2、inc=-1；旧脚本有 -1 | 需确认正负起始地址语义和 guard 覆盖 |
| alpha / beta | cases.json 有 alpha=0/negative、beta nonzero | 旧 C harness 不消费 case 中 alpha/beta，当前声明未被实际证明 |
| kernel/tail boundaries | 有 15/16/17、31/32/33、63/64/65、N=3/4/5 | 需确认这些边界与最终 baseline/Candidate 调度逻辑仍相关 |
| multithread | 旧脚本有 8/16，YAML 声明线程 | 29-case formal candidate 没有 thread dimension；缺少按 case 的并行执行事实 |
| 邻接路径 isolation | 旧脚本有 SGEMV-T、DGEMV-N | 尚未形成与 Candidate 修改范围绑定的正式回归策略 |
| memory safety guard | qualification report 记录 underrun/overrun fault detection | 真实 ARM/Candidate 执行与每个 required case 的 guard 结果未形成正式记录 |
| special IEEE values | 未发现 NaN/Inf/subnormal/signed-zero 的明确 suite | 是否属于首个 claim scope 未决定 |
| invalid API inputs | 未发现明确 suite | BLAS 对非法参数的契约与 MCP 必要性未决定 |

qualification report 只证明本地故障注入基础，并明确注明 target ARM pending；不能把它解释为真实 FT-BLAS Candidate 已通过 29 个 case。

### 8.2 Required MCP Correctness Coverage

**Proposed Correctness Policy — `PROPOSED`：**

- `[MCP_REQUIRED]` 建立一份唯一、冻结、可枚举的 formal case inventory；29-case 集合作为起点，不能与 YAML 的 18-case 或旧脚本的 10-case 静默混用。
- `[MCP_REQUIRED]` case categories 至少包括：fast-return/zero dimension、small/odd/representative shapes、padded LDA、positive/non-unit/negative increments、alpha/beta variants、kernel/tail/dispatcher boundaries、1/8/16-thread execution和适当 large cases。
- `[MCP_REQUIRED]` 如果允许 Candidate 修改 `gemv_thread.c` 等共享代码，至少保留现有 SGEMV-T 与 DGEMV-N isolation checks，或由 owner 明确批准等价的邻接回归范围。
- `[MCP_REQUIRED]` 每个 case 有稳定 identity，并记录实际执行参数、reference identity、Candidate binary identity、thread/resource context、actual result、error、guard 和 pass/fail reason。
- `[MCP_REQUIRED]` reference 使用 Candidate-independent 的高精度标量实现；不能只用 OpenBLAS 或 Agent 生成结果作为真值。现有 long-double reference 可作为评审起点，但最终 accumulator/reference policy 为 `OPEN`。
- `[MCP_REQUIRED]` tolerance 采用与数据类型、运算长度和结果尺度一致的数值误差原则；不得同时保留互相冲突的固定 `1e-4` 与另一套隐含公式。具体公式和常量为 `OPEN`，由数值/BLAS owner 批准。
- `[MCP_REQUIRED]` memory guards 在被测输入/输出周围保持完整；任何 corruption 直接使 case fail，而不是只比较数值输出。
- `[MCP_REQUIRED]` pass semantics 为“所有 required cases 实际执行且全部通过”；缺失、跳过、解析失败、binary identity 不匹配或 context 无法确认均不得记为 PASS。
- `[MCP_REQUIRED]` Formal Correctness 在 Candidate checkpoint 后执行，并在 Independent Revalidation 对冻结 Candidate 重新完整执行。
- `[MCP_OPTIONAL]` 在 MCP 中加入 NaN、Inf、subnormal、signed zero，前提是 BLAS owner 确认这些语义属于首个正式 claim；未确认时不隐式承诺。
- `[POST_MCP]` 对所有非法 CBLAS 参数、所有 GEMV datatype/transpose/layout 组合做穷举资格化；首场只做被修改共享路径所需的最小隔离回归。

### 8.3 尚需批准的 correctness 决策

以下内容仍为 `OPEN`：

- 29-case 集合中哪些全部保留、哪些需要补充 thread dimension；
- SGEMV-T、DGEMV-N isolation 是否足以覆盖共享 dispatcher 风险；
- reference 使用 float64 还是 long double accumulation，以及 reference 自身如何 qualification；
- tolerance 公式与常量；
- special IEEE values 是否进入 MCP required scope。

## 9. OD-07 Performance Measurement Policy

### 9.1 当前 benchmark 能做什么

`benchmark-assets/sgemv-n/1.0.2/sgemv_bench_formal.c` 当前具备：

- 同一份 benchmark source 分别链接 baseline/Candidate；
- deterministic input；
- 参数化 M/N/threads/alpha/beta/inc/LDA/warmup/loops/role；
- `CLOCK_MONOTONIC_RAW` timing；
- timing 前通过 `dlsym` + `dladdr` 输出实际 `cblas_sgemv` 加载身份；
- 输出 `PHYOPT_DLADDR` 与 `PHYOPT_RESULT`，包括 role、shape、threads、loops、seconds、GFLOPS；
- manifest、source digest、output schema 和 parser。

旧 three-way 脚本还实现了 release033/KML/Candidate 六种循环顺序，在 11 个 shape/thread 点上减少固定顺序偏差。test plan 1.0.4 则扩展为 18 个点，声明 warmup 3、每点 7 samples、median、95% percentile bootstrap 和 10,000 次重采样。

### 9.2 当前明显问题

1. 运行时 YAML 没有传脚本所需 executable/output/repetition 参数，当前链路不能按声明直接工作。
2. 旧脚本输出 CSV，通用 runtime 读取 JSON；runner 不负责将声明的 18 点和 7 samples 实际调度出来。
3. build scripts/test plan 含历史 `/tmp` 路径、library name、Candidate SHA 和 machine-specific 记录，需要针对新 Task 重新绑定，不能原样认作当前身份。
4. 历史比较没有 pre-opt FT-BLAS binary（`baseline_pre_opt_ft: null`），因此不能回答 Candidate 相对 Source Baseline 的增量。
5. 现有 7 samples、warmup 3、loops 60、bootstrap 10,000 和 3%/2% 门槛有历史依据，但没有当前目标机 A/A calibration 证明其足够或必要。
6. 边界点单次结果处于亚微秒量级；loops 是否足以避开 timer resolution、启动与调度噪声需要校准。
7. 等权 geomean 是 synthetic summary；它不能代表业务 workload 分布，且历史结果已经证明总体提升会掩盖关键回退。
8. 当前 runner 没有强制 CPU affinity、NUMA、threads 或资源独占，也没有验证声明 context 与实际 context 一致。

### 9.3 Proposed MCP Measurement Policy

以下是产品级最小方案，不规定实现机制：

| 项目 | Proposed policy | 范围 |
| --- | --- | --- |
| Benchmark identity | baseline 和 Candidate 使用相同、冻结的 benchmark source/policy；执行前核验 benchmark binary 与实际加载 library identity | `MCP_REQUIRED` |
| Workload | 使用 owner 批准的 SGEMV-N shape × threads matrix；输入、alpha/beta/inc/LDA 对 baseline/Candidate 完全相同 | `MCP_REQUIRED` |
| Warmup | 每个被测 binary/workload 在计时前完成预声明 warmup；具体次数由目标机 calibration 决定 | `MCP_REQUIRED / REQUIRES_CALIBRATION` |
| Timed loops | 每个 raw sample 的 timed region 足够长，避免 timer resolution 和固定开销主导；不同 workload 的 loops 可不同，但必须预声明且双方相同 | `MCP_REQUIRED / REQUIRES_CALIBRATION` |
| Repeated samples | 每个 workload 对 baseline 和 Candidate 均取得多个独立 raw samples；现有 7 可作 calibration 起点，不直接成为最终数值 | `MCP_REQUIRED / REQUIRES_CALIBRATION` |
| Execution order | baseline/Candidate 采用成对、平衡的交错顺序，并固定/记录 order seed；避免始终先跑某一方。OpenBLAS secondary comparison 可另行运行，不增加 primary gate 的复杂度 | `MCP_REQUIRED` |
| Raw retention | 保留每个 sample 的顺序、role、seconds、derived GFLOPS、workload、binary identity、context、stdout/stderr；被排除样本也保留 | `MCP_REQUIRED` |
| Aggregation | 每个 workload 使用 median；整体只使用经批准权重的 summary，并同时展示全部 per-workload 结果 | `MCP_REQUIRED` |
| Uncertainty | 预先规定一种容易解释的不确定性/稳定性表达，并用 A/A calibration 决定接受边界；无法区分于噪声时不得声称提升 | `MCP_REQUIRED / REQUIRES_CALIBRATION` |
| Bootstrap | 可复用现有 percentile-bootstrap 作为不确定性工具，但 10,000 iterations 不是 MCP 成立的必要产品要求 | `MCP_OPTIONAL` |
| Outliers | 不做事后自动删点。只有预声明的无效原因（identity/context 不符、资源冲突、进程/机器异常、解析错误等）可将 sample 标为 invalid；原值与原因必须保留 | `MCP_REQUIRED` |
| Regression | 对每个 critical workload 单独应用批准边界；aggregate improvement 不能抵消阻塞性回退 | `MCP_REQUIRED / REQUIRES_CALIBRATION` |
| Revalidation | 在冻结 Candidate 上重新完成 correctness 和完整 primary baseline/Candidate measurement，产生独立 raw samples 与 Evidence | `MCP_REQUIRED` |
| Profiling counters | perf counters、cache/bandwidth/energy 等仅帮助解释结果，不作为首场正式 speedup 的必要条件 | `MCP_OPTIONAL` |
| 多机统计 | 跨多台机器、跨 CPU 代际建立 population-level 结论 | `POST_MCP` |

### 9.4 最小校准要求

在确定具体参数前，至少需要在最终 S5000C 和最终资源 policy 上完成：

1. `[MCP_REQUIRED]` baseline A/A 交错测量，确认同一 binary 在相同 workload 下的短期噪声。
2. `[MCP_REQUIRED]` 不同时间段重复 A/A，识别 warmup、频率/负载变化和 session drift。
3. `[MCP_REQUIRED]` 针对每个 workload 调整 timed loops，使 raw sample duration 可稳定测量，尤其是 boundary points。
4. `[MCP_REQUIRED]` 根据数据选择 sample count、uncertainty rule、minimum positive improvement 和 regression boundary；决策由性能负责人记录。
5. `[MCP_OPTIONAL]` 比较 median + 简单 dispersion 与现有 bootstrap 结果；只有前者不能支持稳定裁决时，才把 bootstrap 升为 MCP required。

该方案刻意不要求“完美统计”：它要求预声明、对称、重复、保留原始数据、识别噪声和独立复验；不要求第一版成为通用 HPC 实验平台。

## 10. MCP Required vs Optional

### 10.1 MCP_REQUIRED

| Requirement | 为什么是首场实验的必要条件 |
| --- | --- |
| 确认一个真实 SGEMV-N/S5000C target 和有限 claim scope | 没有明确对象就无法判断 Evidence 支持什么结论 |
| 冻结且可恢复的 Source Baseline | 定义 Candidate lineage 和 Agent 的实际改动 |
| source-baseline rebuild 作为 primary performance baseline | 形成公平、可解释的增量比较 |
| Candidate 无法修改的 Formal Evaluator 与具名 owner | 防止提出答案的一方改变裁判规则 |
| 唯一 formal correctness inventory、independent reference、approved tolerance、guards | 正确性不能由退出码或历史 PASS 代替 |
| 经审查的 workload/key-workload matrix | 性能结论和 regression 必须有边界 |
| 实际 baseline/Candidate/benchmark identity 核验 | 防止测到错误 library 或漂移 artifact |
| warmup、重复样本、平衡交错、median、预声明 uncertainty 与 regression policy | 单次 timing 不能形成正式性能结论 |
| 所有 raw/invalid samples、stdout/stderr 和 context 留存 | 结论必须可审计，失败数据不能消失 |
| 独立 Revalidation 和 Human Approval | 首次通过不能自动交付 |

### 10.2 MCP_OPTIONAL

| Requirement | 边界 |
| --- | --- |
| OpenBLAS release033 secondary comparison | 帮助解释工程成熟度，但不决定 MCP 是否成立 |
| percentile bootstrap 及现有 10,000 iterations | 可用于 uncertainty；具体统计方法不是产品本身 |
| KML 对比 | 若 artifact/许可/owner 均已就绪可作为额外 context，否则不引入 |
| profiling/hardware counters | 帮助 Agent 解释瓶颈，不替代 elapsed-time Evidence |
| special IEEE-value cases | 由 BLAS owner 决定是否属于首个 claim |
| Formal suite 的快速开发副本 | 加速反馈，但没有裁决权 |

### 10.3 POST_MCP

| Requirement | 推迟原因 |
| --- | --- |
| 穷举全部 CBLAS/GEMV 类型、布局、转置和非法输入 | 超出单一 SGEMV-N claim，显著扩大 evaluator 范围 |
| 多台机器、跨 CPU 代际统计结论 | 第一场只需证明一个受控飞腾目标上的可信闭环 |
| 自动 workload 权重学习、业务分布推断 | 当前没有高质量 Experiment dataset 支撑 |
| multi-candidate search、Knowledge/RL、自动模型路由 | 不解决 OD-01～OD-07，且依赖可靠实验记录 |
| 建设通用独立 evaluator registry/marketplace | 首场可由受控资产完成信任边界，无需先做平台化包装 |

## 11. First MCP Experiment Definition

> 本节是简洁的实验草案，不是已批准 protocol。

| Field | Definition |
| --- | --- |
| Target | FT-BLAS/OpenBLAS-derived SGEMV-N on a controlled Phytium S5000C / `TARGET=FT2000` environment — `PROPOSED` |
| Function / Kernel | `cblas_sgemv`, column-major, NoTrans, float32；主要入口 `kernel/arm64/gemv_n.S`，包含必要的 `driver/level2/gemv_thread.c` 调用路径 — `PROPOSED` |
| Source Baseline | 首选 pre-opt commit `23b977e646e8ad96bab94f5c7c02f7a6c247197e`，前提是可恢复、可构建并通过资格检查；否则使用 `5e55d54192e3f9b9c876f989b78a43e937ad670d` — `OPEN` |
| Performance Baseline | Primary：chosen Source Baseline 的冻结 rebuild；Secondary：OpenBLAS release033 binary SHA `6c5246e4...`，需重新核验 — `PROPOSED`，最终采用情况 `OPEN` |
| Target Machine | 已用于历史实验的受控 S5000C — `PROPOSED`；精确 machine identity、可用资源和有效状态标准 `OPEN` |
| Formal Correctness | 以受保护的 29-case suite 为起点，补齐/统一 multithread、shared-path isolation、guards、reference 与 tolerance 后重新在目标机 qualification — `PROPOSED` |
| Formal Benchmark | benchmark asset 1.0.2 + 经 owner 审查、重新绑定并校准的 test plan 1.0.4 — `PROPOSED` |
| Primary Metric | per-workload median elapsed time 与 source-baseline speedup；GFLOPS 为派生展示 — `PROPOSED` |
| Workload Scope | 从现有 18-point SGEMV-N matrix 选定的 shape × 1/8/16-thread 范围；critical list 与权重 `OPEN` |
| Resource Scope | 一组冻结且实际核验的 CPU/NUMA/thread 资源；历史 `CPU 0-15 / NUMA 0` 仅为输入，不自动沿用 — `OPEN` |
| Performance Acceptance | correctness 全过；相对 source baseline 有超过噪声的可重复正向提升；无超界 critical regression；revalidation 结论一致 — `PROPOSED`；具体阈值 `OPEN / REQUIRES_CALIBRATION` |
| Regression Policy | per-critical-workload 独立 gate，边界由 A/A calibration 与性能负责人批准 — `PROPOSED`；数值 `OPEN` |
| Revalidation | 冻结 Candidate 后，以 Formal Evaluator 完整重跑 correctness 和 primary baseline/Candidate measurement，产生新 Evidence — `PROPOSED` |
| Human Approver | `OPEN` |
| Claim Scope | 只限指定 Candidate、baseline、Evaluator、S5000C machine、execution context、workload 和线程范围；不推广到整个 BLAS 或其他飞腾 CPU — `PROPOSED` |

## 12. Decisions Requiring Human Confirmation

| # | 需要确认的问题 | 推荐选项 | 为什么必须确认 | 不确认会阻塞什么 |
| --- | --- | --- | --- | --- |
| HC-01 | 是否确认 SGEMV-N + 现有 S5000C 为第一场 MCP 目标？ | 确认本文 `PROPOSED` 目标 | 目标代表性、机器可用性和产品验收责任不能由仓库资产自动决定 | OD-01、Task scope、后续全部 evaluator 决策 |
| HC-02 | Source Baseline 选择 `23b977...` 还是 `5e55d...`？ | 先验证并优先采用 pre-opt `23b977...`；不可恢复才回退 `5e55d...` | 两者决定 Agent 优化起点、可用 headroom 和实验难度 | OD-02、Candidate lineage、primary baseline build |
| HC-03 | 是否批准 dual-baseline：source-baseline rebuild 为 primary，OpenBLAS release033 为 secondary？ | 批准；不把 KML 放入 MCP acceptance | primary 回答 Agent 增量，secondary 提供外部语境；二者用途需避免混淆 | OD-02、performance claim 与报告解释 |
| HC-04 | 谁是 Formal Evaluator owner，谁有权批准版本和 policy？ | 指定一名性能验证负责人及其团队；资产由其控制并置于 Candidate 不可写域 | 没有具名 owner 就无法处理 tolerance、case、threshold 和版本变更 | OD-04、Evaluator identity、正式实验授权 |
| HC-05 | 是否批准以 29-case suite 为基础，并加入 1/8/16 线程、guards 及 SGEMV-T/DGEMV-N isolation？ | 批准该最小组合；避免扩展到全部 GEMV 变体 | 当前三套 correctness 描述不一致，需要一个正式 inventory | OD-05/06、Formal Correctness qualification |
| HC-06 | SGEMV-N reference 与 tolerance 采用什么正式标准？ | 使用 Candidate-independent 高精度标量 reference，采用随运算长度/尺度变化的 tolerance；具体公式由数值/BLAS owner 确认 | 现有 `1e-4` 为 provisional，且与 C harness 规则不一致 | OD-06、correctness pass/fail 的合法性 |
| HC-07 | 哪些现有 performance points 是 critical，边界点是否进入 primary aggregate？ | square/wide/tall 多线程与 owner 指定 large cases 作为业务核心候选；边界点先作诊断/回退检查，再决定权重 | 当前 17/18 critical 与等权分配缺少业务依据 | OD-03/07、claim scope、aggregate 与 regression gate |
| HC-08 | 是否授权在正式优化前进行 S5000C A/A calibration，并据此批准 warmup/loops/samples/uncertainty/threshold？ | 授权；以现有 warmup 3、samples 7、loops 60 作为起点而非结论 | 没有机器噪声和计时分辨率数据，任何百分比都会是武断值 | OD-03/07、performance acceptance 和实验成本 |
| HC-09 | MCP 的 minimum positive improvement 与 critical regression boundary 由谁批准？ | 由 HC-04 的 Evaluator owner 与 Human Approver 基于 calibration 联合确认 | 这是产品接受标准，不等同于统计脚本默认值 | OD-03、`Performance Target Not Met` 与 `Performance Regression` 判定 |
| HC-10 | 谁担任最终 Human Approver？ | 指定一名对 SGEMV 代码、性能与交付风险负责且不由 Agent 替代的工程负责人 | Approve 表示接受 Candidate 及其有限 claim，不只是执行 merge | First MCP Experiment Definition 的最终责任与交付 |

HC-01 至 HC-09 解决 OD-01 至 OD-07 的产品阻塞项；HC-10 用于补齐首场 Experiment Definition。精确 machine/resource validity 属于后续 OD-08 至 OD-10 的决策范围，本文只将其保留为 `OPEN`，不以历史 `0-15/NUMA 0` 代替正式确认。
