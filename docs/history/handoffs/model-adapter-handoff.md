# Agent 模型适配交接文档

> 文档说明：第 1—12 节保留了 2026-09-14 的接入前架构快照，用于说明问题背景；其中关于“Pi 尚未接入”的表述均为历史状态。当前实现与验收结果以第 13 节及 `docs/dev-log/2026-09-15-27-pi-provider-audit.md`—`2026-09-15-32-pi-final-validation.md` 为准。

> 交接对象：下一阶段“Agent 模型适配”并行开发任务  
> 文档日期：2026-09-14  
> 工作目录：`D:\Projects\phytium\phyopt-agent`  
> 当前分支：`feat/workflow-experience`

## 1. 先看结论

PhyOpt 不是一个把模型输出直接写回源码的聊天壳，而是一个“模型提出候选，核心门禁验证和执行”的优化工作流：

```text
CLI / VS Code
    │ 共享 PhyOptConfig + CredentialService
    ▼
buildModelProvider()
    ▼
ModelProvider.call(task, context, constraints)
    ▼
JSON 解析 → Hypothesis Gate → Patch Gate
    ▼
候选补丁 bundle（默认不自动应用）
    ▼
TaskHost / ExperimentRunner
    ▼
BUILD → CORRECTNESS → PERFORMANCE → 报告/证据/交付
```

图示表示系统边界和目标工作流。`/optimize` 生成的候选可由 `/test` 或 `/benchmark` 通过候选 ID（或当前候选指针）明确选择；执行前会校验源码身份、补丁哈希和允许文件，并将候选信息绑定到实验上下文。

当前生产接线状态：

- `mock`：本地确定性替身，不调用云模型；空响应时会生成明确标记为 simulated 的候选。
- `openai-compatible`：已接入通用 HTTP `POST /chat/completions` 路径。
- `pi`：`src/model/pi-provider.ts` 已实现 `@earendil-works/pi-ai` 适配器和测试，但尚未被生产的 `buildModelProvider()` 工厂选择；不能把“Pi 适配器存在”误认为“CLI 已支持 Pi provider”。
- 默认开发和测试不连接云模型、不连接 ARM 机器；真实调用必须由用户显式配置并承担网络/费用风险。

## 2. 当前项目整体架构

### 2.1 入口和运行形态

- `src/entry.ts`：npm `bin` 的真实入口。先安装 SQLite warning 过滤器，再动态导入 `src/cli.ts`，最后设置退出码。
- `src/cli.ts`：普通 CLI 命令分发器和异步命令入口。`phyopt --help`、`version`、`run`、`status`、`serve`、`backend`、`project`、`testpack` 等从这里进入。
- 无参数且 stdin/stdout 都是 TTY 时，`runCli()` 懒加载 `src/cli-interactive/start.ts` 启动 Ink 工作台；非 TTY 不加载 React/Ink。
- `src/cli-interactive/`：交互输入、斜杠菜单、首页、命令执行和退出生命周期。UI 只负责收集输入与呈现，不应复制模型业务逻辑。

### 2.2 共享配置、凭据和上下文

- `src/config/phyopt-config.ts`：版本为 1 的 `PhyOptConfig` schema、默认值和严格校验。
- `src/config/config-service.ts`：CLI 与 IDE 共享的文件配置读写、原子保存、局部 patch 和显示安全视图。
- `src/config/credential-store.ts`：`CredentialService`。解析顺序是“引用对应的环境变量 → OS 安全存储”；CLI 在 Windows 优先使用 DPAPI，安全存储不可用时明确退回会话内存，不静默写明文。
- `src/config/vscode-secret-store.ts`：VS Code `SecretStorage` 的 `SecureStore` 实现。
- `src/config/context-assembler.ts`：将共享配置组装成经过校验的 `ExperimentContext`，缺项返回具体问题，不猜测补齐。
- `src/cli-interactive/context.ts`：交互工作台上下文，懒加载 `ApiClient` 并管理 backend 状态。

### 2.3 后端和实验执行

- `src/backend/backend-manager.ts`：探测、复用或启动受管 PhyOpt backend；防止误接管外部服务。
- `src/http/server.ts`、`src/core/task-host.ts`、`src/core/task-service.ts`：HTTP 任务主机、任务持久化和恢复。
- `src/storage/sqlite-task-store.ts`：SQLite 任务、事件、作业、候选和报告相关持久化。
- `src/runner/`、`src/experiment/`：执行计划、命令执行、构建、正确性、性能、SSH/本地 transport、receipt 和取消/恢复。
- `src/contracts/`：实验上下文、任务状态、运行协议、候选、测试计划、授权和证据等稳定契约。
- `src/exploration/`：候选生成、预算、去重、测量锁、双路探索和重启恢复。
- `src/delivery/`、`src/statistics/`：报告、导出、接受决策、集成和性能统计。

### 2.4 IDE 适配

`extensions/vscode/src/extension.ts` 复用核心 `src/client/` 和 `src/config/` 模块，而不是再实现一套模型调用：

```text
VS Code 命令 phyopt.optimize
  → ConfigService + VscodeSecretStore
  → buildModelProvider()
  → generateCandidate()
  → 原生 diff / 任务视图
```

受管 backend 启动时，IDE 将解析后的凭据通过子进程环境注入，绝不放入 argv、项目配置或日志。

## 3. Agent Runtime / Pi SDK 相关模块

### 3.1 PhyOpt 的 Agent Runtime 边界

当前代码中没有独立的“自主 Agent Runtime”包；模型运行时由以下可组合模块构成：

- `src/model/provider.ts`：可替换的模型调用接口、结果元数据、超时/取消/重试工具。
- `src/model/orchestrator.ts`：把任务、证据和动态输出约束交给 provider，再调用 `validateModelHypothesis()`；只返回结构化假设，不执行命令。
- `src/exploration/model-candidate-generator.ts`：候选生成入口；解析模型 envelope，执行假设门禁和补丁转换/校验。
- `src/model/hypothesis-gate.ts`：D11 结构门禁，校验 JSON、字段、枚举、证据引用、允许文件、保护路径及禁止模型设置最终 verdict。
- `src/model/tool-gate.ts`：只读工具边界。目前只允许读取限定源码 fixture、允许的项目元数据和已清洗实验摘要；`shell`、`ssh`、写文件、执行、commit、push 等在入口直接拒绝。
- `src/experiment/patch-gate.ts`：允许文件、受保护路径、路径遍历和 `git apply --check` 等补丁门禁。

因此，模型的权限是“生成受约束的文本候选”，不是直接访问 shell、SSH、文件写入或实验执行。

### 3.2 Pi SDK 适配器

- 依赖：`@earendil-works/pi-ai@0.85.1`，锁定在 `package.json` / `package-lock.json`。
- 文件：`src/model/pi-provider.ts`，导入 `createModels`、`contentText` 以及 `Models`、`Context` 类型。
- 构造参数：
  - `providerId`：Pi provider id；默认读取 `PHYOPT_PI_PROVIDER`。
  - `modelId`：Pi model id；默认读取 `PHYOPT_PI_MODEL`。
  - `models`：可注入的 `Models` 集合，测试用 faux provider。
  - `maxRetries`、`timeoutMs`：覆盖默认调用策略。
- 调用方式：`models.getModel(providerId, modelId)` 后使用 `models.completeSimple(model, piContext, { signal })`；从返回 message 用 `contentText()` 提取文本。
- 取消/超时：通过 `withRetriesAndTimeout()` 将 `AbortSignal` 传给 Pi SDK，超时或 Ctrl+C 会终止正在进行的调用，而不是只结束等待。
- 未配置和找不到模型时返回结构化失败结果，不抛出未处理异常，也不自动降级到 Mock。
- 当前限制：Pi provider 没有接入 `src/client/candidate-generation.ts` 的生产 factory，CLI `/model` 也不能选择 `pi`；需后续适配任务明确配置映射后再接线。

## 4. 当前模型调用路径

### 4.1 CLI `/optimize`（当前生产路径）

1. 用户通过 `/model` 写入共享 `PhyOptConfig.model`，或已有配置被加载。
2. `src/cli-interactive/commands.ts` 的 `/optimize` 检查项目/Git 基线、收集目标文件和自然语言目标。
3. `buildModelProvider(config, resolveCredential)`（`src/client/candidate-generation.ts`）根据 provider 创建：
   - `MockProvider`，标记 `simulated: true`；
   - `OpenAICompatibleProvider`，解析 endpoint 和 API key；
   - 其他 provider 当前返回“不支持的模型 provider”。
4. `generateCandidate()` 读取项目内选定源码，构造任务文本，并创建 `ModelCandidateGenerator`。
5. `ModelCandidateGenerator.generate()`：
   - 生产默认使用 `mode: 'diff'`；
   - 通过 `buildCandidateConstraints()` 要求模型返回单个 JSON envelope：

```json
{
  "hypothesis": { "...结构化假设字段...": "..." },
  "patch": "diff --git ..."
}
```

   - `parseModelOutputJson()` 只接受纯 JSON 或单个 fenced JSON，不修复解释文本、多段代码块或坏 JSON。
   - `validateModelHypothesis()` 校验字段、枚举、证据引用、`affected_files` 与 `allowed_files`，并拒绝模型声明 `ACCEPTED`/`verdict`/`status` 等结论。
   - `processDiffPatchFromEnvelope()` 校验补丁实际触及的文件集合必须与 `hypothesis.affected_files` 完全一致，再交给补丁门禁。
6. 通过门禁后将 `CandidateBundle` 写入项目下 `.phyopt/candidates/<candidate_id>.json`；不会自动应用补丁、运行测试或宣称性能提升。
7. `/candidate diff` 和 VS Code 原生 Diff 可查看候选。`/test [candidate-id]` 与 `/benchmark [candidate-id]` 会把同一候选的 ID、补丁正文和哈希写入 `ExperimentContext`，并在 BUILD 前由 Runner 在目标 worktree 应用补丁；不指定候选时默认使用当前候选，`--frozen` 可强制验证冻结源码。

### 4.2 OpenAI-compatible HTTP 细节

`src/model/openai-compatible-provider.ts` 使用 `fetch`：

- 方法：`POST`。
- Header：`content-type: application/json`；若有 key，增加 `Authorization: Bearer <key>`。
- Body：

```json
{
  "model": "<model name>",
  "messages": [
    { "role": "system", "content": "<output constraints>" },
    { "role": "user", "content": "Task:\n<task>\n\nContext:\n<context>" }
  ]
}
```

- 响应必须包含 `choices[0].message.content` 字符串。
- 默认 provider 层最多 1 次初始调用 + 2 次重试，默认超时 30 秒；生产候选生成当前显式使用 `maxRetries: 0`、30 秒。
- `/model verify` 使用最小探测请求，当前超时 15 秒且不发送项目源码。
- 错误结果带 provider/model/request_id/attempts/timed_out/error 元数据，但不得包含 API key。

### 4.3 Pi/假设专用路径

`ModelHypothesisOrchestrator.generateHypothesis()` 是另一条可复用的低层路径：

```text
ModelProvider.call(task, evidence, buildOutputConstraints(ctx), signal)
  → validateModelHypothesis()
  → ModelHypothesisResult
```

它只返回 `StructuredHypothesis`，不生成 patch，也不负责候选持久化。D11 测试用它验证 Mock、OpenAI-compatible 和 Pi provider 的调用契约；生产 `/optimize` 目前走 `ModelCandidateGenerator`。

## 5. 现有配置结构

配置文件默认位置为 `~/.phyopt/config.json`，可用 `PHYOPT_CONFIG_PATH` 覆盖。`PhyOptConfig` 的顶层主要字段为：

```text
schema_version
project_root
backend
model
target
build
source
test_assets[]
baseline
gates
budget
output_dir
current { task_id, candidate_id }
```

其中模型段当前定义为：

```json
{
  "model": {
    "provider": "mock | openai-compatible | 其他保留值",
    "name": "model-id-or-name",
    "credential_ref": "PHYOPT_MODEL_API_KEY",
    "endpoint_ref": "PHYOPT_MODEL_ENDPOINT",
    "endpoint": "https://example.com/v1/chat/completions"
  }
}
```

约定和优先级：

- `model` 默认是 `null`；配置校验拒绝未知字段和嵌入式 raw secret。
- `endpoint` 是非秘密的 literal URL；`endpoint_ref` 是环境变量/安全存储引用。OpenAI-compatible 生产 factory 的优先级是 `endpoint` → `endpoint_ref` 对应环境变量 → `PHYOPT_MODEL_ENDPOINT`。
- `credential_ref` 只保存引用名，不保存 API key。`CredentialService.resolve(ref)` 的优先级是 `process.env[ref]` → secure store。
- CLI 的 `/model` 会隐藏输入 API key，保存到当前平台安全存储；安全存储不可用时只允许明确的 session-only 或环境变量语义。
- 当前 `/model` 命令只接受 `mock`、`openai-compatible`，也支持把完整 `/chat/completions` URL 作为 shorthand；endpoint 路径会先校验。
- `describeForDisplay()` 只显示 provider、name、credential_ref 等安全字段，不显示 secret。

Pi 目前使用独立环境变量读取默认值：`PHYOPT_PI_PROVIDER`、`PHYOPT_PI_MODEL`。这些变量不会自动把 `model.provider` 变成可用的 Pi 生产配置；适配时应先决定是否扩展 schema，而不是把 Pi provider id 复用成含义不清的 `name`。

## 6. 和模型相关的关键文件及作用

| 文件 | 作用 |
| --- | --- |
| `src/model/provider.ts` | `ModelProvider`、`ModelCallResult`、默认重试/超时和 AbortSignal 传播。所有新 provider 的最小契约。 |
| `src/model/mock-provider.ts` | 确定性本地模型替身；预置响应、失败注入、延迟和取消测试。 |
| `src/model/openai-compatible-provider.ts` | 通用 OpenAI-compatible HTTP provider；处理 env fallback、Bearer key、响应解析、超时重试。 |
| `src/model/pi-provider.ts` | `@earendil-works/pi-ai` `Models.completeSimple()` 适配器；目前未接入生产 factory。 |
| `src/model/orchestrator.ts` | 假设专用编排器和动态输出约束构造器。 |
| `src/model/hypothesis-gate.ts` | D11 结构/范围门禁；防止模型越权或伪造结论。 |
| `src/model/tool-gate.ts` | 只读工具白名单；禁止 shell/SSH/写文件/执行/commit/push。 |
| `src/client/candidate-generation.ts` | 生产 provider factory、源码读取、任务 prompt、候选 bundle 持久化；CLI/IDE 共用。 |
| `src/exploration/model-candidate-generator.ts` | envelope 解析、纯 JSON 约束、假设门禁、diff/files 模式和 patch 记录。 |
| `src/cli-interactive/commands.ts` | `/model` 配置/verify、`/optimize` 调用候选生成器；不是另一个 provider 实现。 |
| `src/config/phyopt-config.ts` | 模型配置字段、schema、默认值和 raw-secret 拒绝。 |
| `src/config/credential-store.ts` | CLI 凭据解析、OS secure store、session fallback。 |
| `src/config/vscode-secret-store.ts` | VS Code SecretStorage 桥接。 |
| `src/config/config-service.ts` | CLI/IDE 共享配置文件和原子更新。 |
| `src/config/context-assembler.ts` | 共享配置 → `ExperimentContext`，不替模型填充缺失身份或门禁。 |
| `src/contracts/experiment.ts` | `StructuredHypothesis` 等模型输出所依赖的稳定契约。 |
| `extensions/vscode/src/extension.ts` | IDE 配置模型、解析 SecretStorage、复用 `buildModelProvider()` 和 `generateCandidate()`。 |
| `tests/d11.test.ts` | 假设门禁、provider 结果、Pi faux provider、超时和取消。 |
| `tests/v2-candidate-generation.test.ts` | provider factory、源码输入、候选持久化和非法补丁。 |
| `tests/v2-cli-workbench.test.ts` | `/model`、`/optimize` 和交互命令上下文。 |
| `tests/v2-config.test.ts` | 配置 round-trip、schema、未知字段和 secret 拒绝。 |

## 7. 已做出的设计决策

1. **Provider 可替换**：上层依赖 `ModelProvider`，不依赖某家 SDK 或 HTTP 客户端。
2. **模型输出必须经过核心门禁**：prompt 约束不是安全边界；JSON、证据、文件范围和补丁都在本地再次校验。
3. **模型不拥有最终结论**：模型不能设置 `ACCEPTED`、`REJECTED` 或最终状态；正确性和性能 verdict 由实验/统计核心产生。
4. **候选和执行分离**：模型生成候选后先持久化、查看 diff，再由 `/test`/`/benchmark` 进入实验；不会隐式修改用户工作树。
5. **CLI 与 IDE 共用同一生成路径**：两端都使用 `buildModelProvider()`、`generateCandidate()` 和同一组门禁。
6. **凭据只传引用**：配置、argv、任务 context、receipt、报告和日志不保存 raw secret；实际值只在调用点或受管子进程环境中短暂存在。
7. **取消必须到达底层请求**：provider 不能只用 `Promise.race` 放弃等待，必须把 AbortSignal 传到 fetch/Pi SDK。
8. **Mock 明确标注**：Mock 结果为 simulated，不得伪装成云模型调用或真实 ARM 证据。
9. **证据和范围动态注入**：输出 constraints 使用本次任务真实 evidence IDs 与 `allowed_files`，防止模型引用不存在证据或扩大文件范围。
10. **失败不静默降级**：provider 未配置、凭据缺失、模型不存在或输出非法都返回清晰失败，不自动改用 Mock。
11. **实验核心独立于模型**：BUILD、CORRECTNESS、PERFORMANCE、资源授权、运行身份和报告完整性不能由模型适配层绕过。

## 8. 不能破坏的兼容性和约束

### 8.1 API/配置兼容性

- 保持 `ModelProvider.call(task, context, outputConstraints, signal?)` 和完整 `ModelCallResult` 字段。
- 保持 Node 最低版本 `>=22.19.0`、ESM、TypeScript 构建和 `@earendil-works/pi-ai@0.85.1` 锁定版本；不设置 Node 大版本上限。
- 保持 `PhyOptConfig.schema_version = 1` 的已有字段语义；新增字段必须通过校验、文档和迁移策略落地。
- 保持通用环境变量：`PHYOPT_MODEL_ENDPOINT`、`PHYOPT_MODEL_API_KEY`、`PHYOPT_MODEL_NAME`；OpenAI provider 对旧 `PHYOPT_PI_ENDPOINT`、`PHYOPT_PI_API_KEY`、`PHYOPT_PI_MODEL` 的 fallback 是迁移兼容，不应突然删除。
- 保持 `phyopt --help`、非交互 CLI、CLI/IDE 共享配置和现有斜杠命令行为。

### 8.2 安全和实验约束

- 禁止将 API key、SSH 密码、token、私钥放入配置、Git、argv、日志、报告、任务上下文或模型输出记录。
- 不允许新 provider 绕过 `hypothesis-gate`、`patch-gate`、文件 allow-list、protected paths、Git 基线和实验授权。
- 不要给模型开放 shell、SSH、写文件、执行、commit、push 或自动联网工具；如需工具，必须扩展 `ReadonlyToolGate` 并为每个参数增加范围校验。
- 不允许模型直接修改工作树、直接提交/推送或自行宣称性能通过。
- 真实网络模型调用和 ARM 执行必须是显式配置/授权行为；测试默认离线、Mock 或 faux。
- provider 必须支持有界重试、硬超时、外部取消；退出/取消时不得留下后台请求或延迟输出。
- 任何模型输出都视为不可信输入；禁止“自动修复 JSON”、自动扩大文件列表或把错误响应当成功。

## 9. 当前测试方式

常用命令：

```powershell
npm run typecheck
node --import tsx --test --test-concurrency=1 tests/d11.test.ts tests/v2-candidate-generation.test.ts tests/v2-cli-workbench.test.ts
npm test
npm run build
node scripts/package-cli.mjs
```

当前基线全量测试为 681/681 通过。模型相关测试重点是：

- `tests/d11.test.ts`：合法/非法结构化假设、保护路径、证据引用、禁止 verdict、重试上限、超时、取消、OpenAI key 脱敏、Pi faux provider 调用和底层 abort。
- `tests/v2-candidate-generation.test.ts`：Mock provider factory、缺 endpoint/credential 不静默降级、候选读取/持久化、非法补丁拒绝。
- `tests/v2-cli-workbench.test.ts`：CLI `/model` 配置和验证、真实端点 shorthand、未知 provider、`/optimize` 接线。
- `tests/v2-config.test.ts`：配置 schema 和 secret 引用规则。

测试环境不应依赖真实云端响应。Pi 适配使用 `createModels()` + `fauxProvider()` 注入假 provider；OpenAI-compatible 主要验证结构、错误脱敏和 factory，不使用真实 API key。

## 10. 模型适配建议从哪里切入

建议按下面顺序切入，先保持现有门禁和候选格式不变：

1. **先定义 provider 配置映射**：决定 `model.provider = "pi"` 时如何表达 `providerId`、`modelId`、endpoint/credential 引用。不要把两个 Pi 标识无说明地塞进现有 `name`；必要时新增明确字段并升级 schema/测试。
2. **扩展唯一 provider factory**：在 `src/client/candidate-generation.ts::buildModelProvider()` 注册 Pi，返回同一 `ModelProvider` 接口和 `simulated` 标记；CLI 与 IDE 会自动共享这条路径。
3. **确定 Pi 的凭据注入方式**：核对 Pi SDK 0.85.1 对 provider 的环境变量/配置要求，使用 `CredentialService` 解析引用；不得把 secret 放入 config、argv 或日志。若 backend 进程需要凭据，沿用 IDE 的 `extraEnv` 注入约定。
4. **复用现有完整调用协议**：Pi 适配器继续接收 `task/context/outputConstraints`，返回完整 `ModelCallResult`；默认使用 `completeSimple`，先不要在上层引入一套 streaming 专用结果类型。
5. **先补 faux/单元测试**：覆盖 provider lookup、成功、未配置、未知模型、API 错误、超时、外部取消和 key 脱敏；再补 `buildModelProvider()` 与 `/model` 配置测试。
6. **验证候选门禁不变**：使用 Pi 返回的相同 `{hypothesis, patch}` envelope，通过 `ModelCandidateGenerator`、hypothesis gate、patch gate 和候选持久化；不要在 provider 内复制或绕过这些逻辑。
7. **最后再做真实 provider smoke test**：需要用户明确提供 endpoint/凭据和费用授权；测试应使用最小请求、可撤销超时，并记录 provider/model/request_id 等非秘密元数据。

## 11. 待完成事项

- 将 `PiModelProvider` 接入 `buildModelProvider()`，并决定/实现稳定的 Pi 配置 schema。
- 统一 CLI `/model` 与 VS Code 模型配置向导对 Pi provider、provider id、model id、endpoint 和 credential ref 的表达。
- 核对 Pi SDK 的 provider 注册、环境变量、OAuth/API key 和 endpoint 覆盖机制；明确哪些配置由 SDK 管理、哪些由 PhyOpt 管理。
- 为 provider 建立能力/配置注册表，逐步替代 CLI 中硬编码的 `SUPPORTED_MODEL_PROVIDERS`，同时保留未知 provider 的清晰错误。
- 明确模型调用记录是否要持久化到候选/任务 evidence；若持久化，必须只记录脱敏的 request metadata 和 gate 结果，不记录凭据。
- 评估 `budget.max_model_calls` 与探索层生成配额的统一执行位置，确保重试和失败调用的计数语义一致。
- 为真实 provider 增加本地可控 HTTP stub 或录制回放测试，避免测试依赖云服务。
- 评估 Pi 的流式输出、工具调用和多轮上下文是否有产品需求；在没有明确需求前维持当前单次完整文本调用和只读工具边界。
- 真实云模型和真实 ARM 仍需单独授权、环境验收和证据审计；不能用 Mock 测试结果替代。

## 12. 交接检查清单

接手者开始编码前应确认：

- [ ] 已阅读 `src/model/provider.ts`、`src/model/pi-provider.ts`、`src/client/candidate-generation.ts`。
- [ ] 已理解“Pi 适配器存在，但生产 factory 尚未注册”的当前状态。
- [ ] 已阅读 `src/model/hypothesis-gate.ts`、`src/model/tool-gate.ts` 和 `src/experiment/patch-gate.ts`。
- [ ] 已确认配置只保存 credential/endpoint 引用，不保存 secret。
- [ ] 已先运行模型相关测试和 `npm run typecheck`。
- [ ] 新 provider 有 faux/离线测试，且未引入真实云模型或 ARM 依赖。
- [ ] CLI 与 VS Code 都复用同一个 provider factory 和候选生成路径。
- [ ] 任何真实连接、凭据、远程执行和发布操作都经过用户明确授权。
## 11. Pi provider 接入状态（2026-09-15 更新）

Pi 已接入统一模型调用链：

- `ModelConfig` 增加可选 `pi_provider`，旧 schema-v1 配置仍可读取；未配置时兼容读取 `PHYOPT_PI_PROVIDER` / `PHYOPT_PI_MODEL`。
- provider registry 新增 `pi`（adapter=`pi`），`/model` 可按 `pi <pi-provider> <model-id>` 配置。
- `buildModelProvider()` 根据 registry adapter 创建 `PiModelProvider`，候选生成、CLI、IDE 和工作流继续共用这一工厂。
- `PiModelProvider` 生产默认使用 `builtinModels()`；API Key 通过内存 `CredentialStore` 显式注入，不修改全局 `process.env`。
- `verifyModelProvider()` 与原 HTTP 验证共享最小请求和错误分类路径；Pi 配置在验证成功后才保存凭据和配置。
- 测试通过 faux Pi provider 覆盖 factory、调用和 `/model pi` 失败不落盘场景；不进行真实模型请求。

Pi 当前要求 API Key 引用 `PHYOPT_PI_API_KEY`。支持 OAuth 或自定义 Pi provider 目录仍属于后续扩展，不能绕过统一 factory 直接新增调用链。
