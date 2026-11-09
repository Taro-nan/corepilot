# 优化与独立测试

优化任务负责调查和修改源码。测试任务负责在机器上运行固定测试代码，核对正确性或比较性能。测试不会修改两端源码，也不需要先创建优化任务。

## 选择入口

| 目的 | 操作 | 结果含义 |
| --- | --- | --- |
| 先得到优化补丁 | 创建优化任务，选择“仅生成代码” | 代码待验证；构建、正确性和性能均未测试 |
| 优化时自动测试与复验 | 创建优化任务，选择自动验证 | 使用已获资格的方案；通过后仍需人工审阅 |
| 检查已有库或比较两个版本 | 进入测试任务 | 独立记录执行、正确性和性能，不产生批准或源码交付 |

测试两端可分别选择源码分支或已上传库包，因此支持源码与源码、源码与库包、库包与库包。源码会固定 Git commit，再通过 RPC 上传到 Runner 的本次专属目录中构建；上传库包固定文件、入口和摘要，在使用时检查目标机器兼容性及依赖。当前库包入口支持 Linux `.so` 及配套头文件，不把其他产物类型写成已支持。

## 创建测试

1. 选择被测对象；需要性能比较时再选择比较对象。
2. 选择执行机器及已有测试方案。方案来自相同的 Library Package / Evaluator 目录，既可以复用已有方案，也可以先在项目的测试准备页上传、编辑或用已配置模型起草代码。
3. 查看正确性输入、独立参考与误差规则，或性能负载、线程、CPU / NUMA 与采样条件。比较基线不是自动可信的正确性参考。
4. 选择正确性、性能或两者后提交。方案版本变化会要求重新读取，不沿用过期条件启动。
5. 在详情查看实际阶段与结果；完整命令、原始测量、目录及两端身份按需展开。取消请求提交后，状态仍以 Runner 确认结果为准。断线后查询原作业，不重复提交。

从代码待验证候选进入测试时，应固定候选的 commit。再次选择原始分支 HEAD 测到的是分支当前源码，不能据此声称验证了候选补丁。

没有源码时可独立选择两份库包和目录中已有的适用测试方案。当前 AI 测试代码生成仍在项目测试准备页复用；本次没有新增脱离库接入上下文的通用脚本生成器。

## 结果与边界

“执行完成”只说明 Runner 结束命令。正确性按实际用例分别报告通过、失败、缺失或无效；性能分别展示样本、加速比、区间及退化。没有统计依据时只能报告点估计或结论不足。仅测性能时，正确性必须显示未测试。

独立测试使用现有 `DEVELOPMENT_FEEDBACK` 协议，`formal_evidence: false`。它不能替代正式优化的冻结证据、独立复验、人类批准或交付门禁。未经真实硬件运行的界面夹具不是性能结果。

## CLI 与 API

```text
corepilot optimize --project <项目ID> --function <函数> --source-only
corepilot workflow watch <工作流ID>
corepilot test list
corepilot test assets
corepilot test import --directory ./library --entry lib/libexample.so --name Example --version 1.0
corepilot test plan --file ./plan-ref.json
corepilot test start --file ./test-request.json --request-id my-comparison-1
corepilot test status <测试ID>
corepilot test cancel <测试ID>
```

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
