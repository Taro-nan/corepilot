# 优化与独立测试

优化任务负责调查和修改源码。测试任务负责在机器上运行固定测试代码，核对正确性或比较性能。测试不会修改两端源码，也不需要先创建优化任务。

## 选择入口

| 目的 | 操作 | 结果含义 |
| --- | --- | --- |
| 先得到优化补丁 | 创建优化任务，选择“仅生成代码” | 代码待验证；构建、正确性和性能均未测试 |
| 优化时自动测试与复验 | 创建优化任务，选择自动验证 | 使用已获资格的方案；通过后仍需人工审阅 |
| 检查已有库或比较两个版本 | 进入测试任务 | 独立记录执行、正确性和性能，不产生批准或源码交付 |

测试两端可分别选择源码分支或已上传库包，因此支持源码与源码、源码与库包、库包与库包。源码会固定 Git commit，再通过 RPC 上传到 Runner 的本次专属目录中构建；上传库包固定文件、入口和摘要，在使用时检查目标机器兼容性及依赖。当前库包入口支持 Linux `.so` 及配套头文件，不把其他产物类型写成已支持。

“仅生成代码”需要在提交前明确允许 Agent 修改的仓库相对文件或目录；目录以 `/` 结尾，包含其所有后代文件。应选择最小范围，并排除测试、参考实现和评价器；调查时仍可读取仓库中的其他源码。优先调查文件 `--file` 仅提示从哪里开始阅读，不授予修改权限。修改范围随任务冻结，需扩大时创建新任务。

历史源码任务没有记录授权范围，旧候选与报告保持原样。继续历史任务时需要明确范围，范围从本次继续生效；如果旧工作区相对原基线已有越界改动，先检查现场，系统不会清理或覆盖。独立测试已有候选无需补录范围。

## 创建测试

1. 选择被测对象；需要性能比较时再选择比较对象。仅测正确性时也可勾选“向正确性脚本提供比较库”，具体参考用途仍由方案定义。
2. 选择执行机器及已有测试方案。方案来自相同的 Library Package / Evaluator 目录，既可以复用已有方案，也可以先在项目的测试准备页上传、编辑或用已配置模型起草代码。
3. 查看正确性输入、独立参考与误差规则，或性能负载、线程、CPU / NUMA 与采样条件。比较基线不是自动可信的正确性参考。
4. 选择正确性、性能或两者后提交。方案版本变化会要求重新读取，不沿用过期条件启动。
5. 在详情查看实际阶段与结果；完整命令、原始测量、目录及两端身份按需展开。取消请求提交后，状态仍以 Runner 确认结果为准。断线后查询原作业，不重复提交。

准备代码时可离开测试弹窗，返回后继续原草稿。系统会重新读取已有方案；目录或机器信息读取失败时使用“重新读取创建条件”，不用重新填写整个任务。测试和优化弹窗底部始终保留主操作。

创建请求发出后，如果响应丢失或页面刷新，浏览器会保留请求标识，并要求先“核对原请求”。若已创建，页面打开原测试；若暂未查到，请求仍可能在途中。只有“关闭未创建的请求”返回关闭状态后，才能安全地以新标识提交。关闭操作不会取消已创建的测试；需要取消时请进入对应测试任务操作。浏览器需要可用的 IndexedDB；无法保存请求标识时，页面会保留草稿并阻止提交。

从代码待验证候选进入测试时，应固定候选的 commit。再次选择原始分支 HEAD 测到的是分支当前源码，不能据此声称验证了候选补丁。

没有源码时可独立选择两份库包和目录中已有的适用测试方案。当前 AI 测试代码生成仍在项目测试准备页复用；本次没有新增脱离库接入上下文的通用脚本生成器。

## 结果与边界

“执行完成”只说明 Runner 结束命令。正确性按实际用例分别报告通过、失败、缺失或无效；性能分别展示样本、加速比、区间及退化。没有统计依据时只能报告点估计或结论不足。仅测性能时，正确性必须显示未测试。

独立测试使用现有 `DEVELOPMENT_FEEDBACK` 协议，`formal_evidence: false`。它不能替代正式优化的冻结证据、独立复验、人类批准或交付门禁。未经真实硬件运行的界面夹具不是性能结果。

## CLI 与 API

```text
corepilot optimize --project <项目ID> --function <函数> --source-only --allow src/kernel.c
corepilot optimize --project <项目ID> --function <函数> --source-only --allow src/impl/ --exclude src/impl/tests/
corepilot workflow watch <工作流ID>
corepilot workflow resume <历史源码工作流ID> --allow src/kernel.c
corepilot test list
corepilot test assets
corepilot test import --directory ./library --entry lib/libexample.so --name Example --version 1.0
corepilot test plan --file ./plan-ref.json
corepilot test start --file ./test-request.json --request-id my-comparison-1
corepilot test request --request-id my-comparison-1
corepilot test close-request --request-id my-comparison-1
corepilot test status <测试ID>
corepilot test cancel <测试ID>
```

`--allow` 和 `--exclude` 可重复；目录以 `/` 结尾。HTTP `POST /v1/workflows` 的 `source_only` 模式对应 `candidate_scope: { "include": ["src/kernel.c"], "exclude": [] }`；恢复无记录范围的历史任务时在 `/v1/workflows/<ID>/resume` 提交相同字段。相同幂等键重试必须保持范围一致。旧版客户端的源码任务提交应增加该字段；正式验证模式仍由接入方案规定范围。

`plan-ref.json`：

```json
{ "package_id": "my-library", "package_version": "1.0.0", "target_id": "example" }
```

`test-request.json` 示例（替换为实际已登记的身份）：

```json
{
  "name": "两个构建版本比较",
  "machine_id": "已登记机器ID",
  "plan": { "package_id": "my-library", "package_version": "1.0.0", "target_id": "example" },
  "candidate": { "kind": "source", "project_id": "项目ID", "branch": "optimize-example" },
  "baseline": { "kind": "binary", "asset_id": "上传库包ID" },
  "mode": "both"
}
```

纯库包比较把 `candidate` 换成另一个 `{ "kind": "binary", "asset_id": "..." }`；两份源码可指定不同项目、分支、单次构建命令和相对产物路径。Web 与 CLI 共用 `/v1/testing-tasks`、`/v1/testing-assets` 和 `/v1/testing-plans/preview`。

自动化可在预览后提交 `expected_evaluator_digest` 和 `expected_package_digest`，要求实际使用的规则与刚刚确认的版本相同。网页默认携带这两个值。

创建测试可通过 `Idempotency-Key` 请求头或 CLI 的 `--request-id` 提供 1 至 160 个字符的非空标识。同一标识和相同输入复用原测试；不同输入返回冲突。未提供标识时，每次提交仍会创建独立测试。

创建响应未知时，使用上述 `test request` 或带相同请求头的 `GET /v1/testing-requests` 查询：`CREATED` 仅表示控制端已保存测试，须按返回的测试 ID 查看实际准备和执行状态；`NOT_FOUND` 不能证明在途请求不会随后到达。决定放弃尚未创建的请求时，使用 `test close-request` 或 `POST /v1/testing-requests/close`（相同请求头、空 JSON 对象）。关闭与创建原子竞争：返回 `CLOSED` 后此标识不能再创建测试；返回 `CREATED` 表示原测试已存在，不会被关闭或取消。历史记录若同一标识对应多条测试，系统保留全部记录并要求维护者核对，不自动选择。

带标识的创建需要控制端数据目录支持同一文件系统内的硬链接和正常文件写入；不支持时会报错并要求核对原请求，不退回非原子创建。当前只保证新版本控制端之间的创建与关闭竞争；测试状态更新尚无跨进程事务，不能将多个控制进程或新旧版本同时指向同一数据目录。

请求尚待核对时，即使访问 URL 未变，也不能切换到另一套控制端数据目录后把该目录的查询或关闭结果当成原请求的结果；旧目录中的请求仍可能存在或在途中。请恢复原数据目录并核对，或由维护者检查原控制端状态。目前尚无绑定请求的持久控制端数据目录身份，不保证跨实例或跨数据目录的核对安全。
