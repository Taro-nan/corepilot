# 配置指南

> 历史资料：本页保留旧 public 配置、`config init` 与 ResourceGrant 流程，不能作为当前命令或 schema 的依据。当前配置入口见[仓库 README](../../README.md)和 [Library Package](library-packages.md)，阶段与实际执行边界见[生命周期指南](optimization-workflow.md)。历史定位见[资料索引](../history/legacy-and-external-baselines.md)。

PhyOpt 使用项目内的 `phyopt.yaml` 或 `phyopt.yml` 作为正式配置文件。YAML 支持注释，文件可以提交到 Git；同一项目可以维护多份配置，例如 `phyopt-s2500.yaml` 和 `phyopt-s5000.yaml`，运行时用 `--config` 选择。

## 创建配置

在项目目录执行：

```powershell
phyopt config init --output phyopt.yaml
```

交互终端会逐项询问项目目录、函数、优化目标、源码文件、模型、目标机器和构建命令；非交互终端会直接生成带中文注释的模板。命令完成后会显示：

```text
✅ 配置已生成: <你的配置文件>.yaml
你可以手动编辑此文件。
```

模板包含 `schema_version: 1`。它把可复现实验输入和运行态指针分开，任务/候选指针不会写回配置文件。

## 文件结构

常用字段如下：

```yaml
schema_version: 1
project_root: .

backend:
  host: 127.0.0.1
  port: 7346
  runner: mock       # mock 或 experiment
  transport: mock    # mock 或 ssh
  db_path: null
  ssh_alias: null

model:
  provider: mock
  name: null
  credential_ref: null   # 环境变量名或安全存储键名
  endpoint_ref: null
  endpoint: null

target:
  name: local
  architecture: aarch64
  ssh_alias: null
  grant_ref: null

targets: {}

optimization:
  function_name: null
  goal: null
  source_files: []
  target: null

build:
  executable: make
  args: []
  cwd: null
  environment: {}
  timeout_ms: 600000

source: null
test_assets: []
baseline: null
gates: null
budget:
  max_candidates: 3
  max_model_calls: 12
  max_duration_ms: 3600000
exploration: null
output_dir: null
```

路径字段以配置文件所在目录为基准解析。`source`、`baseline`、`gates` 和 `exploration` 在真实实验中需要填写冻结的身份、测试资产、门禁和远端采样信息；命令不会猜测这些值。凭据只能通过 `credential_ref`/`endpoint_ref` 引用，不能把 API Key 写进 YAML。

## 校验和查看

```powershell
phyopt config validate --config phyopt.yaml
phyopt config show --config phyopt.yaml
phyopt config show --config phyopt.yaml --effective
phyopt config show --config phyopt.yaml --effective --json
```

`validate` 会检查字段、类型、秘密值和 schema，并输出文件 SHA-256。`show --effective` 还会叠加环境变量和本次命令的覆盖，显示每个字段的来源（`default`、`file`、`env` 或 `cli`）。

配置解析优先级固定为：**CLI 参数 > 环境变量 > 配置文件 > 默认值**。

常用环境变量包括：

- `PHYOPT_GOAL`、`PHYOPT_FUNCTION`、`PHYOPT_SOURCE_FILES`、`PHYOPT_TARGET`；
- `PHYOPT_PROJECT_ROOT`、`PHYOPT_OUTPUT_DIR`、`PHYOPT_DB_PATH`；
- `PHYOPT_MODEL_PROVIDER`、`PHYOPT_MODEL_NAME`、`PHYOPT_MODEL_PI_PROVIDER`、`PHYOPT_MODEL_CREDENTIAL_REF`、`PHYOPT_MODEL_ENDPOINT_REF`、`PHYOPT_MODEL_ENDPOINT`；
- `PHYOPT_BACKEND_HOST`、`PHYOPT_BACKEND_PORT`、`PHYOPT_BACKEND_RUNNER`、`PHYOPT_BACKEND_TRANSPORT`、`PHYOPT_BACKEND_SSH_ALIAS`。

例如只临时改变函数或目标机器：

```powershell
phyopt optimize src/gemm.c --config phyopt.yaml --function dgemm
phyopt optimize src/gemm.c --config phyopt.yaml --target s2500
```

这两个覆盖只作用于本次运行，不会修改 YAML。

## 交互编辑

工作台和普通 CLI 使用同一套配置语义。进入工作台后：

```text
/config show
/config set backend.port 7346
/config edit build
/config edit test-assets list
/config edit baseline
/config edit gates
/config check test
/config check benchmark
/config check optimize
/config reset build
```

`show` 只显示脱敏后的配置；`set` 修改受支持的单个键；`edit` 通过向导编辑分区；`check` 复用真实上下文装配规则检查运行是否就绪；`reset` 将分区恢复为默认值。配置编辑会原子写回 YAML，并保留已有注释。

## 多份配置和迁移

推荐把不同机器或实验方案放在不同文件中：

```powershell
phyopt config validate --config phyopt-s2500.yaml
phyopt optimize src/gemm.c --config phyopt-s2500.yaml --target s2500
phyopt optimize src/gemm.c --config phyopt-s5000.yaml --target s5000
```

也可以设置 `PHYOPT_CONFIG_PATH` 作为默认路径。未指定时，CLI 从当前目录向上查找 `phyopt.yaml`、`phyopt.yml`，最后使用用户目录中的默认数据路径。

旧 schema 会在读取时按登记的迁移规则升级，并在 `validate`/`show` 中报告迁移来源和警告。需要生成独立的新文件时执行：

```powershell
phyopt config migrate --config old-config.json --output phyopt.yaml
```

迁移不会覆盖原文件；输出必须是 `.yaml` 或 `.yml`。高于当前 CLI 支持版本的 `schema_version` 会明确拒绝，需要先升级 PhyOpt。旧的点号配置入口不再作为公开命令；请使用 `config set/edit/check/reset`。

## 复现检查

提交配置前建议运行：

```powershell
phyopt config validate --config phyopt.yaml --json
phyopt project inspect --config phyopt.yaml --json
```

保存输出中的配置 SHA-256、源码 commit/archive SHA、baseline SHA、测试套件摘要和目标 profile。这样在另一台机器或另一份配置上可以确认实际输入是否相同。
