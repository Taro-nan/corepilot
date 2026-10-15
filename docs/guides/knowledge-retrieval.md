# 候选生成知识检索

> 历史资料：本页保留旧知识检索设计与使用说明，不作为当前 Onboarding、Hypothesis 优化或 Approved Result 的前置条件，也不表示本轮新增 Search/RAG 能力。当前流程见[生命周期指南](optimization-workflow.md)，历史定位见[资料索引](../history/legacy-and-external-baselines.md)。

PhyOpt 在候选生成前会从本地审核知识目录检索与任务相关的证据。该能力是受控上下文，不是联网搜索，也不会授予模型新的工具或文件权限。

## 数据链路

`/optimize` 或单候选生成会把优化目标、函数名、源码文件、目标架构、目标硬件和冻结源码 commit 组成查询。检索器只返回：

- `review_status=reviewed` 的记录；
- 来源哈希校验通过的记录；
- 与目标架构、硬件、函数、场景和源码版本相容的记录。

本次运行的记录会按分数和 ID 稳定排序，并限制记录数量与上下文大小。所有候选共享同一个冻结知识快照。

模型收到的是带 `<knowledge-record>` 边界的只读证据文本；它必须在 `hypothesis.observed_evidence` 中引用上下文里的精确 ID。D11 结构化门禁会再次拒绝未知 ID、越权文件和受保护路径。

## 来源解析

开发或项目运行时，种子记录的相对来源相对于 `project_root` 验证。也可以通过 `OptimizationWorkflowService` 的只读 Retriever 注入项目自己的审核目录；注入不会改变资源授权或实验门槛。

CLI 打包时会生成 `dist/knowledge/catalog.json`，只包含 build-time 已验证的记录和摘要哈希，不包含 `evidence/` 原始日志或大型 `source-archives/` 文件。安装包运行时优先校验该不可变目录；目录缺失或篡改时回退到本地来源验证。

## 无匹配时的行为

无适用知识不是错误。系统仍保留 `source:frozen` 源码证据锚点，并继续执行现有候选门禁、构建、正确性、性能和独立复验流程；不会编造知识或降低门槛。
