# 离线核验证据归档

取得 `COREPILOT_EVIDENCE_JSON_GZIP_V1` 文件后，从可信渠道另行取得该文件的 **archive SHA-256**，在安装了 CorePilot 的机器执行：

```text
corepilot evidence verify ./evidence.json.gz --sha256 <可信渠道提供的归档SHA256> --json
```

这条命令无需连接 CorePilot 服务、模型或 Runner。它不解包到文件系统，也不执行包内脚本。输出是 JSON；成功时 `ok` 为 `true`，退出码为 0；失败时退出码非 0，使用 `--json` 时错误以 JSON 输出到标准错误。

核验内容包括提供的归档 SHA-256、内置清单摘要、每个归档文件的长度和 SHA-256、文件名安全、证据记录类型，以及证据中任务、候选、提交、正式实验与复验的指定身份关联。旧版证据记录未单独写入 Candidate tree 时，输出会明确列出该字段尚未由证据记录绑定。CLI 不输出源码、命令日志或整个原始 JSON。

应使用 `snapshot.artifact.archive_sha256`，不是 `snapshot.artifact.digest`（后者是文件清单摘要）。已连接服务的用户可用 `corepilot workflow evidence <workflow-id> --output <文件> --json` 下载并查看该字段；在跨边界交付时，预期归档 SHA-256 仍应由审阅者通过可信渠道独立取得。

当前离线入口最多读取 **256 MiB 压缩包、512 MiB 解压后 JSON、25000 个文件**。超过上限会停止核验，不表示归档无效。现有服务端审批仍使用原目录核验，历史格式的读取语义保持不变。

完整性一致不代表内容或来源可信，也不代表统计方法、实验有效性、目标机器执行、人工批准或交付已通过核验。冻结归档产生于批准之前，不包含之后的审批决定。归档可能包含源码、机器信息、命令输出和其他敏感数据；本命令不做脱敏，成功也不意味着归档可以公开。CorePilot 当前没有通用的公开脱敏证据包。
