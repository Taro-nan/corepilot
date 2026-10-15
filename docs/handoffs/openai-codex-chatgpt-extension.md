# OpenAI Codex / ChatGPT 登录接入交接

> 状态：**待扩展**
>
> 记录日期：2026-09-20
>
> 当前结论：本专题已经完成需求讨论和可行性确认，**尚未实施，不属于当前主线，也不阻塞现有 PhyOpt 优化工作流继续开发**。

## 一、背景

当前 PhyOpt 已支持通过 OpenAI-compatible endpoint、模型 ID 和 API Key 调用模型。OpenAI API 路径也已经支持模型发现、思考强度、代理和 tool call 能力验证。

实际测试 OpenAI API 时返回：

```text
429 credit_balance_exhausted
```

这表示 OpenAI API organization/project 没有可用 API credits。ChatGPT Plus/Pro 与 OpenAI API Platform 是独立的产品和计费体系，Plus/Pro 订阅不会自动成为 API credits。因此，当前 OpenAI API Key 实现没有问题，但它不能满足“使用 ChatGPT Plus/Pro 中的 Codex 额度、无需单独给 API Platform 充值”的需求。

## 二、待扩展目标

在现有 OpenAI 模型来源下增加两种相互独立的使用方式：

```text
PhyOpt Agent
    │
    ▼
Model / Agent Router
    │
    ├── DeepSeek、Qwen、Kimi 等
    │       └── Pi + OpenAI-compatible API
    │
    └── GPT - OpenAI
            ├── OpenAI API Key
            │       └── Platform 独立计费
            │
            └── ChatGPT/Codex 登录
                    └── ChatGPT Plus/Pro 的 Codex 额度与限额
```

这项扩展的目标不是绕过 OpenAI API 计费，也不是复用浏览器 Cookie，而是通过 OpenAI 官方 Codex 登录和运行接口，让用户用自己的 ChatGPT/Codex 账户运行 Codex Agent。

## 三、已确认的技术边界

### 3.1 不能使用普通 OpenAI SDK 实现

普通 `openai` SDK 仍然调用 OpenAI API，需要 API Key 和 Platform API 余额，不能直接使用 ChatGPT Plus/Pro 订阅。

正确的接入对象应是：

- Codex SDK：用于以编程方式启动和继续 Codex 线程；
- Codex App Server：用于深度集成认证、模型列表、线程、审批、历史和流式 Agent 事件。

官方资料：

- <https://learn.chatgpt.com/docs/codex-sdk>
- <https://learn.chatgpt.com/docs/app-server>

### 3.2 ChatGPT 登录只能由交互入口发起

浏览器登录属于用户交互，不能只靠 YAML 完成。`/model` 负责发起登录；YAML 只记录运行方式和模型选择。

非交互式 `phyopt optimize` 可以复用本机已经存在的 Codex 登录状态，但如果尚未登录，应明确失败并提示：

```text
ChatGPT/Codex 尚未登录，请先执行 /model 完成浏览器登录。
```

非交互命令不得静默打开浏览器。

### 3.3 认证凭据不属于项目配置

ChatGPT OAuth token 由 Codex 自己持久化和刷新。PhyOpt 不应：

- 将 token 写入 `phyopt.yaml`；
- 将 token 写入 PhyOpt API Key 凭据文件；
- 读取、复制或记录浏览器 Cookie；
- 在日志、SQLite、运行报告或错误中输出 token。

PhyOpt 只通过 Codex App Server 查询登录状态、计划类型和额度状态。

### 3.4 Plus/Pro 不是无限额度

ChatGPT 登录路径不消耗 OpenAI API Platform credits，但仍受 ChatGPT/Codex 计划的模型权限、速率和用量限制约束。界面不能宣传为“免费”或“无限调用”。

后续可以通过 App Server 的账号和 rate-limit 接口展示：

- 当前登录账号；
- Plus、Pro 等计划类型；
- 当前 Codex 限额状态；
- 限额耗尽和重置时间。

## 四、建议的 `/model` 交互

选择 `GPT - OpenAI` 后增加一级选择：

```text
选择 OpenAI 使用方式：
  OpenAI API Key（Platform 计费）
  ChatGPT/Codex 登录（使用账号的 Codex 额度）
```

### 4.1 OpenAI API Key

继续使用当前已经实现的流程：

1. 可选代理；
2. 填写或复用 API Key；
3. 调用 `GET /models` 动态发现模型；
4. 选择思考强度；
5. 执行最小 tool call 能力验证；
6. 写入 YAML，并由 PhyOpt 凭据存储持久化 API Key。

### 4.2 ChatGPT/Codex 登录

建议流程：

1. 启动本地 Codex App Server；
2. 调用 `account/read` 查询认证状态；
3. 未登录时显示：

   ```text
   未登录 ChatGPT/Codex
   [打开浏览器登录]
   ```

4. 用户确认后调用 `account/login/start`，认证类型为 `chatgpt`；
5. 使用系统默认浏览器打开 App Server 返回的 `authUrl`；
6. 等待 `account/login/completed`；
7. 登录成功后显示账号与计划类型；
8. 调用 `model/list` 动态读取该账号可用的 Codex 模型和思考强度；
9. 用户选择后，仅把运行方式、模型和思考强度写入 YAML。

第一版只实现浏览器登录即可。设备码登录可以作为无图形环境的后续扩展，不需要与第一版同时落地。

## 五、建议配置表达

下面只是待扩展方案，实施前仍需结合届时的配置结构最终命名：

```yaml
model:
  backend: codex
  auth_mode: chatgpt
  model_id: example-codex-model
  reasoning_effort: medium
  timeout_ms: 1200000
```

Codex/ChatGPT 路径中不需要：

```yaml
endpoint: ...
api_key: ...
```

配置文件被删除时，模型选择会丢失，但 Codex 登录状态仍由 Codex 的用户级认证存储管理。重新执行 `/model` 时可以检测并复用登录状态。用户主动退出 Codex、认证过期或删除 Codex 认证数据后，才需要重新登录。

## 六、Agent 架构建议

Codex 不是一个只返回文本或 tool call 的普通模型 provider，而是完整的代码 Agent。不要把 Codex 强行伪装成现有 Pi `ModelProvider`。

建议在工作流入口增加 Agent 运行策略：

```text
OptimizationAgent
    ├── PiAgentBackend
    │       └── DeepSeek、Qwen、Kimi、OpenAI API、自定义 endpoint
    │
    └── CodexAgentBackend
            └── ChatGPT managed authentication
```

两条路径共享：

- 用户的 `--function` 和可选 `--file` 输入；
- 编辑工作树和验证工作树生命周期；
- 构建、正确性、性能和独立复验；
- 候选 checkpoint；
- 最终用户审批和合并。

Codex 路径的职责：

1. 在编辑工作树路径创建 Codex thread；
2. 将模型、思考强度、工作目录和受限写入范围传给 Codex；
3. 让 Codex 调查仓库并直接修改编辑工作树；
4. 将 Agent 事件转换为 PhyOpt 工作流进度；
5. 构建或正确性失败后，在同一 thread 中继续发送错误信息；
6. 取消工作流时中断 Codex turn，并关闭本次 App Server 会话。

现有验证工作树和性能门禁仍由 PhyOpt 控制。Codex 不负责宣布正确性或性能达标，也不能跳过最终审批。

## 七、tool call 验证建议

现有 OpenAI-compatible API 路径继续执行真实的最小 tool call 请求。

Codex 路径由 Codex App Server 提供完整 Agent 工具运行时。为减少 Plus/Pro 额度消耗，默认不额外发送一次生成请求进行探测；可以将 App Server 初始化、认证状态、`model/list` 和线程创建能力作为接入检查。

如果后续产品要求必须实际探测一次工具调用，可以增加显式的只读探测，但必须提示它会消耗一次 Codex 用量，且不得修改项目文件。

## 八、代理处理

OpenAI API 和 ChatGPT/Codex 都可能需要代理，但两者的网络实现不同：

- API Key 路径继续使用当前模型 transport；
- Codex 路径需要把选定代理传给 Codex App Server 子进程，并验证其 HTTP、HTTPS、SOCKS5 行为；
- 浏览器登录页面使用用户浏览器自身的系统代理；
- 本地 OAuth callback 保持在 localhost，不通过外部代理暴露。

`/model` 仍只在 GPT/OpenAI 来源下询问代理，不影响国内模型来源。

## 九、建议实施顺序

1. 定义 API Agent 与 Codex Agent 的公共运行结果和取消契约。
2. 新增 Codex App Server 客户端，覆盖启动、初始化、JSON-RPC 请求、通知和关闭。
3. 实现 `account/read`、浏览器登录、取消登录、退出和敏感信息脱敏。
4. 实现 `model/list` 与思考强度动态选择。
5. 扩展 `/model` 的 OpenAI 二级分支并写入非秘密配置。
6. 实现 `CodexAgentBackend`，限定其工作目录为编辑工作树。
7. 将 Codex thread 接入现有编译、正确性和性能反馈循环。
8. 补充额度耗尽、认证过期、代理失败、取消和 App Server 异常退出处理。
9. 增加离线协议测试、配置测试、CLI 交互测试和工作流回归测试。
10. 在真实 Plus/Pro 账号上执行一次人工端到端验收，并写中文 devlog。

## 十、验收标准

- `/model` 可以在 OpenAI API Key 与 ChatGPT/Codex 登录之间选择。
- 未登录时可以从交互界面打开浏览器并完成官方 ChatGPT 登录。
- 登录凭据不进入 YAML、PhyOpt 凭据文件、日志、数据库或报告。
- 模型列表和思考强度来自 Codex App Server，而不是硬编码。
- YAML 可以记录 Codex 运行方式，但不能单独发起浏览器认证。
- 非交互优化可以复用已有登录；未登录时给出明确提示。
- Codex 只修改编辑工作树，验证工作树和基准分支仍由 PhyOpt 管理。
- 编译、正确性和性能不通过时，结果能够反馈给同一 Codex thread 继续修复。
- Plus/Pro 限额耗尽、认证过期和代理失败都有准确错误信息。
- 当前 API Key、Pi、工作树、验证和审批主线回归测试全部通过。

## 十一、当前明确不做

本专题处于待扩展状态，当前主线继续使用已经存在的 Pi/OpenAI-compatible API 模型路径。本阶段不进行：

- 安装 Codex SDK 或 Codex CLI 运行时；
- 修改 `phyopt.yaml` schema；
- 修改 `/model` 交互；
- 新增 ChatGPT OAuth token 存储；
- 改造现有 Agent 循环；
- 真实 Plus/Pro 账号登录测试。

后续只有在用户明确要求开始该扩展时，才按本交接文档重新核对最新 OpenAI 官方接口、当前代码和依赖版本，再开始实施。
