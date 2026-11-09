# CorePilot 当前代码评估与重写建议

日期：2026-10-16。源码基线：`e00bb729bf3ec2a6dc4a2f6795be6fc52d72562d`，开始检查时工作树干净。

**后续决策更新：用户已选择保留现有积累并增量改进。以下重写建议保留为当时的讨论结论，不是当前开发指令；实际路线以 [AGENTS.md](../../../AGENTS.md) 为准。源码问题可作为局部改进的依据。**

## 1. 判断

**建议在新仓库重新实现核心产品，但不认可“现在一无是处、只能全部扔掉”的判断。**

当前系统已经积累了有价值的领域认识：源码候选必须有稳定身份，开发反馈不能替代正式实验，真实机器资源影响测量，正确性失败与实验基础设施失败要分开。这些属于产品知识，应该进入新规格。

当前最主要的问题是迭代中形成的多套执行路径、状态和接线方式。新需求往往要同时经过 Workflow、OptimizationRuntime、Runner 适配和存储对象，公开产品入口又没有覆盖完整生命周期。继续增加适配层会放大理解成本。既然现在明确没有历史兼容要求，重新统一业务模型比在原结构上持续叠加更合适。

**这不是 TypeScript、Node.js 或 SQLite 天生不适合这个产品。** 替换语言或数据库不会自动解决状态归属、实验统计、恢复语义和产品入口不完整的问题。新架构首先解决这些问题。

## 2. 实际检查范围与限制

检查了包依赖、CLI、交互工作台、服务装配、公开优化循环、领域对象、SQLite store、RPC 执行接口、远端传输、实验统计、库接入、模型运行接口、扩展入口、当前生命周期指南和历史审计。

运行 `npm run typecheck`，退出码为 0。没有运行本轮全量测试、远端性能实验、真实模型请求或 VS Code 扩展构建。不能据此声称所有功能可用，也不能给出吞吐或延迟退化百分比。

2026-09-23 的 `CURRENT-STATE.md` 是历史审计，不能直接作为今天的结论。当前已经出现真实 RPC Runner、Hypothesis/Candidate/Experiment/Measurement 存储和 Library Package 流程。

## 3. 问题与证据

| 领域 | 当前事实与源码证据 | 判断与重写方向 |
| --- | --- | --- |
| 后端装配 | `src/cli.ts` 的 `serve()` 同时创建 TaskHost 和 OptimizationWorkflowService；`src/http/server.ts` 同时提供两类入口 | 公开业务和底层调度没有形成单一清晰主线；新产品只保留 Run 业务入口与内部 Job 执行机制 |
| 执行路径 | `src/core/task-host.ts` 默认 MockRunner；公开业务另走 Agent loop；`src/workflow/optimization-workflow-service.ts` 按 RPC/legacy 分流并装配大量依赖 | 不是“全部是 mock”，而是真实链与历史链并存；新实现只保留统一 Runner 协议 |
| 恢复 | Workflow service 使用 `Map<string, Promise<void>>` 和 `Map<string, AbortController>`；取消依赖当前进程内 controller | 公共工作流控制并未因为存了 SQLite 就成为完整持久化执行；恢复应由 Job、checkpoint、Runner 对账驱动 |
| 状态 | Workflow record、OptimizationTask、Candidate、Experiment 各有状态，工作流状态还会映射到 task 状态 | 多对象并非错误，但相同事实存在多处更新；新实现明确每个状态的所有者，视图由事实投影产生 |
| 审批交付 | `approvePublic()` 调用 `approveAndCleanup()` 合并源码；`OptimizationRuntime.approveCandidate()` 另写领域审批记录 | 用户眼中的一个结果被分成不同路径；新产品用 Result → Approval → Delivery 连续入口 |
| 性能阻塞 | `src/testpack/remote-transport.ts` 使用 `spawnSync` 执行 SSH/scp，并被 staging 路径调用 | 可阻塞所在 Node 进程的事件循环；属于明确机制问题，实际延迟仍需测量；改为异步流式 I/O |
| 存储 | 控制端使用 `node:sqlite` DatabaseSync；既有通用 task 表又有 optimization 表，部分内容整条 JSON 覆写 | SQLite 本身可继续使用；问题是业务表归属、更新粒度、事务一致性、迁移机制和大字段去向 |
| 统计 | `src/workspace/validation-runner.ts` 的 gate 在缺失 `ci_lower` 时使用 ratio，并取 workload 下界或 ratio 的最小值作为 overall 下界 | 配置了置信水平不等于计算了置信区间；新实现必须定义真正的抽样与统计方法 |
| 模块大小 | experiment-executor 约 1512 行，task-host 819 行，formal-evaluator 817 行，app.tsx 816 行，optimization-runtime 809 行，workflow service 638 行 | 行数不是定罪证据；结合实际职责可见多个模块承担执行、校验、状态、组装等工作，需要按能力拆分 |
| Agent SDK 边界 | `src/agent/pi-agent-runtime.ts` 导出 Pi 的 AgentTool/AgentEvent；onboarding 等模块直接引用 SDK 类型 | SDK 变化容易传播；新领域接口使用自有协议，厂商 SDK 仅在适配器中出现 |
| CLI 产品完整性 | 当前指南明确 qualification、evidence freeze、领域 approval 等仍需操作脚本衔接 | 已经有底层能力但用户链路不完整；新规格要求所有主流程通过公开 CLI/API 完成 |
| TUI | `scripts/apply-ink-patch.mjs` 在 postinstall 修补依赖；app.tsx 含较多终端交互逻辑 | UI 维护成本偏高；新 TUI 保持薄层、有限视图、明确终端验收矩阵 |
| VS Code | `extensions/vscode/src/extension.ts` 引用当前文件列表中不存在的 ide-task-client、config-service 等文件；根 tsconfig 不覆盖扩展 | 主项目 typecheck 通过不能证明扩展可构建；新扩展只依赖公开 SDK，并纳入独立构建 |
| 测试跟踪 | `.gitignore` 默认忽略 tests 内容，再逐项放行，当前已有多项测试进入跟踪 | 不是“没有测试”；但默认忽略新增测试容易漏提交，新仓库应默认跟踪测试 |

## 4. 值得保留的产品知识

1. 独立工作区、不可变 Candidate 和源码身份。
2. Library Package 把算法领域事实与执行环境分开。
3. Development、Formal、Revalidation 的实验用途分离。
4. 机器、CPU/NUMA、线程、工具链、二进制身份与结果关联。
5. Hypothesis、失败原因、候选 lineage 和结构化实验反馈。
6. Evidence 与最终批准、源码交付之间的可追溯关系。

保留这些知识不要求复制实现。已有成功案例文档可帮助理解需求，但本轮未重新取得和核验全部原始证据，不能把文档中的加速比当作新实现的验收结果。

## 5. 重写的具体范围

重新实现控制端、调度、Agent runtime 接口、Runner、数据库、CLI/TUI 和包格式；不保留 legacy/testpack 双路径、旧命令别名或旧数据库兼容层。旧仓库作为历史参考保留即可。

新仓库的第一条交付线必须是“接入一个小型 C 库 → 生成一个候选 → 真正构建与测试 → 生成结果”。然后增加正式测量、恢复、多 Agent 和真实算法库。不要先造完所有基础设施才尝试跑通产品。

架构好坏用实际标准判断：加一个库是否不改核心，加一个模型是否只改适配器，增加 Agent 是否不共写同一个工作区，断开 CLI 是否不影响实验，以及一个结果是否能解释清楚。所谓“教科书级”应由这些性质体现。
