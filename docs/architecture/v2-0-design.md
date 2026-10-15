# V2-0 现状核查与实施设计

> 历史设计：以下现状与建议属于原文指定提交和阶段，不作为当前产品能力、CLI 或状态机的依据。当前入口见[产品文档索引](../README.md)与[生命周期指南](../guides/optimization-workflow.md)。

> 阶段：V2-0（只做文档与设计，不改执行器 / 统计规则 / 冻结测试）
> 需求基线：`docs/product/prd-v0.3.md`
> 核查基线提交：`ce9b355`（工作树另有用户未提交改动，见文末"工作树状态"）
> 原则：结论以代码为依据，不以历史报告代替。

## 一、现状代码地图（可复用资产）

| 领域 | 现有实现 | 说明 |
| --- | --- | --- |
| CLI 入口 | `src/cli.ts`：`main()` 同步分发 + `runCli()` 异步分发；`HELP` 文本 | 全部为一次性命令，无交互态 |
| 任务宿主 | `src/core/task-host.ts`：`TaskHost`（lease、调度循环、`recover()`、`cancel/retry/resume`、`createExperimentTask`） | 后台核心，可直接复用 |
| 本地服务 | `src/core/task-service.ts`：`TaskService` | 本地（无 HTTP）任务服务 |
| HTTP 服务 | `src/http/server.ts`：`createHttpServer`（`/v1/health`、`/v1/tasks`、`/events`、`/report`、`/cancel|retry|resume`） | 健康体版本硬编码 `'0.1.0'` |
| 客户端 | `src/client/api-client.ts`：`ApiClient`（health/createTask/getTask/listTasks/getReportPath/getEvents/cancel/retry/resume）；`src/client/ide-task-client.ts`：`IdeTaskClient` | IDE 与 CLI 共用同一后端 |
| 配置-数据 | `src/config.ts`：`resolveConfig()`（仅 db 路径：`--db` / `PHYOPT_DB_PATH` / `~/.phyopt/phyopt.sqlite`） | 无模型 / 硬件 / 预算配置 |
| 配置-项目 | `src/config/project-config-loader.ts` + `src/contracts/project-config.ts`：`ProjectConfig`（project / optimization_target / build / target / baseline） | 单文件 `phyopt.project.json`，结构校验 + 路径包含 |
| 实验上下文 | `src/contracts/experiment-context.ts`：`ExperimentContext` + `validateExperimentContext` + `computeContextDigest` | 版本化、含 grant、防凭据、绑定摘要 |
| 持久化 | `src/storage/task-store.ts`（接口）+ `src/storage/sqlite-task-store.ts`（`user_version=7`，`experiment_contexts` 表） | core 只依赖接口 |
| 模型适配 | `src/model/provider.ts` + `openai-compatible-provider.ts`（`PHYOPT_MODEL_*`）+ `pi-provider.ts`（`PHYOPT_PI_*`）+ `mock-provider.ts` | 凭据走环境变量 |
| 真实执行 | `src/experiment/*`（`remote-executor.ts`、`remote-transport.ts`、`grant-gate.ts`）、`src/runner/experiment-runner.ts` | SSH 传输；`serve --runner experiment --transport ssh` 接通 |
| 统计/结果 | `src/statistics/engine.ts`、`report.ts`、`src/selection/*`、`src/delivery/package.ts` | 加速比 / CI / 判定 / 打包已存在 |
| IDE 扩展 | `extensions/vscode/src/extension.ts`：5 命令 + Task TreeView；`package.json` 配置 `phyopt.serverUrl` / `phyopt.target` | 仅能发起 Mock（`scenario:'success'`） |
| 验证资产 | `tests/*.test.ts`（`cli-server`、`cli-exit`、`d18`、`d16`、`task-host`、`http-server` 等）；`extensions/vscode/test/*` EDP 冒烟；`scripts/verify-*` | 复用为回归基线 |

## 二、需求覆盖矩阵（PRD 逐项）

状态图例：**已有**＝可直接复用；**部分**＝有基础但需扩展；**缺**＝本版需新建。

### 2.1 共用配置（PRD §2）

| 需求 | 现有实现 | 可复用模块 | 实际缺口 | 需扩展接口 | 验证方式 |
| --- | --- | --- | --- | --- | --- |
| CLI/IDE 共用配置：项目/模型/凭据引用/硬件/测试资产/基线/预算/输出 | 分散：`ProjectConfig`（项目/构建/硬件档案/基线）、env（模型）、SQLite（context）、`resolveConfig`（db） | `project-config-loader`、`provider`、`SqliteTaskStore` | **缺统一配置服务与"当前上下文"**；无当前任务/候选指针 | 新增 `PhyOptConfig` schema + `ConfigService`（load/save/patch/validate/resolve） | 新 `tests/v2-config.test.ts`：读写、未知字段拒绝、凭据不入文件 |
| 界面把普通配置转换为既有后台契约（用户不写 `ExperimentContext` JSON） | 仅 CLI `context import --file`（手工 JSON） | `validateExperimentContext`、`ExperimentRunner` | **缺配置→context 装配器** | 新增 `ContextAssembler`（配置→`ExperimentContext`） | 单测：给定配置产出合法 context 且通过 `validateExperimentContext` |
| 切换模型/硬件/预算只影响后续任务，已提交任务保留冻结配置 | `ExperimentContext` 入队后 digest 绑定（`task.context_digest`）；篡改→FAILED | `computeContextDigest` | 已有机制，需在 UI 明示 | 无（展示层） | `tests/d18.test.ts`（篡改拒绝）已有 |
| 多任务/多候选须明确目标，不反复搬 `task_id` | 无当前指针 | — | **缺 current task/candidate 指针与选择器** | 配置新增 `current` 段 | 交互测试：`/tasks` 切换后命令作用于当前任务 |

### 2.2 模式与权限（PRD §2.3）

| 需求 | 现有实现 | 缺口 | 验证方式 |
| --- | --- | --- | --- |
| Mock/真实持续可见、不静默切换 | `serve --runner` 启动时定死；`task.is_mock` 落库 | UI 未持续展示 | IDE/CLI 展示层断言 |
| 展示授权范围与有效期，缺失/失效/范围变化才再确认 | `ResourceGrant`（`valid_from/until`、`allowed_stages`）+ `grant-gate.ts` | 无授权状态查询接口 | 新增 `GET` 授权状态；`tests/resource-wait.test.ts` 已有基础 |
| 展示实际外发文件、可修改范围、预算 | `experiment_context.plan.allowed_files`；`file-scope.ts` | 无聚合展示 | 启动摘要单测 |
| 凭据不写入项目文件/日志/报告 | `validateExperimentContext` 的 `FORBIDDEN_KEYS`；env 传入 | 需在配置服务与日志中同样保证 | 配置服务单测 + 日志脱敏断言 |

### 2.3 关键状态语义（PRD §2.4）

| 需求 | 现有实现 | 缺口 | 验证方式 |
| --- | --- | --- | --- |
| COMPLETED/REJECTED/INCONCLUSIVE/WAITING_FOR_RESOURCES/CANCEL_REQUESTED/FAILED 的展示与含义 | `TaskStatus` 状态机 + `task.error` + events | **REJECTED/INCONCLUSIVE 语义在任务层缺失**（现有判定在 `selection`/`statistics` 结论里） | 结果读取接口映射；UI 文案断言 |
| Mock 无报告明确说明，不把夹具报告当默认能力 | `task.report_path` 为 null；`task.is_mock` | UI 未区分 | UI 断言 Mock vs 真实无报告 |

### 2.4 CLI 交互工作台（PRD §3）

| 需求 | 现有实现 | 缺口 | 需扩展接口 | 验证方式 |
| --- | --- | --- | --- | --- |
| 输入 `phyopt` 进入工作台 + ASCII Logo + 首页 | 无参数 → 打印 HELP 并返回 1 | **缺交互入口与首页** | 新增交互 REPL 模块；`runCli` 在 TTY 且无参时进入 | 注入式 IO 测试：首页字段、无虚构记录 |
| 非交互命令兼容、非 TTY 不强制全屏 | `main()`/`runCli()` 已稳定 | 需保证不回归 | 保持 | 现有 `cli-exit`/`cli-server` 回归 |
| `/model /target /optimize /test /benchmark /diff /export /status /tasks /cancel /config /exit` | 无斜杠命令 | **全部缺失** | 新增命令注册表（名称/说明/示例/补全/参数提示） | 逐命令注入式测试 |
| 输入体验：`/` 弹列表、方向键、Tab 补全、历史、参数补齐、执行期输入可用、日志不覆盖输入 | 无 | **缺失** | readline `completer` + 历史 + 非阻塞日志输出 | 注入式 IO 测试 + 终端手工验收 |
| 候选不唯一时选择器 | 无 | **缺失**（无候选读取） | 结果读取接口 + 选择器 | 交互测试 |

### 2.5 IDE 工作台（PRD §4）

| 需求 | 现有实现 | 缺口 | 需扩展接口 | 验证方式 |
| --- | --- | --- | --- | --- |
| 首页/新建任务/任务详情三主页面 + 配置页 | 仅 ActivityBar Task TreeView | **全部缺失** | Webview 页面 + 消息桥 | EDP 冒烟：页面可打开、按钮可点 |
| 三入口：文件右键、选区右键、工作台新建 | 仅命令面板 `initTask`（取 active file） | 缺右键菜单、缺选区、缺工作台 | `package.json` menus（`explorer/context`、`editor/context`）；选区读取 | EDP：菜单存在 + 带入文件/选区 |
| 未保存编辑"保存并继续"，不静默保存 | `assertNoUnsavedEdits` 直接拒绝 | 缺"保存并继续"分支 | 交互流程 | EDP 测试 |
| 新建任务配置区（对象/目标/模型/硬件/测试资产/基线/预算/摘要） | 仅 `phyopt.target` 一个设置项 | **全部缺失** | 配置服务 + Webview 表单 | EDP：缺失项列出原因、开始按钮禁用逻辑 |
| **IDE 真实任务接通完整上下文提交** | 仅 Mock（`scenario:'success'`） | **核心缺口** | `POST /v1/contexts`（导入）+ `POST /v1/tasks {context_id}`（experiment 模式）；客户端装配器 | EDP + `tests/v2-ide-submit`：提交 experiment task 且 is_mock=false，无 grant→WAITING |
| 任务详情：阶段/候选/耗时/预算/等待原因/失败摘要/日志/Diff/取消 | 仅 Task TreeView 状态 | **全部缺失** | 结果读取接口（阶段/候选/事件/日志） | EDP：详情数据绑定 |
| 结果页：原生 Diff、正确性通过数/失败用例、加速比图、逐用例表、基线、CI、判定、双轮分开 | 后端有 `statistics`/`selection`/`report`，无读取接口 | **缺读取接口与 UI** | 新增结果读取接口；`vscode.diff`；内联 SVG 图 | EDP：Diff/图表/表可渲染 |
| 导出报告/图表/补丁/复现材料 | `src/delivery/package.ts` 已能打包 | **缺导出入口** | `POST /v1/tasks/:id/export` | EDP：导出产物存在且绑定 task/candidate |
| 不伪造百分比/剩余时间；无数据显示具体原因；不自动应用补丁 | 无 | 需按约束实现 | — | UI 断言 |

### 2.6 后台生命周期与异常（PRD §5）

| 需求 | 现有实现 | 缺口 | 需扩展接口 | 验证方式 |
| --- | --- | --- | --- | --- |
| 单终端：连接兼容后台，未发现则自动启动受管 TaskHost | 必须手工 `serve` | **核心缺口** | 新增 `BackendManager`（探测/拉起/复用/停止） | `tests/backend-manager.test.ts`：复用、拉起、端口占用不误杀 |
| 两端复用同一后台，不争抢同一数据库 | `TaskHost` lease（第二实例 `LEASE_HELD`） | 需在管理器中"先连后拉" | 复用探测 | 测试：并发 ensure 只起一个 |
| 协议兼容性检查，不兼容明确提示 | 无 | **缺 api_version** | `/v1/health` 扩展信封 | 测试：版本不匹配报错 |
| 端口占用先识别服务，不终止未知进程 | 无 | **缺失** | 探测响应形状判定 | 测试：非 phyopt 服务占用→报错不杀 |
| 启动失败给原因与诊断，不回落 Mock | 无 | **缺失** | 子进程 stderr 采集 | 测试：失败返回 stderr 摘要 |
| 退出≠取消；在途任务提示；重开恢复不重复提交；停止未确认不显示完成 | `TaskHost.stop()` 将 RUNNING→CANCEL_REQUESTED；`recover()` 核对远程 | 需 UI 流程 | 生命周期命令 | `task-host`/`recovery` 测试已有；UI 断言 |
| 可操作错误（阶段/原因/诊断/下一步） | `task.error` 字符串 | **缺结构化错误** | 错误模型 + 映射 | 错误矩阵测试 |
| 数据连续性：CLI/IDE 同一任务一致；配置重开不覆盖历史证据 | 单一后端 + 冻结 digest | 需 UI 绑定 task/candidate | — | 互查测试 |

### 2.7 端到端验收（PRD §6.1）

| 编号 | 现有可达性 | V2 阶段 |
| --- | --- | --- |
| CLI-01 单终端全流程 | 部分（需手工 serve、无交互） | V2-1 + V2-2 |
| CLI-02 斜杠命令可发现可补全，非交互兼容 | 缺 | V2-2 |
| IDE-01 右键配置并提交，无需终端 | 缺 | V2-1 + V2-3 |
| IDE-02 阶段/候选/Diff/日志/图表/导出 | 缺 | V2-4 |
| SHARED-01 互查/恢复/不重复执行 | 后端已有基础 | V2-1 + V2-3 |
| SHARED-02 默认配置变化不改在途；凭据不泄漏 | 部分 | V2-1 |
| ERROR-01 各类明确的错误提示 | 缺 | V2-4 |
| REAL-01 有效授权下界面发起真实任务 | 缺（IDE 仅 Mock） | V2-3 + V2-5（需授权） |

## 三、关键技术决策

### 3.1 CLI 交互技术方案

- **形态**：`phyopt`（无参、TTY）进入全屏工作台（ink），显示标题 + ASCII Logo + 首页；底部输入行，`/` 弹命令列表，方向键选择、Tab 补全、历史、参数追问；执行期输入区保持可用。非 TTY / CI 保持现状（打印 HELP 退出），满足"非交互环境不强制全屏"。
- **实现**：`ink`（v7，MIT）+ `react`（v19）渲染；业务逻辑（命令注册表、上下文、后端调用、配置读写、凭据解析）全部为纯 TS 模块，ink 组件只做薄呈现，便于测试与复用。
  - 命令注册表：`src/cli-interactive/registry.ts` 统一 `name/description/examples/args`，`/` 菜单与补全同源（"可发现"）。
  - 输入体验：ink 组件内实现 `/` 列表、Tab 补全、历史、候选选择器。
  - 懒加载：`src/cli.ts` 仅在进入交互态时 `import()` 交互模块，非交互命令不加载 React，保持启动速度。
- **依赖核查**：`ink@7.1.1`（MIT，engines node>=22，满足本仓库 node>=22.19.0）；peer `react@>=19.2`、`@types/react@>=19.2`。仅 CLI 路径引入，IDE 扩展（esbuild 打包 `extensions/vscode/src/extension.ts`）不 import 交互模块，故不会把 ink 打进 VSIX。

### 3.2 VS Code 页面方案

- **页面**：三个 `WebviewPanel`（首页 / 新建优化任务 / 任务详情）+ 一个配置页（可复用模型/硬件档案）。HTML/CSS/JS 置于 `extensions/vscode/media/`，通过 CSP nonce + `postMessage` 与扩展通信；主题变量用 VS Code CSS 变量（`--vscode-*`）适配明暗。
- **入口**：`package.json` `menus` 增加 `explorer/context`（文件右键）与 `editor/context`（选区右键，`when: editorHasSelection`）；工作台首页"新建优化任务"按钮。
- **Diff**：使用原生 `vscode.diff`（`工作区:候选` vs 冻结起点），满足"使用 VS Code 原生 Diff"。
- **图表**：加速比/CI 图以内联 SVG 渲染（不引图表库）。
- **选区/外发范围**：新建任务页展示"选区 = 关注范围"与"实际读取文件"，读取完整文件前需用户确认。
- **真实提交**：不新增"仅 UI"路径；由共享 `ContextAssembler`（后端模块）把配置装配成 `ExperimentContext`，经 `POST /v1/contexts` 导入并 `POST /v1/tasks{context_id}` 提交，`is_mock=false`，与 CLI 同链路。
- **依赖**：零新增运行时依赖（Webview/CSP/SVG/`vscode.diff` 均为内建）。

### 3.3 共用配置与后台生命周期设计

**配置服务**（新增 `src/config/`）：

- `PhyOptConfig`（`schema_version`）字段：`project`、`model`（provider/name/**credential_ref**）、`targets[]`（硬件档案 + `ssh_alias` 引用）、`test_assets`、`baseline`、`budget`、`output_dir`、`current`（`task_id`/`candidate_id`）、`backend`（host/port/db/runner/transport）。
- 存储：`~/.phyopt/config.json`（`PHYOPT_CONFIG_PATH` 可覆盖）；按项目可加 `project` 段（键为 workspace/项目路径）做覆盖。
- **凭据只存引用**（环境变量名 / VS Code SecretStorage 键名），永不落盘明文；`ConfigService` 与日志共用脱敏。
- `ConfigService`（Node 模块）被 CLI 与扩展共同 `import`（扩展已直接引用 `src/`）。

**后台管理器**（新增 `src/backend/backend-manager.ts`）：

1. `ensureBackend()`：`GET /v1/health` → 200 且 `service==='phyopt'` 且 `api_version` 兼容 → **复用**。
2. 连接被拒 → 以配置派生参数**拉起** `phyopt serve`（detached，`--host/--port/--db/--runner/--transport/--ssh-alias`），轮询 health 至就绪或超时。
3. 端口被非 phyopt 服务占用（health 形状不符）→ **报错并给出诊断，不终止未知进程**。
4. `api_version` 不兼容 → 明确报错（本地版本 vs 期望）。
5. 拉起失败 → 返回 `stderr` 摘要 + 诊断入口，**不回落 Mock**。
6. 受管状态 `~/.phyopt/backend.json`（pid/port/db/owner/version）供两端复用与陈旧检测；停止仅在确认为本工具受管时执行。

**接口扩展**（向后兼容）：

- `/v1/health` 返回 `{ service:'phyopt', api_version, version, runner, experiment, capabilities[] }`（现仅 `{status,mock,version}` → 扩展为超集）。
- 新增 `POST /v1/contexts`（导入装配后的 context，等价 `context import`）与 `GET /v1/contexts/:id`。
- 新增结果读取：`GET /v1/tasks/:id/stages`、`/candidates`、`/log`、`/diff`、`/results`、`/export`（在 V2-3/V2-4 落地）。

### 3.4 依赖核查（维护状态 / 兼容性 / 许可证）

| 候选 | 用途 | 结论 |
| --- | --- | --- |
| `node:readline`（内建） | CLI 工作台 | 采用：零依赖，随 Node 24，无许可证问题 |
| `ink` / `@inquirer/prompts` | 全屏 TUI / 表单 | 暂不采用（引入 React/额外依赖）；如需提高保真再评估（Q1） |
| VS Code Webview / `vscode.diff`（内建） | IDE 页面与 Diff | 采用：随 VS Code API，无新增依赖 |
| 内联 SVG | 图表 | 采用：零依赖 |
| `@earendil-works/pi-ai@0.85.1` | 模型适配 | 已在用，本阶段不变更 |

## 四、CLI 交互结构

**启动屏布局（滚动区，自上而下）**

```
  PhyOpt Agent                         (标题 + 芯片/齿轮 ASCII Logo)
  ──────────────────────────────────
  Tips:    /optimize 提交优化，输入 / 查看命令
  Recent:  <最近任务状态 + 性能判定 +（仅有效数据时）加速比>
  Target:  <硬件档案 | 未选择>     Mode:  <Mock | 真实>
  Model:   <provider/name | 未选择>  Backend: <已连接 host:port | 已启动 | 未连接>
  Path:    <项目路径>               Language: <语言>
  ──────────────────────────────────
  phyopt>
```

首次无任务时 `Recent` 显示"开始入口"，不填充虚构记录；未知项显示"未选择"。

**命令（§3.2）** 由 `registry` 提供 `name/description/examples/args`；输入 `/` 查看命令及说明。

**输入体验**：`/` 列候选 + Tab 补全；方向键历史；参数缺失逐项追问；执行期输入区可用、日志滚动不覆盖输入；多候选弹选择器。

**退出/恢复**：`/exit` 时若有在途任务，询问"退出并继续运行 / 取消后退出"；重开时 `GET /v1/tasks` 恢复当前任务与阶段，不重复提交。

## 五、IDE 页面结构

**首页**：模式徽标（Mock/真实）、Backend 状态、当前任务卡片（阶段/状态/取消/查看详情）、"新建优化任务"按钮、最近任务列表、待修正配置（卡片式，点击进入修正）。

**新建优化任务**：配置区分组（优化对象 / 优化目标 / 模型 / 硬件 / 测试资产 / 比较基线 / 预算）+ 启动摘要（模式、外发范围、修改范围、执行范围）。缺失项集中列出并提供修正入口；"开始优化"不可用时禁用并显示原因。

**任务详情**：阶段进度条（分析→候选生成→构建→正确性→性能→汇总）、候选卡片（状态/修改说明/结果）、耗时/已用预算/等待原因/失败摘要、按钮：查看日志、查看 Diff（原生）、取消、导出。

**结果页（详情内）**：正确性通过数 + 失败用例表；加速比图（SVG）+ 逐用例表 + 基线身份 + CI + 判定；双轮（vs OpenBLAS / vs current）分开；导出按钮（报告/图表/补丁/复现材料）。无数据显示"未运行 / 执行失败 / 样本不足 + 原因"，不伪造百分比。

**首次使用**：确认项目 → 配置模型 → 配置硬件 → 选测试资产与基线 → 提交；允许跳过浏览；启动前集中列出缺失项。模型连接验证由用户点击触发，提示可能产生费用、不发送源码。

**退出/恢复**：关闭窗口≠取消；重开从后台恢复并核对在途执行；停止未确认不显示"已取消"。

## 六、分阶段任务清单（V2-1 ~ V2-5）

| 阶段 | 文件范围（新增/修改） | 依赖 | 验收标准 |
| --- | --- | --- | --- |
| **V2-1 共用配置与自动后台** | 新增 `src/config/phyopt-config.ts`、`src/config/config-service.ts`、`src/backend/backend-manager.ts`、`src/backend/health.ts`；修改 `src/http/server.ts`（health 信封）、`src/cli.ts`（server 命令先 ensureBackend；`serve` 输出兼容信息）；测试 `tests/v2-config.test.ts`、`tests/backend-manager.test.ts` | — | CLI-01（部分：无手工 serve）；SHARED-02；后台复用/拉起/端口占用/版本不兼容/失败不回落 |
| **V2-2 CLI 工作台** | 新增 `src/cli-interactive/{registry,repl,home,banner,render,state}.ts`、`src/cli-interactive/commands/*`；修改 `src/cli.ts`（无参 TTY→REPL）；测试 `tests/v2-cli-workbench.test.ts` | V2-1（配置 + 后台） | CLI-01、CLI-02；非交互命令不回归 |
| **V2-3 IDE 页面与真实提交** | 新增 `extensions/vscode/src/{backend,panels,webview-bridge,config-store}.ts`、`extensions/vscode/media/*`、`src/client/context-assembler.ts`；修改 `extensions/vscode/package.json`（menus/views）、`extensions/vscode/src/extension.ts`、`src/http/server.ts`（`POST /v1/contexts`）；测试 `tests/v2-context-assembler.test.ts` + EDP 扩展 | V2-1 | IDE-01；SHARED-01；真实提交接线（is_mock=false） |
| **V2-4 Diff / 图表 / 导出 / 异常** | 新增结果读取接口与 `src/client/results.ts`、webview 详情结果视图、SVG 图、导出接线（复用 `delivery/package.ts`）；错误模型与文案；测试 `tests/v2-results.test.ts` + EDP | V2-3 | IDE-02；ERROR-01 |
| **V2-5 安装包与试用** | 修改 `scripts/package-cli.mjs`、`extensions/vscode/build.mjs`、`README.md`、`docs/history/d19-trial.md`（或新增 v0.3 试用指南）、版本号 0.3.0；打包产物端到端验证 | V2-1..V2-4 | 全部；从产物验证完整流程 |

阶段顺序固定：先配置/后台/提交/状态/取消，再补结果呈现。每阶段独立本地提交（不 push）。

## 七、需要产品负责人决策的歧义（Q1~Q5）

| # | 问题 | 结论（2026-09-11 用户已确认） |
| --- | --- | --- |
| Q1 | CLI 工作台视觉保真度 | **采用全屏 TUI 库 `ink`**（v7，MIT，Node>=22，peer react>=19.2）。业务逻辑仍抽离为纯 TS，ink 只做呈现。 |
| Q2 | `ResourceGrant` 来源 | **配置引用 `grant_ref`**（用户提供的授权文件），仅 `valid_until` 内且阶段匹配放行；不做自动授权。 |
| Q3 | 凭据存储 | **两端共用凭据引用与解析服务**：CLI `/model` 隐藏输入并存入 OS 安全凭据存储，IDE 用 SecretStorage；env 引用继续支持但非唯一方式；**必须明确后台如何获取凭据**；禁止明文落盘/入参/日志；安全存储不可用时明确提供「仅本次使用」或 env，**不静默降级**。 |
| Q4 | `/test` `/benchmark` 范围 | **支持已有任务候选 + 已配置构建与测试资产的冻结源码版本**（不要求先跑 `/optimize`），复用现有执行器与上下文装配；**不提供任意文件/任意命令入口**；性能测试遵守正确性资格与资源授权。 |
| Q5 | 导出产物格式 | 复用 `delivery/package.ts`：报告 + CSV + SVG 图 + patch + 复现命令清单（未单独追问，按此默认）。 |

> 其余常规实现细节（文件组织、命名、提示文案、默认值）由实施方按上述方案自行决定。

## 八、工作树状态与新增文档

- 新增文档：`docs/product/prd-v0.3.md`（需求基线）、`docs/architecture/v2-0-design.md`（本设计报告）。
- 保留历史：`docs/product/PhyOpt_Agent_PRD_V0.3.docx`（原始）、`docs/product/PhyOpt_Agent_PRD_v1.1.docx`、`docs/product/PhyOpt_Agent_Development_Plan_v1.1.docx` 均未改动。
- 用户未提交改动：`src/cli.ts` 有 1 行用户改动（`cmdStatusServer` 增加 `verbose` 选项），本阶段**保留不改**。
- 文档在 2026-09-14 统一归档到 `docs/` 分类目录；当前工作树状态以 `git status` 为准。
- 本阶段边界：未改执行器 / 统计规则 / 冻结测试，未调用云模型、未连 ARM、未新增优化实验。
