# 从交互配置到优化测试报告

适用：当前 CorePilot CLI。使用现有优化 Runtime 与 RPC Runner，不需要另写收尾脚本来生成测试报告。

## 1. 启动工作台

在要优化的算法库 Git 根目录运行 `corepilot`。源码开发时先在 CorePilot 仓库执行 `npm ci`、`npm run build`，然后在算法库根目录运行：

```powershell
node D:\Projects\corepilot\dist\entry.js
```

依次执行：

```text
/model
/target
/validation
/check
/optimize
```

`/model` 选择模型并验证工具调用；`/target` 保存目标机 SSH 连接信息。两者都会复用已有配置。

`/validation` 可选择已有 Library Package、目标函数、冻结 baseline 文件及 Runner endpoint。Runner token 填环境变量名称，例如 `COREPILOT_RUNNER_TOKEN`，实际值在启动工作台之前通过环境提供。选择 Package 不会自动将 Draft 授予资格；Evaluator 必须已经 Qualified。Package 的审查状态会单独显示。

正式实验的 Runner 要在 Linux 目标机提前运行并启用资源约束；例如按实际路径、端口与 SSH 转发调整：

```bash
export COREPILOT_RUNNER_TOKEN='<your-token>'
corepilot-runner --host 127.0.0.1 --port 4318 --db /path/to/runner.sqlite --workspace-root /path/to/workspace --resource-enforcement required
```

使用 `corepilot-runner --help` 核对安装版本的参数。若使用 SSH 隧道，将本地端口转发到上述 Runner 端口，再把本地地址填到 `/validation`。SSH 工作目录仍用于当前源码与 evaluator staging。

已有 testpack 用户可在 `/validation` 选择兼容模式，再用 `/build` 设置构建命令。该模式与正式 RPC Package 的证据资格不同，报告会保留实验有效性和 coverage 的实际值。

`/check` 检查配置、凭据解析、测试资产；Package 模式还检查 baseline SHA-256、Runner 连接和资源约束开关。它不调用模型、不创建任务，也不替代真实构建、机器资格或正式测量。

## 2. 启动并观察

无参数 `/optimize` 会读取验证配置中的函数作为默认值，然后让你选择：

- 正确性 + 性能 + 复验，持续观察并生成报告。
- 不启用性能优化的验证流程，持续观察并生成报告。
- 性能优化，提交到后台后返回。

也可以直接输入：

```text
/optimize --function public_symbol --performance --watch
/workflow list
/workflow watch workflow:...
```

观察显示阶段、轮次、当前动作和失败信息。按 Esc 停止当前观察并返回工作台；关闭工作台不取消后台优化。需要取消任务时使用 `/workflow cancel <id>`。

观察期间若连接暂时中断，客户端只重新读取原任务或报告，最多尝试 3 次，并提示当前状态尚未确认；不会重新创建任务或实验。仍无法连接时停止观察并返回失败，修复连接后可对原 ID 再次执行 `workflow watch`。权限错误等服务端拒绝不会自动重试。

无参数 `/workflow` 可从真实优化记录中选择工作流，再查看状态、观察、导出报告或取消任务。首页近期活动也来自这些优化记录。

## 3. 获得报告

后台执行结束后，默认在配置的 `output_dir/<工作流 UUID>/` 生成：

```text
report.md
report.json
```

`--watch` 在观察结束后也会导出一份当前报告，可通过 `--output` 指定目录。已有或失败的任务可以随时重新导出；原始配置变化不影响数据库中已保存事实的读取。

```text
/workflow report workflow:... --output "D:/Reports/我的报告"
```

Markdown 报告包含任务与源码身份、候选/假设、实验总览、正确性 coverage、逐 case 诊断、逐 workload 性能、原始样本、资源环境、命令日志和反馈历史。JSON 包含同一份结构化快照，可用于后续分析。报告不重新判定 acceptance，不修改历史实验；运行中导出的报告会标明尚未完成。

历史 gate v2 缺区间字段时使用点估计；新测试方案选择「重复测量」可启用 gate v3 真实统计区间，并提供 A/A 校准和冻结源码重建复现。方法、使用步骤与限制见[性能可信度与复现](performance-assurance.md)。Development、Formal、Revalidation 分别显示，不把历史配置的 0.95 当成已计算区间。

报告生成不授予 Human Approval，不自动 merge。使用 `workflow evidence --prepare` 准备冻结证据，使用 `workflow human-approve` 明确批准，再用 `workflow deliver --commit-message` 单独交付；不要将普通报告当成冻结 Evidence。参见 [生命周期指南](optimization-workflow.md)。

## 4. 非交互使用

以下命令在算法库根目录执行，使用自己的配置路径和函数名：

```powershell
corepilot check --config ./corepilot.yaml
corepilot optimize --config ./corepilot.yaml --function public_symbol --performance --watch --output ./optimization-report
corepilot workflow list --config ./corepilot.yaml --json
corepilot workflow status workflow:... --config ./corepilot.yaml --json
corepilot workflow watch workflow:... --config ./corepilot.yaml --interval 2 --timeout 3600
corepilot workflow report workflow:... --config ./corepilot.yaml --output ./optimization-report
```

`workflow --config` 会连接或启动对应配置的后台。已连接到后台时可省略它；也可以通过 `COREPILOT_SERVER_URL` 指定后台地址。报告经 HTTP 获取，客户端不直接打开 SQLite。

`watch --json` 输出逐行 JSON 状态、连接中断/恢复事件和最后的文件路径；普通 `report --json` 输出完整报告 JSON。`report --output ... --json` 返回导出路径及报告对象。命令成功返回 0；watch 观察到 FAILED、CANCELLED 或 PERFORMANCE_THRESHOLD_NOT_MET 返回 1，报告仍会导出。WAITING_APPROVAL 表示停止观察并交给人工审阅，不能据此忽略报告里的无效/不完整实验。

Ctrl+C 或观察超时仅结束观察；超时返回 1。重新 watch 可继续查看。同一后台进程内的优化继续运行，当前工作流不承诺后台重启后自动续跑 Agent。

## 5. 常见问题

- 找不到 testpack：先 `/validation` 指向实际 YAML，首次 `/model` 生成的路径只是占位配置。
- Evaluator 未 Qualified：按接入指南完成人工审阅与资格验证，不能通过交互菜单跳过。
- baseline SHA 不一致：检查所选文件与 Package 声明的版本，不能把不同二进制当作同一基线。
- Runner token 缺失：在启动工作台/后台之前设置对应环境变量，再重试 `/check`。
- 后台不支持 report/list：可能复用了升级前的后台。等待活动任务结束，再执行 `corepilot backend stop --config ...` 和 `corepilot backend start --config ...`。
- 自动导出失败：状态会显示 `report_error`；修复磁盘/目录问题后用 `workflow report --output ...` 重新导出，不必重跑实验。
- 没有实验或只有失败实验：报告仍会生成，明确展示缺失项，不产生虚构的成功结果。

新增算法库的完整接入见 [Library Onboarding](library-onboarding.md) 与 [Library Package](library-packages.md)。
