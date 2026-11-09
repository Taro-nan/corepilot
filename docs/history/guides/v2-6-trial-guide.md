# PhyOpt 0.4 试用指南

本文面向第一次使用 PhyOpt 的用户，覆盖“安装 → 配置 → 生成候选 → 测试 → 查看结果”的最短路径。自动化测试使用 Mock；真实模型和 ARM 机器需要额外配置和授权。

## 安装

Node.js 最低要求为 `>=22.19.0`。在仓库根目录执行：

```powershell
npm install
npm run build
node scripts/package-cli.mjs
npm install -g .\build\phyopt-agent-0.4.0.tgz
```

## 创建 YAML 配置

```powershell
phyopt config init --output phyopt.yaml
phyopt config validate --config phyopt.yaml
```

交互终端会逐项提问；完成后显示“✅ 配置已生成: …”和“你可以手动编辑此文件”。配置文件可以复制成多份，用 `--config` 选择不同机器或实验方案。

## 生成和验证一个候选

先确保源码已提交到 Git，然后执行：

```powershell
phyopt candidate generate path/to/kernel.S --config phyopt.yaml --function sgemv_n --goal "提升性能"
phyopt candidate diff --config phyopt.yaml
```

记录输出的 `candidate-id`，再执行：

```powershell
phyopt test <candidate-id> --config phyopt.yaml
phyopt benchmark <candidate-id> --config phyopt.yaml
phyopt task list --config phyopt.yaml
phyopt task status <task-id> --config phyopt.yaml
phyopt task diff <task-id> --config phyopt.yaml
phyopt task export <task-id> --format markdown --config phyopt.yaml
```

`test` 只运行 BUILD 和 CORRECTNESS；`benchmark` 还会运行 PERFORMANCE。候选补丁不会自动写回源码，导出也不会 commit、merge 或 push。

## 运行完整多候选优化

```powershell
phyopt optimize path/to/kernel.S --config phyopt.yaml --function sgemv_n
phyopt workflow status <workflow-id> --config phyopt.yaml
```

只有独立复验通过后才能执行 `phyopt workflow export <workflow-id> --config phyopt.yaml`。后台工作流会持久化到 SQLite，关闭终端后仍可查询。

## 交互工作台

直接输入 `phyopt` 进入工作台，输入 `/` 查看命令：

```text
/model configure|show|verify
/target select|show|check
/optimize [source...] [--function <name>] [--goal <text>]
/candidate generate|diff
/test [candidate-id|--frozen]
/benchmark [candidate-id|--frozen]
/task list|select|status|cancel|retry|resume|diff|export
/workflow status|cancel|export <workflow-id>
/config show|set|edit|check|reset
/exit
```

工作台和普通 CLI 调用同一业务层。输入错误命令会直接失败，不再提供旧命令别名。

## 真实环境前检查

```powershell
phyopt doctor --config phyopt.yaml
phyopt project inspect --config phyopt.yaml --json
phyopt target check --config phyopt.yaml
phyopt model verify --config phyopt.yaml
```

真实执行必须使用 `backend.runner: experiment`、严格 SSH host key、有效 `ResourceGrant`、冻结 source/baseline、测试资产和性能门禁。没有这些条件时先使用 Mock 完成流程体验，不要把模拟结果当作 ARM 证据。

## 常见覆盖

```powershell
phyopt optimize path/to/kernel.S --config phyopt.yaml --function dgemm
phyopt optimize path/to/kernel.S --config phyopt.yaml --target s2500
```

优先级为 CLI 参数 > 环境变量 > 配置文件 > 默认值；覆盖不会修改 YAML。
