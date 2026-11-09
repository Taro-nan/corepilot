# PhyOpt Current State Verification

## 1. Verification Baseline

本次验证只针对静态审计对应的确定版本及验证开始前已经存在的用户工作区修改，不修改生产源码、现有测试或 `docs/CURRENT-STATE.md`。

| Item | Value |
| --- | --- |
| Verification date | 2026-09-23（Asia/Shanghai） |
| Branch | `main` |
| Commit | `09d4d9e7b2080b77037837145c9333e34f059f1a` |
| Node.js | `v24.11.1` |
| npm | `11.6.2` |

验证开始时执行：

```text
git status --short
 M src/cli-interactive/commands.ts
?? docs/CURRENT-STATE.md

git rev-parse HEAD
09d4d9e7b2080b77037837145c9333e34f059f1a

git branch --show-current
main
```

`git diff -- src/cli-interactive/commands.ts` 确认这是用户已有修改：删除 `/build`、`/target` 及 SSH 认证子菜单里的显式“返回”选项，改由取消选择（Esc）返回，并相应调整直接连接认证流程。验证过程未 checkout、stash、reset 或改写该文件。

验证边界：本阶段只执行 clean checkout 构建、当前本地 ignored 测试、本地编译/加载、无副作用 CLI 命令，以及位于系统临时目录的合成探针。没有发起模型 API 请求、SSH 连接或真实算法测量。

## 2. Clean Checkout Verification

使用以下 detached worktree 验证当前 commit，而不是复用原工作区中的 ignored 产物：

```text
git worktree add --detach C:\Users\11959\AppData\Local\Temp\phyopt-current-state-verification-09d4d9e HEAD
```

创建后该 worktree 的 `git status --short` 为空，HEAD 与审计 commit 一致；`tests/` 和 `dist/` 均不存在，`git ls-files tests` 也为空。

| Check | Command | Exit code | Result |
| --- | --- | ---: | --- |
| Dependency install | `npm ci` | 0 | 成功；added 440 packages，0 vulnerabilities；postinstall 成功应用 Ink patch |
| Main TypeScript build | `npm run build` | 0 | 成功 |
| Type check | `npm run typecheck` | 0 | 成功 |
| Test command in clean checkout | `npm test` | 0 | 命令成功，但发现 0 tests：pass 0、fail 0、skipped 0、duration 5.6848 ms |
| CLI package | `node scripts/package-cli.mjs` | 1 | 失败；clean build 后缺少 `dist/knowledge/seed-records.js` |
| VS Code extension build | `node extensions/vscode/build.mjs` | 1 | 失败；存在 9 个无法解析的旧模块导入，并有 CJS `import.meta` warning |

第一次在受限执行沙箱内运行 `npm ci` 时由执行环境拦截为 `spawn EPERM`；使用完全相同的命令在获准的本机执行上下文重跑后 exit code 为 0。该 `EPERM` 不属于仓库安装失败。

CLI 打包失败的关键错误为：

```text
ERR_MODULE_NOT_FOUND: dist/knowledge/seed-records.js
```

`npm run build` 不生成以下两个文件：

```text
dist/knowledge/seed-records.js
dist/knowledge/verifier.js
```

原工作区目前存在这两个被 `dist/` ignore 的旧文件，而 clean checkout 在 build 后不存在它们。因此，“本机 stale `dist/knowledge` 可能掩盖 CLI 打包失败”得到动态验证。

VS Code extension 的 9 个 unresolved imports 是：

```text
ide-task-client.js
report-scope.js
experiment-submission.js
experiment-result.js
candidate-generation.js
config-service.js
credential-store.js
vscode-secret-store.js
git-baseline-flow.js
```

clean build 后又执行了只 import、不调用网络或远端的模块加载探针。下列导出均可加载，exit code 为 0：

| Compiled module | Loaded export |
| --- | --- |
| `dist/http/server.js` | `createHttpServer` |
| `dist/workflow/optimization-workflow-service.js` | `OptimizationWorkflowService` |
| `dist/workflow/public-agent-workflow.js` | `runPublicAgentWorkflow` |
| `dist/workspace/validation-runner.js` | `runValidationCycle` |
| `dist/workspace/candidate-workspace.js` | `createCandidateWorkspace` |
| `dist/core/task-host.js` | `TaskHost` |
| `dist/runner/mock-runner.js` | `MockRunner` |

这证明这些关键模块在当前 commit 的 clean build 中不是“仅有源码文件但无法编译加载”。它不证明真实模型、SSH 或 ARM 链路可用。

## 3. Local Workspace Test Verification

原工作区存在本地 `tests/**`，但 `.gitignore:6` 的 `/tests/` 规则会忽略它们；`git ls-files tests` 为空。因此以下结果来自本机 ignored 测试资产，不是当前 commit 可复现的 tracked test suite。

| Item | Result |
| --- | --- |
| `*.test.ts` files | 43 |
| 顶层 `test(...)` declarations | 170 |
| 顶层 `it(...)` declarations | 0 |
| Test script | `node --import tsx --test --test-concurrency=1 "tests/*.test.ts"` |
| Runtime tests | 170 |
| Passed | 170 |
| Failed | 0 |
| Cancelled | 0 |
| Skipped | 0 |
| Todo | 0 |
| Duration | 44858.0186 ms |

执行命令：

```text
npm test
exit code: 0
```

测试输出同时表明它们主要覆盖本地单元、临时 Git/SQLite/HTTP、本地子进程、fake Agent、mock transport 和 `MockRunner` 场景。此次运行没有调用真实模型、SSH 或 ARM 硬件。

文本搜索 `\btest\s*\(` 会得到 173 个 match，但其中 3 个是 `RegExp.prototype.test(...)`，不是 Node test declaration：

```text
tests/cli-resize.test.ts:258
tests/homepage.test.ts:110
tests/model-discovery.test.ts:48
```

Node test runner 实际注册的 170 项与 170 个顶层 `test(...)` declaration 一致。

## 4. Build and Type Verification

回到包含用户既有 `commands.ts` 修改的原工作区后，只运行 `package.json` 已定义的脚本：

| Check | Command | Exit code | Result |
| --- | --- | ---: | --- |
| TypeScript compile/build | `npm run build` | 0 | 成功 |
| Type check | `npm run typecheck` | 0 | 成功 |
| Lint | — | — | `NOT_DEFINED`；当前 `package.json` 没有 lint script，因此未自行创建命令 |

构建与类型检查均未要求修改源码。

## 5. CLI Verification

所有 CLI 检查都只请求 help/version，没有运行 `optimize`、模型探测或 target 探测。

| Context | Command | Exit code | Observed result |
| --- | --- | ---: | --- |
| Clean compiled CLI | `node dist/entry.js --help` | 0 | 显示 optimize、serve、backend、workflow 用法及 `--file` 语义 |
| Clean compiled CLI | `node dist/entry.js --version` | 0 | 输出 `0.4.0` |
| Current source/dev entry | `npm run dev -- --help` | 0 | 成功启动并显示同一 help |
| Current source/dev entry | `npm run dev -- --version` | 0 | 输出 `0.4.0` |

CLI entry 因此可从 clean build 产物和当前开发入口启动。交互式无参数会话未在本阶段自动驱动。

## 6. Architecture Assertions

以下结果结合实际源码调用链、已执行的本地测试和无网络合成探针。`VERIFIED` 只表示断言本身成立，不表示相关能力已经通过真实 ARM E2E。

| Assertion | Audit Claim | Verification Result | Evidence | Notes |
| --- | --- | --- | --- | --- |
| A | public optimize 和 TaskHost 是两个独立执行平面 | VERIFIED | `src/cli.ts::serve()` 分别构造 `TaskHost` 与 `OptimizationWorkflowService`；`src/http/server.ts::handle()` 将 `/v1/workflows` 交给 `workflowService.submitPublic()`，将 `/v1/tasks` 交给 `host.createTask()` | 两者只共享 HTTP server 和 `SqliteTaskStore`；public workflow 不经 TaskHost 调度 |
| B | TaskHost 默认 runner 是 MockRunner | VERIFIED | `src/core/task-host.ts::TaskHost.constructor()` 的默认 `runnerFactory` 为 `new MockRunner(job.scenario, ...)`；`runnerFor()` 使用该 factory | `npm test` 中 TaskHost success/failure/resource/recovery 场景均为本地 mock 证据，不是远端 Runner 证据 |
| C | public optimize 没有 process restart 后自动 resume | VERIFIED | `OptimizationWorkflowService` constructor 只构造 store；运行中的 Promise/AbortController 仅存 `running`/`controllers` Map；只有 `submitPublic()` 会调用 `executePublic()`；`cancel()` 在 controller 不存在时返回 “workflow is not active in this backend process” | 临时 SQLite 探针保存 `GENERATING` 后重新构造 service，读取状态仍为 `GENERATING`，cancel 返回 `ok:false` 和上述信息；没有模型调用 |
| D | WorkspaceToolset 可修改测试、benchmark、Makefile、validation script 等普通 worktree 文件 | VERIFIED | `src/agent/workspace-tools.ts::assertWritable()` 只保护顶层 `.git`、`.phyopt`、`node_modules`；write/create/replace/delete/move 均仅调用该检查及 workspace path 检查 | 临时目录探针成功写入 `Makefile`、`tests/correctness.test`、`benchmarks/run.sh`、`validation/evaluator.py`；写 `.git/config` 被拒绝 |
| E | CPU/NUMA/thread 没有在通用 runner 层强制执行 | VERIFIED | `src/workspace/validation-runner.ts::runValidationCommand()` 只按 command 的 executable/args/cwd/environment/timeout spawn；`runValidationCycle()` 不读取 `testpack.resources` | 合成 testpack 声明不存在的 CPU/NUMA/thread 值 `999999`，本地 cycle 仍成功；这些字段只在配置解析、摘要及 Agent evidence 中出现 |
| F | sampling/bootstrap/confidence interval 没有由 runner 实现 | VERIFIED | `runValidationCycle()` 对 performance command 只调用一次；`parsePerformanceMeasurements()` 只解析 command stdout；`evaluatePerformanceGate()` 在缺少 `ci_lower` 时直接使用 ratio；runner 不引用 sampling、bootstrap 或 confidence_level | 合成 testpack 声明 warmup 5、samples 7、bootstrap 999、confidence 0.999；仅提供 1 条无 `ci_lower` measurement，gate 仍以 ratio 2 同时作为 overall/key lower bound 并通过 |
| G | workflow 只保存最新 candidate，不保存 candidate population | VERIFIED | `runPublicAgentWorkflow()` 只有单个 `let checkpoint`，每轮由 `checkpointCandidate()` 覆盖；`CandidateWorkspaceState` 只有单个 `candidate_commit`/`candidate_tree`；`OptimizationWorkflowRecord` 也只有单组 candidate 字段 | 旧轮次 commit 可能仍存在于同一 Git 历史链，但没有候选集合、独立身份列表、排名或 selection 数据结构 |
| H | 原始 stdout/stderr 和 measurement samples 没有持久化 | VERIFIED | `OptimizationWorkflowService::summarizeCommand()` 只保留 ok、exit_code、timed_out、cancelled、duration_ms；`summarizeValidation()`/`summarizeRevalidation()` 使用该摘要；`SqliteOptimizationWorkflowStore.save()` 只序列化 workflow record | `performance_result` 保存 gate 汇总和 case ratios，不保存解析前 stdout/stderr 或逐次 samples；完整 command output 只在运行期 `CommandRunResult` 中存在 |

合成 runner 探针仅在系统临时目录启动本机 Node 子进程；受限沙箱第一次阻止子进程为 `spawn EPERM`，在获准的本机执行上下文用同一探针重跑后 exit code 为 0。它不是正式 correctness 或 performance 测量。

## 7. What Was Not Executed

| Item | Verification status |
| --- | --- |
| DeepSeek/OpenAI/Kimi/Qwen/GLM/Doubao/MiMo 或自定义模型真实调用 | `NOT_EXECUTED_IN_THIS_VERIFICATION` |
| 模型列表发现和真实 tool call verification | `NOT_EXECUTED_IN_THIS_VERIFICATION` |
| 真实 SSH 连接 | `NOT_EXECUTED_IN_THIS_VERIFICATION` |
| 真实飞腾/ARM 服务器 | `NOT_EXECUTED_IN_THIS_VERIFICATION` |
| SGEMV 正式 correctness | `NOT_EXECUTED_IN_THIS_VERIFICATION` |
| SGEMV 正式 benchmark/performance | `NOT_EXECUTED_IN_THIS_VERIFICATION` |
| 真实 baseline/candidate/revalidation 测量 | `NOT_EXECUTED_IN_THIS_VERIFICATION` |

这些项目没有被标为失败；它们属于后续独立的真实环境 E2E verification。

## 8. Differences From CURRENT-STATE.md

发现一项非架构性的计数修正：

- `docs/CURRENT-STATE.md` 将宽泛正则得到的 173 个 `test(...)` 文本 match 记为 173 个测试调用。
- 动态运行注册了 170 项测试；按顶层 `^test\(` 统计也为 170。
- 额外 3 个 match 是正则表达式对象的 `.test(...)` 调用，位置为 `tests/cli-resize.test.ts:258`、`tests/homepage.test.ts:110`、`tests/model-discovery.test.ts:48`。

这不改变该文档关于“测试只存在于本地 ignored `tests/**`、clean checkout 没有测试”的结论。其余关键架构与可靠性结论未发现实质矛盾；clean build、打包失败、VS Code extension 失败及 A–H 探针均支持原静态审计。按照本阶段约束，没有回写或修改 `docs/CURRENT-STATE.md` 的历史结论。

## 9. Verification Conclusion

已得到动态证据支持的部分：当前 commit 可完成依赖安装、主 TypeScript build 和 typecheck；clean build 的 CLI help/version 与关键编译模块可加载；原工作区本地 ignored 测试为 170/170 通过；clean checkout 确实没有 tests；CLI packaging 确实依赖 clean build 不会生成的 stale `dist/knowledge`；VS Code extension 当前确实无法构建；A–H 所列双执行平面、默认 MockRunner、无 public restart resume、宽松工作树写边界、未强制资源/采样统计、单一最新候选和摘要持久化结论均得到源码与本地探针支持。

仍主要属于静态结论的部分：更广泛的产品模块边界、专项 SGEMV 资产与主链的全部错配、SSH 中断行为、远端目录生命周期、不同模型厂商兼容性，以及完整安全与复现性边界。本阶段没有用真实外部环境改变这些结论的证据等级。

必须由后续真实 ARM E2E 才能证明的部分：真实模型驱动 Agent、真实 SSH staging、飞腾服务器上的 build/correctness/performance、CPU/NUMA/thread 实际约束、baseline/candidate 二进制身份、正式重复采样与统计、断线恢复，以及最终候选在真实算法库上的可重现性能结果。

本次验证结束时已移除 detached validation worktree；没有执行真实生产优化，也没有修复验证中发现的任何问题。
