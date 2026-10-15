# CorePilot

CorePilot 是面向 CPU 基础算法库的 Agent 性能工程工具。当前产品流程围绕 Library Package、Hypothesis、Candidate 和真实目标机实验展开：Agent 在独立工作树中调查源码，在 Package 允许的 scope 内修改文件，根据 Development/Formal feedback 迭代，并通过独立 Revalidation 和显式 Human Approval 固定结果。

当前版本：`0.4.0`。Node.js 最低要求：`>=22.19.0`。

项目原名 PhyOpt，当前仓库与 npm package 名为 `corepilot`，主要命令为 `corepilot` 和 `corepilot-runner`。旧命令 `phyopt`、`phyopt-runner` 仍为兼容入口；现有 `phyopt.yaml`、`.phyopt/`、`PHYOPT_*` 环境变量和 RPC/measurement 标识保持兼容。历史 Package/Evaluator identity、冻结 Evidence 和 Approval 不随品牌更名改写。本地源码目录名不影响 package/仓库身份，现有目录先保留以维持原始证据的绝对路径。

## 已验证的成功案例

[IPPI-FT Dilate3x3 C002](examples/ippi-dilate3x3-success-case/README.md) 已在 S5000C、CPU 0、NUMA node 0、threads 1 下取得两次 **19/19 correctness PASS**，首次 Formal 聚合加速 **4.6976×**，独立 Revalidation **4.5867×**。Candidate、Evidence 和 Approval Record 均为 **APPROVED**。

C001 由 Pi 生成，C002 repair 记录来自 Codex，后续复验、冻结和审批由操作脚本衔接。历史 Task/Workflow 保留 FAILED，尚未 merge/delivery。案例的输入范围、冻结版本、统计限制和原始证据获取方式见[证据索引](examples/ippi-dilate3x3-success-case/evidence-index.md)。

## 当前 Package 入口

```text
corepilot package list
corepilot package inspect ippi-ft 0.1.0
corepilot package init /path/to/new-library --target public_symbol
corepilot package init /path/to/new-library --target public_symbol --config phyopt.yaml
```

`public_symbol` 和源码路径为待接入项目的实际值。无 `--config` 时为确定性的离线调查；提供 `--config` 才调用 Pi。两种方式都只读源码，产物保持 Draft；当前不会执行 build/test probe，也不会生成可直接信任的 Formal oracle。完整说明见 [Onboarding](docs/guides/library-onboarding.md) 和 [Package Contract](docs/guides/library-packages.md)。

正式 Package 任务通过 `validation.library_package` 选择精确 package/version/target，build 从 Package 解析，使用 `runner.mode: rpc` 和已 Qualified 的 Evaluator；`validation.baseline_artifact` 在运行配置中绑定冻结 baseline 路径。Package 配置与外部 `build`、旧 `validation.testpack` 互斥。

启动形式仍是 `corepilot optimize --config phyopt.yaml --function <api> --performance`。这是新任务入口，不是重新执行本案例的指令。Onboarding、人工 review、baseline/build freeze、qualification、优化、证据冻结和审批的逐阶段入口与状态见[当前生命周期指南](docs/guides/optimization-workflow.md)。

## 兼容入口：手动 build / testpack 配置

以下保留非 Package 的 build/testpack 配置方式；它不包含当前正式 Package 执行要求的 RPC runner 配置，不能直接当作 IPPI Approved Result 的运行配置。在算法库 Git 仓库中准备 `phyopt.yaml`：

```yaml
model:
  model_id: kimi-k2.7-code
  api_key: "${PHYOPT_KIMI_API_KEY}"
  endpoint: https://api.moonshot.cn/v1
  timeout_ms: 1200000
target:
  ssh_alias: phytium-s5000c
  workspace_root: /tmp/phyopt
build:
  executable: ""
  args: []
  cwd: .
  environment: {}
  timeout_ms: 600000
validation:
  testpack: ./testpacks/sgemv-n.yaml
output_dir: ./.phyopt/runs
```

首次通过 `/model` 生成配置时，`build.executable` 为空，表示还没有选择基础库的构建命令。进入交互工作台后执行 `/build`，输入该仓库实际使用的完整构建命令；CorePilot 不会预填 `make`、硬件目标、并行度或线程参数。再次进入 `/build` 可以修改命令、执行目录以及高级设置。粘贴带反斜杠续行的 Shell 命令时会按原始行排版显示；按 Shift+Enter 在光标处换行，按 Enter 确认并解析保存，按 Esc 返回上一级。

目标机器也可以不依赖本机 SSH Alias，直接填写服务器地址和用户名；`port` 省略时默认 22，`workspace_root` 省略时默认 `/tmp/phyopt`：

```yaml
target:
  host: 10.31.31.65
  username: root
  port: 22
  # 可选：不填写时使用 SSH Agent 或 OpenSSH 默认密钥
  identity_file: C:/Users/<user>/.ssh/id_ed25519
  workspace_root: /tmp/phyopt
```

交互工作台输入 `/target` 可以从用户级目标列表切换，或选择“配置新的目标机器”填写上述地址/用户名；随后可以选择 SSH Agent/默认密钥，或指定已有私钥文件。高级用户也可以填写 SSH Alias。保存前会执行 SSH、远端架构和工作目录可写性检查。当前只支持 SSH key/agent 的免交互连接，密码不会写入 YAML 或目标列表；目标列表保存在 `~/.phyopt/targets.json`，`workspace_root` 回车默认 `/tmp/phyopt`。

API Key 可以直接填写，也可以使用完整的 `${ENV_VAR}` 引用。密钥不会进入 HTTP body、SQLite、日志、运行摘要或交付物。

`model` 配置只需要填写 OpenAI-compatible 基础地址和模型 ID，不再填写 Pi 的 `provider/name`：

```yaml
model:
  endpoint: https://example.com/v1
  model_id: example-code-model
  api_key: "${EXAMPLE_API_KEY}"
  timeout_ms: 1200000
```

选择 `GPT - OpenAI` 时，`/model` 会在模型选择后询问思考强度。也可以手动配置：

```yaml
model:
  endpoint: https://api.openai.com/v1
  model_id: <从 /models 返回的模型 ID>
  proxy: http://127.0.0.1:17891  # 可选；GPT 直连不可用时填写本机 HTTP/混合代理
  reasoning_effort: high
  timeout_ms: 1200000
```

`reasoning_effort` 可选值为 `minimal`、`low`、`medium`、`high`；省略表示不额外指定。

代理设置只在 `/model` 选择 `GPT - OpenAI` 时出现。首次可以选择输入代理或直连；代理成功连接 OpenAI Endpoint 后会按 endpoint 保存到用户级 `~/.phyopt/settings.json`。再次进入时可以直接复用已保存代理、输入新地址或切换为直连，新代理连接失败不会覆盖原记录。程序不会内置任何默认代理端口。也可以在 YAML 中写成 `${PHYOPT_OPENAI_PROXY}`，或使用 `PHYOPT_MODEL_PROXY` 临时覆盖。支持 `http://`、`https://` 和 `socks5://` 地址；混合 HTTP/SOCKS 端口应填写 `http://` 形式，例如 `http://127.0.0.1:17891`。代理只用于模型发现、Pi tool call 验证和 Agent 模型请求，不会改变后台、SSH 或构建命令的网络路径。

`model.api_key` 可以配置为直接 API Key 或 `${ENV_VAR}` 引用；如果省略，运行时会从用户级 `~/.phyopt/credentials.json` 按 endpoint 读取 `/model` 保存的 Key。交互工作台的 `/model` 会展示 DeepSeek、Qwen、GLM、Kimi、Doubao、MiMo、GPT - OpenAI 和自定义 OpenAI-compatible 来源；内置厂商的 Endpoint 由 CorePilot 预设，用户只需输入 API Key，模型列表统一通过 `<endpoint>/models` 动态获取，并在写入 YAML 前执行一次最小 tool-call 能力验证。API Key 不写入交互生成的项目 YAML，删除项目配置不会删除用户凭据。

启动优化有两种输入：

```powershell
corepilot optimize --config phyopt.yaml --function cblas_sgemv
corepilot optimize --config phyopt.yaml --function cblas_sgemv --file kernel/arm64/gemv_n.S
```

`--file` 只是 Agent 的优先调查入口，不是写入授权。算法库根目录从命令执行目录的 Git 根自动解析；Package 模式下的修改还受 `candidate_scope`、Hypothesis scope 和受保护路径约束。非 Package 兼容模式没有同一套 Package 白名单，不能据此扩大正式 Package 任务权限。性能循环只有在指定 `--performance` 时启用：

```powershell
corepilot optimize --config phyopt.yaml --function cblas_sgemv --performance
```

标准 public workflow 在验证和独立复验通过后会进入 `WAITING_APPROVAL`。查看与取消命令为：

```powershell
corepilot workflow status <workflow-id>
corepilot workflow cancel <workflow-id>
```

CLI 另有 `corepilot workflow approve <workflow-id> --commit-message <说明>`：该路径要求 Workflow 正在 WAITING_APPROVAL，检查基准分支后 merge Candidate，并清理创建的 worktree，状态进入 DELIVERABLE。它与 `OptimizationRuntime.approveCandidate` 记录冻结 Evidence / Owner Approval 的领域 API 是不同路径；不能用这个命令复现 C002 的 Approval Record。本轮案例审批没有 merge/delivery。

## Testpack

`validation.testpack` 是独立 YAML，固定 CPU/NUMA、正确性用例、性能矩阵、采样规则、当前库与对比库身份、性能阈值以及正式/独立复验命令。运行开始时 CorePilot 冻结 testpack 摘要和 SHA-256；模型不能修改这些验证口径。

仓库内保留 [SGEMV-N 兼容 testpack](testpacks/sgemv-n.yaml)。正式 RPC 路径使用独立、按 owner/id/version/digest 核验的 Evaluator assets；这些 assets 不属于 Candidate 的可写源码。Package 模式从 Package 和引用的 Evaluator inventories 映射出运行所需的 testpack，不能把历史示例中的用例数量或策略直接套到其他领域。

## CLI 与后台

```text
corepilot optimize --config <path> --function <name> [--file <entry-file>] [--performance] [--api-key <key>]
corepilot serve --db <path> [--host <host>] [--port <port>] [--ssh-alias <alias> | --ssh-host <host> --ssh-username <user> [--ssh-port <port>] [--ssh-identity-file <path>]]
corepilot backend start|status|stop --config <path>
corepilot workflow status|cancel|approve <workflow-id>
corepilot package list | corepilot package inspect <id> [version]
corepilot package init <repo-path> [--target <symbol>] [--config <phyopt.yaml>]
```

无参数运行 `corepilot` 会进入 Ink 交互工作台，支持 `/optimize`、`/workflow`、`/task`、`/model`、`/build`、`/target`、`/config` 和 `/exit`。通用 TaskHost、SQLite 任务/事件/lease、HTTP 健康检查、取消、恢复和 backend 生命周期仍保留；它们不再承载旧候选生成或授权门禁。

## 开发验证

```powershell
npm install
npm run --silent dev
npm run typecheck
npm run build
npm test
node scripts/package-cli.mjs
node scripts/verify-cli-install.mjs
git diff --check
```

`npm run --silent dev` 用于开发时启动交互界面，并隐藏 npm 自己输出的脚本名称；安装后的用户直接运行 `corepilot`，不会看到 npm 开发脚本提示。

生产优化不再使用 unified diff、`candidate_patch`、`patch_sha256`、`grant_ref`、ResourceGrant 或远端 `git apply`。候选身份由基准 commit、候选 tree、修改文件哈希和完整源码归档 SHA-256 表示。

文档入口见[文档索引](docs/README.md)。旧配置、补丁/多候选流程和外部 baseline 调查见[历史资料说明](docs/history/legacy-and-external-baselines.md)，不作为当前标准流程。
