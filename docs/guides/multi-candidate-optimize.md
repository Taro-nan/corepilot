# 多候选优化

> 历史资料：本页的旧多候选/patch/ResourceGrant/导出命令不属于当前标准流程。当前操作以 [Optimization Lifecycle](optimization-workflow.md) 和 CLI dispatch 为准；[历史索引](../history/legacy-and-external-baselines.md)说明保留范围。不要将下文作为 C002 复现命令。

`phyopt optimize` 会提交一个有界的多候选工作流，由受管后台完成生成、门禁、测量、优选、独立复验和交付。命令行和工作台的资源语义一致。

## 启动

```powershell
phyopt optimize kernel/arm64/gemv_n.S --config phyopt.yaml --function sgemv_n --goal "提升单线程性能"
```

命令返回 `workflow-id` 后立即结束前台进程。使用以下命令查看生命周期：

```powershell
phyopt workflow status <workflow-id> --config phyopt.yaml --json
phyopt workflow cancel <workflow-id> --config phyopt.yaml
phyopt workflow export <workflow-id> --config phyopt.yaml
```

工作台中的等价写法是 `/optimize`、`/workflow status`、`/workflow cancel` 和 `/workflow export`。

## 必需配置

多候选闭环要求配置文件中同时具备：

- `backend.runner: experiment`，以及可用的 `transport`；
- `source.commit` 和 `source.archive_sha256` 等冻结源码身份；
- `target`/`targets` 中与本次 `--target` 对应的 profile 和有效 `grant_ref`；
- `build`、`gates.correctness`、`gates.performance` 和模型 provider；
- `exploration.remote` 的工作目录、worktree、源码包、harness 和基线库路径；
- `exploration.allowed_files`、`frozen_contract_id`、完整 `sampling` 和预算字段。

任一字段缺失、哈希不匹配或授权过期，都会在模型调用和远程调用之前失败。程序不会猜测路径、补写哈希或扩大允许修改的文件范围。

## 阶段和交付门禁

```text
GENERATING
→ VALIDATING_CANDIDATES
→ MEASURING
→ SELECTING
→ REVALIDATING
→ DELIVERABLE
```

探索阶段的候选必须通过补丁范围和结构门禁；正确性失败不会进入性能阶段。优选候选会在冻结 commit 的独立 worktree 中重新应用补丁、构建并运行新的正确性和性能样本，探索样本不会复用。只有独立复验结果为 `PASSED` 或 `ACCEPTED` 才能导出交付包。

## 重启、取消和复现

工作流快照、候选、选择、复验和交付包写入 SQLite。关闭工作台只会关闭 UI；后台继续运行。重启后用 `workflow status` 查询同一个 ID。取消需要显式调用 `workflow cancel`；远端停止状态无法确认时任务保持 `RECOVERING`，不会显示虚假的 `CANCELLED`。

配置文件本身应提交到 Git。运行时通过 `--config` 选择具体文件，CLI 覆盖只对当前调用生效，保证相同 YAML、源码和测试资产可以重放。
