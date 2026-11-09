# PhyOpt Agent 会话交接（2026-09-17）

本文用于在新会话继续 PhyOpt Agent 的候选生成架构改造。它记录当前代码事实、本会话已经确定的最终产品需求、尚未实施的工作和建议执行顺序。

## 一、接手时必须先知道的事情

1. 本会话只完成了代码审查、真实模型问题定位和方案确认，**尚未开始实现新的 Agent 工作树架构和最终 YAML 配置**。
2. 当前工作树有大量已有的未提交修改、删除文件和新增文件。不得执行 `git reset --hard`、`git clean`、批量还原或覆盖用户修改。
3. 开始开发前必须重新运行 `git status --short` 和 `git log -5 --oneline --decorate`，并查看最新的 `docs/dev-log` 编号。
4. 实施过程中必须持续在 `docs/dev-log` 写中文操作日志，不能等所有工作完成后一次性补写。
5. 根目录当前没有发现 `AGENTS.md`。
6. 关键新增代码使用中文注释；日志、错误、数据库、运行报告和交付物不得写入 API Key。

## 二、Git 与工作区状态

截至本交接文档创建前：

```text
HEAD: 164ac9d feat(cli): 统一命令规范并完善 YAML 配置
branch: main
remote tracking: gitcode/main 与 HEAD 相同
```

最近提交：

```text
164ac9d feat(cli): 统一命令规范并完善 YAML 配置
6941d14 feat(config): 完善可复现 YAML 配置与中文注释
050f8ee fix(workflow): bind candidate patches and evidence
5f9da7e feat(workflow): connect multi-candidate optimize entry
eab8664 feat(workflow): connect final revalidation and delivery loop
```

当前 dirty changes 涉及配置、CLI、候选生成、探索编排、工作流、测试和大量文档。主要修改文件包括：

```text
scripts/verify-cli-install.mjs
src/cli-interactive/commands.ts
src/client/candidate-generation.ts
src/config/config-resolution.ts
src/config/phyopt-config.ts
src/config/yaml-config.ts
src/contracts/exploration.ts
src/contracts/workflow.ts
src/core/task-host.ts
src/exploration/dual-exploration.ts
src/exploration/orchestrator.ts
src/exploration/task-host-exploration.ts
src/knowledge/seed-records.ts
src/workflow/dual-config.ts
src/workflow/optimization-workflow-service.ts
src/workflow/optimization-workflow.ts
tests/d13-dual-driver.test.ts
tests/d13-dual.test.ts
```

还有多项文档删除，以及以下未跟踪内容：

```text
docs/knowledge/
docs/plan/
docs/product/PhyOpt_Agent_PRD_v1.2.docx
phyopt-s5000c.grant.json
phyopt-s5000c.yaml
```

必须先审查这些变化的来源和意图，再在其上继续开发。`phyopt-s5000c.grant.json` 属于已经放弃的 ResourceGrant 方案；不要将它继续接入最终配置。

## 三、产品目标与本轮核心结论

PhyOpt Agent 面向国产芯片基础算法库优化团队。用户给出目标函数，或者同时给出一个入口文件，Agent 应像 Codex 一样在独立 Git 工作树中调查整个算法库、真实修改文件、构建、读取错误并反复修复，最后用确定的候选源码执行正确性、性能和独立复验。

最终公开命令语义：

```powershell
phyopt optimize --config phyopt.yaml --function cblas_sgemv

phyopt optimize --config phyopt.yaml `
  --function cblas_sgemv `
  --file kernel/arm64/gemv_n.S
```

- `--function` 是优化目标。
- `--file` 只是 Agent 调查代码时的入口提示，不限制读取范围，也不限制修改范围。
- 源码范围是当前算法库 Git 仓库的完整候选工作树。
- 算法库根目录默认从执行命令的位置向上寻找 Git 根目录。
- 原始算法库工作树保持不变，所有候选编辑发生在 PhyOpt 新建的 Git worktree 中。
- Agent 可以多轮搜索、读取、修改、构建、读取构建错误和正确性错误，然后继续修复。
- 模型最终交付的是已经真实修改的候选源码状态，不是 unified diff。

## 四、必须删除的补丁式候选语义

新实现不再使用以下概念和产物：

- 模型输出 unified diff；
- `patch`、`candidate.patch`、`candidate_patch`；
- `patch_sha256`；
- 远端 `git apply`；
- 构建脚本中的 `patch -p1`；
- 把补丁作为候选真实性或防篡改绑定的核心身份。

`git diff` 只作为用户和 Agent 查看工作树变化的工具，不保存为候选输入，也不用于远端重新应用。

候选身份改为：

- 基准 Git commit；
- 候选 Git tree SHA 或内部候选 commit；
- 修改文件清单及修改前后 SHA-256；
- 完整候选源码归档 SHA-256；
- 构建后二进制身份与运行时加载身份。

候选确定后，PhyOpt 将完整候选源码归档上传到目标机并直接构建。正式验证和独立复验分别从同一个候选 tree 创建全新的干净工作目录，两个阶段的 tree SHA 必须一致，避免构建残留污染结果。性能阶段后如果继续修改源码，应产生新的候选 ID 和新的 tree SHA。

## 五、当前代码的真实行为

当前实现还不是上述 Agent 模式：

1. 配置指定若干源码文件。
2. `src/client/candidate-generation.ts` 读取这些文件全文。
3. 一次性把源码、目标和知识证据拼入模型请求。
4. 要求模型返回“优化假说 + unified diff”的严格 JSON。
5. 校验补丁并持久化候选。
6. 后续远端流程应用补丁后构建。

因此当前模型：

- 看不到完整仓库目录；
- 不能主动搜索符号、头文件、宏和调用关系；
- 不能调用文件工具；
- 不能真实编辑候选工作树；
- 不能在构建失败后读取错误并继续修复。

当前项目依赖 `@earendil-works/pi-ai@0.85.1`，没有安装完整的 Pi Agent/Core。`src/model/pi-provider.ts` 只调用 `completeSimple()`，没有工具调用和 Agent Loop。原来的 `provider: kimi` 路径实际走自研 `OpenAICompatibleProvider`；只有 `provider: pi` 才进入 `PiModelProvider`。

`src/exploration/model-candidate-generator.ts` 已定义 `onCall`，但生产装配没有接入，所以候选生成失败的逐次原因没有完整持久化。当前代码还同时存在远端 `git apply` 和构建脚本 `patch -p1` 两种补丁应用路径，必须统一删除。

## 六、真实模型与真实机器的已知结果

本轮之前使用的真实目标机是：

```text
SSH alias: phytium-s5000c
CPU: 0-15
NUMA: 0
授权日期: 2026-09-17 全天
```

旧配置曾使用：

```yaml
model:
  provider: kimi
  name: kimi-k2.7-code
  credential_ref: PHYOPT_KIMI_API_KEY
  timeout_ms: 1200000
```

真实 Kimi 小请求成功；包含长源码的一次性候选请求返回 `fetch failed`，尚未进入 JSON 或补丁校验阶段。工作流：

```text
workflow:f2356122-a5f4-449b-b05d-9e96efa64773
结果: NO_QUALIFIED_CANDIDATE
模型生成额度: 3/3
可用候选: 0
```

这不能解释为“Kimi 不支持代码项目”。根因是当前实现只有一次长请求，缺少仓库工具、上下文按需读取、流式调用、多轮编辑和失败恢复。

## 七、最终用户 YAML 配置

用户已经明确：公开 YAML **只保留以下字段**，不要再加入 `schema_version`、`project_root`、`backend`、`grant`、`grant_file`、`agent`、`budget`、`source` 或其他用户字段。

```yaml
model:
  provider: moonshotai-cn
  name: kimi-k2.7-code

  # 允许用户直接填写，也允许交互界面写入。
  api_key: ""

  # Pi 使用 API 基础地址，不包含 /chat/completions。
  endpoint: https://api.moonshot.cn/v1
  timeout_ms: 1200000

target:
  ssh_alias: phytium-s5000c

  # 远端候选源码、构建产物和测试结果的临时目录。
  workspace_root: /tmp/phyopt

build:
  executable: make
  args:
    - -j16
    - NO_LAPACK=1
    - TARGET=FT2000
    - USE_OPENMP=1
    - NUM_THREADS=32
  cwd: .
  environment: {}
  timeout_ms: 600000

validation:
  # CPU 绑定、NUMA 节点、测试线程数和矩阵规模等由 testpack 定义并记录。
  testpack: ./testpacks/sgemv-n.yaml

output_dir: ./.phyopt/runs
```

注意：用户最终给出的 `build.args` 不包含 `shared`，实现和测试应以这份最终配置为准，不要从旧配置擅自补回。

### API Key 的两种写法

直接填写：

```yaml
model:
  api_key: "sk-xxxxxxxx"
```

引用用户电脑上的环境变量：

```yaml
model:
  api_key: "${PHYOPT_KIMI_API_KEY}"
```

要求：

- `${变量名}` 只有在整个字段值完全符合该形式时才做环境变量解析，避免隐式字符串插值。
- 环境变量不存在或为空时，在模型调用前明确失败。
- 交互界面提供“直接输入”和“使用环境变量”两种选择。
- 直接输入时将实际 Key 写入 YAML；选择环境变量时写入 `${变量名}`。
- 配置显示、状态、错误、日志、SQLite、运行清单和交付物中必须脱敏。
- 既有总优先级仍为 CLI > 环境变量 > YAML > 默认值；通用环境覆盖可以使用 `PHYOPT_MODEL_API_KEY`。

### 路径和运行参数语义

- 算法库根目录从调用目录自动解析 Git 根目录。
- `build.cwd` 相对于候选工作树根目录解析。
- `validation.testpack` 和 `output_dir` 相对于 YAML 文件所在目录解析。
- `target.workspace_root` 是远端绝对路径。
- 本地服务端口不属于优化 YAML，通过 `phyopt serve --port 7346` 等启动参数指定。
- 每次运行自动生成不含密钥的运行清单，记录 PhyOpt 版本、最终有效配置、Git 基准、候选 tree、testpack 摘要和远端机器实测身份。

## 八、ResourceGrant 的最终决定

用户已经决定删除 ResourceGrant。原因是当前单用户 CLI 中，用户主动执行命令并拥有 SSH 权限已经表达运行意图；用户可编辑的 YAML 自我声明授权不构成真实安全边界。

实现时应删除当前工作流中的：

- `grant_file` 和 `grant_ref` 用户配置；
- `target.grant`；
- ResourceGrant 有效期检查；
- `allowed_stages` 阶段门禁；
- 仅服务于 ResourceGrant 的 CLI、交互界面、文档和测试；
- 当前未跟踪的 `phyopt-s5000c.grant.json`，但删除前仍应确认它没有被其他未提交改动引用。

CPU 绑定、NUMA 节点、测试线程数、矩阵规模、采样和性能阈值均由 `validation.testpack` 定义。远端实际权限由 SSH、操作系统权限或未来接入的调度系统负责。PhyOpt 仍需执行目标机身份核对、工作目录限制、进程停止确认和完整审计。

## 九、Pi/Kimi 的确定映射

本机安装的 Pi 模型目录已经确认：

```text
provider id: moonshotai-cn
model id: kimi-k2.7-code
base URL: https://api.moonshot.cn/v1
context window: 262144
API: openai-completions
supportsStrictMode: false
```

来源：

```text
node_modules/@earendil-works/pi-ai/dist/providers/data/moonshotai-cn.json
node_modules/@earendil-works/pi-ai/dist/providers/moonshotai-cn.js
```

不要把 YAML 中的 `provider` 保存为抽象的 `pi` 或旧的 `kimi`。`moonshotai-cn` 是 Pi 的真实 provider ID，`kimi-k2.7-code` 是真实 model ID。交互界面可以显示友好的“Kimi”标签。

新 Agent 运行层应使用 Pi 的流式模型接口和 `toolCall`/`toolResult` 循环。标准 endpoint 来自 YAML；需要把它作为模型 base URL 覆盖传给 Pi，不能继续把它按旧自研 HTTP provider 的完整 `/chat/completions` 地址解释。

## 十、Agent 工作树和工具规划

建议建立 `CandidateWorkspace` 作为候选源码唯一写入边界：

1. 从冻结的基准 commit 创建编辑 worktree。
2. 所有路径先规范化，再确认仍位于候选工作树内。
3. 禁止写入 `.git`、PhyOpt 状态目录、凭据文件和工作树之外的路径。
4. 记录真实修改文件及修改前后哈希。
5. 候选定稿后生成 tree SHA 或内部 commit，并打包完整候选源码。

第一阶段只读工具：

```text
list_tree
search_code
find_symbol
find_references
read_file
read_build_context
read_target_profile
read_performance_evidence
```

真实文件修改工具：

```text
replace_text
write_file
create_file
delete_file
move_file
revert_file
git_status
show_diff
```

受控验证工具：

```text
run_build
run_correctness
read_build_error
read_correctness_failure
finalize_candidate
```

第一阶段不要向模型开放任意 shell。模型负责调查和编辑；PhyOpt 负责路径权限、工作树、构建、测试、远端测量、复验和证据链。正式测试程序、基线和性能阈值不能由模型修改。

## 十一、testpack 是下一阶段必须补齐的配置

最终 YAML 只引用：

```yaml
validation:
  testpack: ./testpacks/sgemv-n.yaml
```

当前仓库尚没有与该最终路径和格式对应的正式 YAML 文件，旧的测试信息散落在现有大配置、代码和文档中。下一会话需要先定义一个清晰的 testpack YAML 契约，至少容纳：

- CPU set 与 NUMA node；
- 正确性测试命令、用例和通过标准；
- 性能测试命令、矩阵规模、线程数；
- 采样次数、交错顺序、随机种子；
- 当前版本基线与对比库基线的身份；
- 加权规则、关键用例和置信区间阈值；
- 正式验证与独立复验要求；
- 各阶段超时。

testpack 应可单独校验和摘要，运行开始后冻结内容及 SHA-256。用户主配置保持简洁，测试细节不再硬编码于 `dual-exploration.ts`。

## 十二、建议实施顺序

### 阶段 1：建立日志和保护现有工作树

1. 重新检查 Git 状态和最近提交。
2. 阅读与本改造直接相关的 dirty diff，区分已有工作与待替换旧实现。
3. 新建当天后续编号的 `docs/dev-log/2026-09-17-XX-*.md`，记录改造起点、基准 commit、dirty 状态和明确不覆盖原则。

### 阶段 2：落地最终 YAML 契约

1. 精简 `PhyOptConfig`、YAML 模板、解析和校验，只公开用户最终确认的字段。
2. 删除公开 `schema_version`、`backend`、`project_root`、ResourceGrant 等旧字段。
3. 实现 `api_key` 直接值与完整 `${ENV_VAR}` 引用。
4. 所有显示和错误路径做凭据脱敏。
5. 更新交互式配置向导，完成后仍提示：

   ```text
   ✅ 配置已生成: <配置文件>.yaml
   你可以手动编辑此文件
   ```

6. 服务 host/port/db 等改为启动参数或内部运行设置，不再混入优化 YAML。

### 阶段 3：定义并实现 testpack YAML

1. 从当前 S5000C/SGEMV 实验配置提取真实测试、资源、基线和阈值。
2. 创建 `testpacks/sgemv-n.yaml` 示例和解析器。
3. 在模型调用或远端操作之前完成严格校验。
4. 冻结 testpack 摘要与哈希并写入运行清单。

### 阶段 4：实现 CandidateWorkspace 和无补丁候选模型

1. 新建候选 worktree 管理器。
2. 定义基准 commit、tree SHA、修改文件哈希和源码归档身份。
3. 改造候选、实验上下文、SQLite 和审计事件。
4. 为已有 SQLite 数据提供明确迁移或新表策略；用户 YAML 不使用 `schema_version` 不等于数据库不需要迁移。

### 阶段 5：实现 Pi 工具调用 Agent Loop

1. 用 `moonshotai-cn/kimi-k2.7-code` 创建流式会话。
2. 接入只读工具、编辑工具和受控验证工具。
3. 持久化每轮模型调用、工具调用、失败原因、token/耗时等非秘密元数据。
4. 让构建错误和正确性错误进入下一轮修复上下文。
5. 加入总轮次、工具调用和耗时保护；这些可以是产品内部默认值，不加入用户最终 YAML。

### 阶段 6：替换远端补丁流程

1. 生成完整候选源码归档并计算 SHA-256。
2. 上传到 `target.workspace_root` 下的隔离目录。
3. 校验归档、解压并直接构建。
4. 删除 `git apply`、`patch -p1` 和相关产物。
5. 正式验证与独立复验分别使用新的干净目录和相同 tree SHA。

### 阶段 7：工作流、恢复和用户可见状态

1. 让生产路径真正驱动统一状态机，不再长期停留在 `GENERATING`。
2. 展示当前 Agent 轮次、当前工具、候选编号、构建/测试阶段和剩余预算。
3. 接通每次模型失败原因的持久化。
4. 处理恢复、取消和 `RECOVERING` 任务的周期 reconcile、TTL 与再取消入口。
5. 删除旧双轨编排和重复预算/复验逻辑。

### 阶段 8：验证与真实验收

每个阶段先运行针对性测试，再运行：

```powershell
npm run typecheck
npm test
npm run build
git diff --check
```

最后使用真实 Kimi 和 `phytium-s5000c` 完成：

1. 仅给 `--function cblas_sgemv` 的完整仓库调查与编辑。
2. 同时给 `--file kernel/arm64/gemv_n.S` 的入口提示模式。
3. 远端构建。
4. 正确性测试。
5. 性能测试。
6. 独立复验。
7. 候选源码、tree SHA、归档 SHA、二进制身份和结果交付。

真实模型与真实 ARM 没有全部跑通之前，文档只能标记为本地验证或部分真实验证，不能声称端到端完成。

## 十三、验收标准

完成本次改造至少应满足：

- 用户最终 YAML 能由 CLI 初始化、编辑、校验、加载和脱敏显示。
- `api_key` 直接值和 `${ENV_VAR}` 两种方式都可用。
- 不填写项目目录也能从当前 Git 仓库启动。
- `--file` 不限制 Agent 的仓库读取和修改范围。
- 原始算法库工作树始终不被修改。
- Agent 在候选工作树中能搜索完整仓库并真实编辑多个相关文件。
- Agent 能根据构建或正确性错误继续修复。
- 候选和远端执行链路不再依赖补丁。
- testpack 完整定义 CPU/NUMA、正确性、性能、基线和复验。
- 正式验证与复验使用相同候选 tree 的独立干净目录。
- 模型、工具、构建、测试和恢复失败原因可查询。
- 所有报告和日志不泄露 API Key。
- 在真实 Kimi 与真实 S5000C 上完成至少一个候选的完整闭环。

## 十四、不要沿用的旧结论

旧的 `docs/handoffs/session-handoff-9-16.md`、旧配置指南和部分 dev-log 仍描述以下已经被用户否决的设计：

- 用户配置包含 `schema_version`；
- 凭据只能通过 `credential_ref`；
- `project_root` 必填；
- backend host/port/db 位于优化 YAML；
- ResourceGrant 是远端运行门禁；
- 模型输出候选补丁；
- 候选通过 patch SHA 绑定。

实现和文档更新必须以本文记录的 2026-09-17 最终决定为准。历史记录可以保留其历史语境，但当前 README、配置指南、CLI 帮助、模板和产品文档不能继续把旧设计描述为现状。

