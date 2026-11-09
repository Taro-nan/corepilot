# 共享执行机器

CorePilot 的日常操作分为：维护者部署并注册 Runner；项目选择已注册机器；优化任务使用同一条 RPC 执行链。网页、CLI 和已连接共享服务的 TUI 共用机器注册记录。

## 维护者：部署与注册一次

在目标 Linux 机器安装 Runner，使用真实的工作目录、独立数据库与访问凭据启动。例如：

```bash
export COREPILOT_RUNNER_TOKEN='<自行设置的 Runner 凭据>'
corepilot-runner --host 0.0.0.0 --port 4327 \
  --db /srv/corepilot-runner/runner.sqlite \
  --workspace-root /srv/corepilot-runner/workspace \
  --resource-enforcement required
```

在网页左侧“维护者 → 执行机器”点击“注册执行机器”，填写易于识别的名称、Control 服务器能访问的 RPC 地址，以及 Runner Token。Token 可直接填写，也可使用 `${COREPILOT_RUNNER_TOKEN}`，由 **Control 服务环境**解析；它需要与 Runner 启动时的凭据一致。

展开“部署环境（维护者配置）”，登记源码传输所用的 SSH Alias，或主机、用户、端口和服务端私钥路径，再填写 Runner 工作目录。该目录必须在 Runner 启动时授权的 workspace 内，SSH 与 RPC 必须对应同一台执行机。当前版本仍用 SSH/scp 暂存候选、evaluator 和 baseline；这一配置由维护者准备一次，各项目复用。

“保存并检测”会保存注册信息，并通过真实 `/health`、`/machine` 请求检测连接。系统展示在线、离线、待检测、状态待刷新或停用，以及架构、CPU 数、NUMA、系统和检测时间。列表每 10 秒刷新，服务器复用 30 秒内的检测结果；“检测连接”可立即重测。离线时保留最近成功识别的硬件，并标出时间，不将旧硬件信息当作当前在线证明。

手动点击“检测连接”或项目中的“检测所选机器”后，页面显示检测进度；完成后保留明确的连接成功或失败提示与检测时间。检测结果直接更新机器状态和硬件信息；RPC 返回了离线结果时显示失败原因，不会仅因 Control API 请求成功而提示连接成功。

可以先登记 RPC 连接，再补充部署环境。此时机器显示“待维护者准备”；未配置部署环境或已停用的机器不能启动新的优化。在线也不等于正式实验就绪：正式执行仍要求强制资源约束、合格 evaluator、固定 baseline 与相应构建测试方案。

编辑机器可修改连接、名称和部署信息，或取消“允许项目使用这台机器”。已有 Token 显示掩码，同一地址原样保存会保留原凭据；更换地址须提供对应凭据。当前沿用工作台既有的管理员访问凭据，“维护者”是操作入口分工，尚未引入多用户角色系统。

## 项目用户：选择机器

进入“模型与机器 → 目标机器”，在“执行机器”中选择已注册节点并保存。项目配置仅保存引用：

```yaml
runner:
  mode: rpc
  machine_id: <已注册机器 ID>
```

项目不再保存这台机器的 RPC Token，不需要填写 SSH 信息。准备好模型、库的构建与验证方案后，在创建优化任务中确认执行机器并开始优化。连接故障时可点击“检测所选机器”，维护者修复连接后继续使用原机器引用。

旧的独立 Runner 或兼容执行配置继续读取；选择已注册机器并保存后，该项目的后续任务采用共享配置。系统不会自动猜测地址、迁移凭据或将历史任务改派到新机器。

## CLI 与 TUI

CLI 指向与网页相同的 Control 实例：

```bash
export COREPILOT_SERVER_URL=http://<Control 地址>:4317
export COREPILOT_SERVER_TOKEN='<工作台访问凭据>'
corepilot machine list
corepilot machine inspect <机器 ID>
corepilot machine check <机器 ID>
corepilot project machine <项目 ID> <机器 ID>
corepilot project check <项目 ID>
corepilot optimize --project <项目 ID> --performance --watch
```

维护者也可用 JSON 文件注册或更新，文件路径由运行 CLI 的机器读取：

```bash
corepilot machine add --file ./machine.json
corepilot machine update <机器 ID> --file ./machine.json
```

```json
{
  "name": "飞腾测试机",
  "runner": {
    "mode": "rpc",
    "endpoint": "http://192.0.2.10:4327",
    "token": "${COREPILOT_RUNNER_TOKEN}"
  },
  "target": {
    "ssh_alias": "benchmark-node",
    "workspace_root": "/srv/corepilot-runner/workspace"
  },
  "enabled": true
}
```

地址与 Alias 是示例，需替换为实际部署。普通清单只返回机器状态和硬件；维护者 inspect 返回掩码配置。机器列表与检测 JSON 不包含实际 Token。

连接共享服务的 TUI `/target` 可直接选择已注册机器；`/validation` 保留机器引用，`/check` 经共享项目执行。独立本地 YAML 引用注册机器时，优化仍由 Control 解析；本地离线 `/check` 无法读取服务器注册表，应使用 `corepilot project check`。

## 持久化与任务身份

注册记录保存在 Control 的同一 SQLite 中，新增 `execution_machines` 表，不删除或重建已有数据库。备份时沿用 Control 数据库与服务环境的备份方式。

任务提交时固定机器 ID、名称、配置版本、RPC 连接和部署环境；连接凭据只在服务器执行内存中使用。修改机器只影响后续新任务。已提交任务、实验身份和报告保留原版本，报告可以追溯执行机器 ID 与配置版本。传输重试、复验、批准和源码交付继续沿用现有语义。
