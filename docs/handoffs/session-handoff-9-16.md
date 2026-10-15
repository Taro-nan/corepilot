# PhyOpt Agent 会话交接（2026-09-16）

本文记录当前工作树的接手信息。版本已更新为 `0.4.0`；本轮命令规范迁移删除旧入口，不保留别名。

## 当前状态

- 正式配置为项目内 `phyopt.yaml` 或 `phyopt.yml`，支持注释、多份文件、schema 迁移和配置 SHA-256。
- 普通 CLI、交互工作台和 VS Code 使用统一命令规范与共享业务层。
- `optimize` 已提交有界多候选工作流；候选生成、门禁、测量、优选、独立复验和交付记录持久化到 SQLite。
- `task` 与 `workflow` 分成两个资源组；JSON 输出用于脚本和 IDE 集成。
- Mock、OpenAI-compatible 和 Pi provider 走统一模型 factory；凭据只保存引用。
- Experiment runner、严格 SSH host key、ResourceGrant 门禁和远端状态确认协议已接通。
- 当前工作树包含多项未提交代码、测试和文档修改，不能使用硬重置覆盖。

## 正式命令树

```text
phyopt optimize <source...>
phyopt candidate generate|diff
phyopt test [candidate-id|--frozen]
phyopt benchmark [candidate-id|--frozen]
phyopt task list|status|cancel|retry|resume|diff|export
phyopt workflow status|cancel|export
phyopt config init|validate|show|migrate|set|edit|check|reset
phyopt model configure|show|verify
phyopt target select|show|check
phyopt project init|inspect
phyopt testpack import|inspect|qualify|freeze|verify
phyopt doctor
phyopt version
phyopt backend init|start|serve|status|stop
phyopt context import
phyopt internal <command>
```

交互工作台输入 `/` 查看：`/model`、`/target`、`/optimize`、`/candidate`、`/test`、`/benchmark`、`/task`、`/workflow`、`/config` 和 `/exit`。命令规范唯一数据源为 `src/cli-command-spec.ts`，注册表和帮助从这里生成。

## 配置和复现

`phyopt config init --output phyopt.yaml` 在 TTY 中逐项提问，完成后提示配置已生成并可手动编辑；非 TTY 生成带中文注释的模板。解析优先级为 CLI > 环境变量 > 配置文件 > 默认值。`--config` 选择具体文件，CLI 覆盖不会写回 YAML。

真实运行前执行：

```powershell
phyopt config validate --config phyopt.yaml
phyopt config show --config phyopt.yaml --effective --json
phyopt doctor --config phyopt.yaml
phyopt project inspect --config phyopt.yaml --json
```

## 关键实现

| 区域 | 入口 |
| --- | --- |
| CLI 分发与帮助 | `src/cli.ts`、`src/cli-command-spec.ts` |
| 工作台命令 | `src/cli-interactive/commands.ts`、`registry.ts` |
| 配置 schema 与 YAML | `src/config/phyopt-config.ts`、`yaml-config.ts`、`config-resolution.ts` |
| 候选生成与模型 | `src/client/candidate-generation.ts`、`src/model/provider-registry.ts` |
| 任务与后台 | `src/core/task-host.ts`、`src/backend/backend-manager.ts`、`src/http/server.ts` |
| 多候选工作流 | `src/workflow/optimization-workflow-service.ts`、`src/exploration/dual-exploration.ts` |
| 结果与交付 | `src/core/experiment-result-view.ts`、`src/delivery/export.ts` |
| CLI 契约测试 | `tests/cli-command-contract.test.ts` |

## 已验证命令

最近验证过：

```powershell
npm run typecheck
node --import tsx --test --test-concurrency=1 tests/cli-command-contract.test.ts tests/cli-server.test.ts tests/project-cli.test.ts tests/v2-cli-workbench.test.ts tests/v2-result-view.test.ts
git diff --check
```

收尾时还需运行 `npm run build`、`npm test`、`node scripts/package-cli.mjs` 和 `node scripts/verify-cli-install.mjs`，并检查 VS Code 扩展打包。

## 待办

1. 清理所有当前指南、状态和交接文档中的旧命令文字。
2. 完成上述全量验证，确认安装包中的帮助和版本均为 `0.4.0`。
3. 在授权条件满足后进行真实模型、ARM/SSH、Windows TTY 和 VS Code Extension Host 验收。
4. 审核 dirty changes 后形成提交；推送到 GitCode 前再次核对远端分支和提交内容。

## 不可破坏的约束

- 不把凭据、API Key、原始秘密或未经验证的 hash 写入配置、日志、上下文和交付包。
- 不猜测 source/baseline、远端路径、采样身份或 ResourceGrant。
- 候选补丁必须绑定冻结源码身份；正确性失败不能继续性能阶段。
- 导出不修改源码，不自动提交、合并或推送。
- 远端状态不明时保持 `RECOVERING`，不伪造取消成功或自动重跑。
- 不覆盖当前工作树已有修改，不执行硬重置。
