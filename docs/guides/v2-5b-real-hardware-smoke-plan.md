# 真实 ARM 硬件冒烟计划

> 本计划只在用户明确授权、目标机和有效 `ResourceGrant` 已准备好后执行。自动化 Mock 测试不能替代真实 ARM 证据。

## 前置条件

1. 在 `~/.ssh/config` 中配置目标别名（例如 `arm-lab-01`），并通过可信渠道核对 host key；客户端使用 `BatchMode=yes` 和 `StrictHostKeyChecking=yes`。
2. 配置文件使用 `backend.runner: experiment`、`backend.transport: ssh`，`target.ssh_alias` 指向该别名，`target.grant_ref` 指向未过期授权文件。
3. `source`、`baseline`、`build`、`test_assets`、`gates` 和 `exploration` 已冻结并通过 `phyopt config validate`。
4. 目标机已安装版本匹配的 `phyopt-remote-agent`，且存在只读探测命令和测试 harness。

## 冒烟步骤

| 步骤 | 命令或动作 | 通过标准 |
| --- | --- | --- |
| 1 | `phyopt doctor --config phyopt.yaml`、`phyopt target check --config phyopt.yaml` | 本地环境、SSH 别名和授权检查通过 |
| 2 | `phyopt backend start --config phyopt.yaml` | 受管后台启动并记录数据库路径 |
| 3 | `phyopt test --frozen --config phyopt.yaml` | 进入 BUILD → CORRECTNESS，远程 receipt 的传输类型为 `ssh` |
| 4 | `phyopt task status <task-id> --config phyopt.yaml --json` | 状态、job、命令和证据可查询，`simulated=false` |
| 5 | `phyopt benchmark --frozen --config phyopt.yaml` | 只有正确性通过后才进入 PERFORMANCE，并保存采样证据 |
| 6 | `phyopt task diff <task-id> --config phyopt.yaml` | 结果视图显示真实 runner、基线和门禁结论 |
| 7 | `phyopt task cancel <task-id> --config phyopt.yaml` | 远端 stop/status 得到权威确认；无法确认时保持 `RECOVERING` |
| 8 | 重启 backend 后再次执行 `task status` | SQLite 恢复同一任务，不重复执行，不伪造取消成功 |

后台运行完成后：

```powershell
phyopt backend status --config phyopt.yaml --json
phyopt backend stop --config phyopt.yaml
```

## 安全边界

- 仅执行配置中冻结的命令和文件；不使用 `StrictHostKeyChecking=no` 或宽泛 `pkill`。
- 过期或缺失授权在任何模型/SSH 调用前失败。
- 断线只记录传输错误；只有协议返回 `STOPPED` 或经授权确认的 `NOT_FOUND` 才能收敛为取消。
- 真实结果必须带有 `transport=ssh`、`simulated=false` 和可追溯的 source/baseline hash。
