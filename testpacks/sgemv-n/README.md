# Testpack: SGEMV-N

单精度实数 GEMV-N（`y = alpha*A*x + beta*y`）的测试资产包。

- 状态：**draft**（未 frozen）
- function_family: GEMV，operation: N，data_type: single precision
- API：`cblas_sgemv`（列主序、CblasNoTrans）
- 最终内核符号：`sgemv_n`（`source/kernel/arm64/gemv_n.S`）
- 源仓库：`D:/Projects/phytium/blas_ft/source`，branch `opt/blas/sgemv/v2`，commit `5e55d54192e3f9b9c876f989b78a43e937ad670d`

## 结构

```
draft/
├── manifest.json                     主清单（资产哈希、case、oracle、证据、调用链）
├── assets/                           导入资产（correctness/benchmark/script/documentation/historical）
├── cases/cases.json                  oracle 用例
├── oracle/oracle.json                oracle 规范（provisional 容差）
├── evidence/historical-evidence.json 历史证据分层 + 服务器产物
├── guards/forbidden-artifacts.json   禁止产物（DGEMV load_interleave）
└── qualification/qualification-report.json
```

## 命令

```bash
phyopt testpack import   --manifest testpacks/sgemv-n/import-manifest.json
phyopt testpack inspect  --path testpacks/sgemv-n [--json]
phyopt testpack qualify  --path testpacks/sgemv-n [--json]
```

## 资格状态

Day 4 最高 `PROVISIONALLY_QUALIFIED`（本地 oracle 自检通过；目标 ARM 执行仍 pending）。未在目标环境执行前不得标记完全 QUALIFIED。

## 注意

- 资产为二进制复制，source/imported SHA-256 一致。
- 历史 CSV 仅作 imported historical evidence（`UNVERIFIED_IMPORT`），不能用于 PhyOpt 最终效果验收。
- `/tmp/gemv_n_load_interleave` 为禁止产物（DGEMV 库，forbidden_for SGEMV）。
- 所有服务器路径 `UNVERIFIED_REMOTE_PATH`，执行前需现场核对。
- oracle 容差（atol=rtol=1e-4）为 provisional，Day 5 冻结前确认。
