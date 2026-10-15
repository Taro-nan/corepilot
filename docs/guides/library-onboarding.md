# Library Onboarding Draft

`corepilot package init <repo-path>` 只读调查源码仓库，生成可审阅的 Library Package Draft 后停止。正式接入的后续步骤见[生命周期指南](optimization-workflow.md)。

## 两种调查方式

```text
corepilot package init /path/to/new-library
corepilot package init /path/to/new-library --target public_symbol
corepilot package init /path/to/new-library --id my-library --version 0.1.0 --target public_symbol --config phyopt.yaml
corepilot package init /path/to/new-library --output-root /path/to/phyopt-catalog
```

路径、package ID 和 symbol 是使用者提供的值，以上不是本轮执行的命令。

| 输入 | 实际行为 | Target 选择 |
| --- | --- | --- |
| 无 `--config` | 确定性、离线的 inspector，不调用模型 | 可以用 `--target` 选择公开 API inventory 中已发现的 symbol；未指定时保持待选 |
| 有 `--config` | 使用配置中的 Pi model 与可选 scoped proxy，通过受控工具调查 | 有 `--target` 时仍须有公开 API evidence；未指定时提供候选供 Owner 选择，不擅自选定 |

`--api-key` 仅能和 `--config` 一起使用。模型配置、凭据和 SSH/Runner endpoint 不进入 Package。调查记录会保存实际 agent identity，但这不是模型运行配置。

## 受控工具与发现边界

Pi 使用现有 Agent runtime，工具为 `list_files`、分段 `read_file`、`search_code`、`inspect_git`、`inspect_build_system`、分页 `inspect_public_api`、`inspect_tests`、`inspect_benchmarks`，以及只提交结构化决定的 `submit_onboarding_findings`。没有 shell、源码写入、`run_build_probe` 或 `run_test_probe` 工具。

Git 仓库从 tracked regular files 调查，非 Git 目录使用受限枚举；未跟踪或被忽略的资产不应假定已被调查。读取有文件数、大小和分页限制，路径、链接和源文件变更有检查。Draft writer 拒绝把输出写到源码仓库内部，产物写入指定 catalog，已有文件不静默覆盖。

| 调查项 | 当前产物 | 不能据此推导的结论 |
| --- | --- | --- |
| Build | Make/CMake/Meson/configure/shell、README/CI 等静态线索及候选命令；状态为 `DISCOVERED` | 没有验证构建成功、compiler flags 或环境完整；没有自动 probe |
| API / implementations | 从公开 header 和源码文本匹配 symbol、实现文件与架构文件，附静态 confidence | 不是完整调用图、准确动态 dispatch 或经过 profiling 确认的热点 |
| `call_path` | header 与匹配到的 implementation files 列表 | 不能当作编译器或运行时证明的调用链 |
| Tests / references | 候选 correctness assets 与 reference 线索，保存发现依据和审查状态 | existing test 不等于 Formal Correctness Evaluator，也不证明 oracle 独立或正确 |
| Benchmarks | benchmark 文件、参数、输出和 workload 线索 | existing benchmark 不等于合格的 Formal benchmark |
| Candidate scope | 已选 target 匹配到的实现文件，排除发现的测试、benchmark、reference 与 build evidence | 不代替 Owner 的最小范围审查；未知 target 使用 `REVIEW_REQUIRED_SOURCE_FILE` 占位 |
| Dependencies | 语言、头文件、版本与依赖文本线索 | 不证明目标机依赖或 loader closure 已满足 |

Build Draft 的内容也是 proposal：Make/CMake/Meson 使用已有生成规则；CMake 的 `cmake --build build` 不代表 configure 已完成。未知 build 或 configure 路径可能生成 `false` 占位，custom script 也未经执行。Owner 必须确认完整命令、cwd、toolchain、options 与环境后才可冻结 build policy。实现见 [repository-inspector](../../src/onboarding/repository-inspector.ts) 和 [draft-writer](../../src/onboarding/draft-writer.ts)。

## Draft 结构与信任边界

默认输出当前 CorePilot catalog；`--output-root` 改为该目录下的 `packages` 与 `evaluators`：

```text
packages/<id>/<version>/
  package.json
  build/discovered.json
  development/tests.json
  development/benchmark.json
  onboarding/evidence.json
evaluators/<id>-<target>/<version>/
  manifest.json
  qualification.json
  correctness/...
  benchmark/...
  scripts/...
```

Package `qualification.state` 和 Evaluator `qualification.status` 都保持 `DRAFT`。Evaluator skeleton 含 `UNKNOWN_REVIEW_REQUIRED`、待审 case/workload 和 proposal；正确性、性能脚本主动 `exit 1`。Manifest/digest 合法仅供加载审查，不赋予 Formal 执行资格。

`onboarding/evidence.json` 保存 repository/agent identity、inspected file hashes、build/API/test/benchmark/reference/dependency evidence、scope proposal、unknowns、risks 和初始 `PENDING` human decisions。完整 transcript 或源码内容不直接作为正式知识。

Package qualification 和 Evaluator qualification 分开记录。Loader 的 `requireQualified` 当前检查引用的 Evaluator，没有同时强制 Package state。人工 review 要求仍须明确，不能写成当前已有自动 Package approval 或同等强制门禁。详见 [Package 的资格与 Task](library-packages.md#资格与-task)。

## 从 Draft 到正式任务

Owner 需要审阅 build command、optimization target、candidate scope、独立 oracle、tolerance、workloads、baseline、acceptance policy 和 resources。随后由操作者组织 Baseline/Build Freeze、Evaluator 静态与真实目标机 qualification，Owner 再显式批准。Onboarding 结束时不启动优化、不自动 Qualified，不执行领域 Approval Record 或 CLI merge。

`fixtures/example-vector-repo` 用于离线/Pi 工具、Make/CMake、API/test/benchmark 发现、Draft、源仓库只读和新增 catalog 不改变 Core/Workflow/Runner 的测试验证，不宣称具备真实 Formal baseline。

IPPI 的初始调查记录仍保留；当前 `ippi-ft@0.1.0` 已选定 `ippiDilate3x3_64f_C1R`，Package 与对应 Evaluator 均为 QUALIFIED，已形成 [C002 Approved Result](../../examples/ippi-dilate3x3-success-case/README.md)。从 Draft 到该结果的 build、qualification、修复与审批包含人工和操作脚本，不能倒推为 Onboarding 自动完成。

HMiPPI/external binary baseline 的资料保留在[历史调查索引](../history/legacy-and-external-baselines.md)，不是当前 IPPI self-baseline 的前置依赖，也不表示 Formal binary-bundle staging 已完成。
