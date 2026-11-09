# 从网页接入一个新库

“构建与验证”配置四件事：如何编译源码、如何确认结果正确、如何采样性能、与哪个固定版本比较。普通操作使用可读命令和分项状态，底层继续保存同一份 CorePilot 项目配置，网页与 CLI 不建立独立执行链。

## 新库的默认入口

1. 添加源码项目，配置模型并选择已注册执行机器。
2. 打开左侧独立的“构建与验证”页面，默认选择“为当前库建立接入方案”。
3. 点击“识别源码与测试资产”。系统只读调查当前工作区，记录源码版本、构建方式、API、测试和 benchmark 线索；不调用模型、不执行仓库命令。
4. 在“怎样编译这个库”选择左侧最近实际执行过的命令、右侧结合当前源码与所选执行机器生成的推荐，或点击“自定义构建”填写完整命令。没有本库构建执行记录时，左侧会明确显示暂无；历史失败也按失败展示。推荐会读取源码根目录构建定义与 Runner 实测的编译器、构建工具、架构、CPU 和内存，不会把测试目录中的 Makefile 当成整个库的入口。推荐始终标记“尚未构建验证”。选用与保存都不会启动构建。
5. 在“要优化的函数”中按名称、头文件或实现文件搜索，勾选一个或多个公开 API；可批量选中当前筛选结果，在“已选函数”中复核。单份草稿最多选择 50 个函数。生成后，一个 Library Package 包含这些目标，每个目标有独立的 DRAFT evaluator；后续每次优化任务仍明确选择一个目标。未选择函数时保留待选目标，不擅自选定。C/C++ API 自动发现受静态解析能力限制；其他语言的构建识别不代表其测试或 API 已自动接入。
6. 按草稿补齐本库的独立 oracle、正确性与容差、benchmark、workloads、采样、资源和基线产物。完成主文档规定的人工审阅与真实目标机 qualification 后，再选择该方案开始正式优化。

生成草稿后，页面会切到该 Package 的第一个目标。在“配置当前函数的测试方案”中，按“测试条件 → 测试代码 → 试运行与对比”操作。先通过表格确定输入、线程、CPU/NUMA、种子、采样和容差，再上传已有测试或让 AI 分别补齐正确性/两库性能代码。AI 不修改用户的实验条件。批量目标分别保存；保存留存内容版本，并拒绝覆盖他人的新摘要。完整操作和脚本接口见[测试方案指南](test-plans.md)。

选中草稿后，即使比较基线还没准备好，也可以先保存项目配置。缺失的基线会列为待配置，正式优化提交仍会校验基线绑定、Package 和 evaluator 的资格。

“在 Runner 上试运行两库对比”提交一个 `DEVELOPMENT_FEEDBACK` 实验：接口先返回 ID，后台把固定源码、测试版本和比较基线暂存到机器，完成构建后按确定的条件执行正确性、双方预热与采样。也可只试运行正确性。页面显示日志、实际资源、逐负载原始样本、中位数和比值，并提供实际版本的代码查看与测试包下载。刷新可找回最近试运行；准备期间 Control 重启会显示状态未知，不自动重复提交。仅退出码 0 不表示测试通过。开发记录不授予正式资格；真实执行由 Runner RPC 完成。

比较基线支持三种来源：选择另一**本地** Git 分支，在执行机器上运行该 Package 的构建命令，查看结果后点击“固定这次构建为比较基线”；上传外部库的单个产物；或上传已经解包的外部库文件夹。分支构建不会切换原源码目录，下载时核对 Runner 与 Control 的 SHA-256；再次固定同一次构建会复用已经核验的副本，副本发生变化会被拒绝。

多文件比较包先填写库名与版本，选择包含 `.so` 动态库与 `.h/.hpp/.hh` 头文件的目录，再选择入口库。当前目录入口要求预先解包 RPM/DEB，不直接安装这些软件包。Control 保留相对目录和每份文件的 SHA-256，Runner 在真实 Linux 目标机核对 ELF 架构、动态依赖及未解析符号。相同内容的动态库别名可以共存，同 SONAME 的不同内容会报告冲突。检查失败会列出需要补齐的依赖，并保留之前的项目基线；检查通过才把包清单和入口绑定到当前 DRAFT Package。仅通过依赖检查不授予 Package/evaluator qualification。正式执行前会重新暂存整个包、检查目标机和运行时依赖身份，实验使用入口库的 SHA-256，Package 同时保存完整包摘要。包里的不同 API 仍需由当前 evaluator 脚本明确适配，不因文件上传而自动得到正确性或性能结论。

源码调查识别 Make、CMake、Meson、configure、自定义构建脚本，以及根目录中的 Cargo、Go、Python、Bazel 和 Ninja 构建定义。机器推荐目前支持源码根目录的 CMake、Meson、Make、configure、Cargo、Go 和 Ninja；其它发现结果只作为线索。CMake 推荐会核对最小版本、源码所需 C++ 标准、OpenMP 选项、编译器与生成器，并按机器可用并行度和内存设置构建并发。未知构建工具可使用自定义命令，通用核心不按库名分支。

源码识别结果持久化在该项目的数据目录；刷新可继续查看。它记录的是调查时的工作区，不代表其他分支已验证，也不代表存在完整调用图。调查不修改源码或自动替换项目当前的验证来源。

## 接入状态如何理解

- **待配置**：缺少命令、测试方案或基线。
- **已配置**：输入已接线，或文件身份已核对；不表示编译或实验已经成功。
- **待审阅与验证**：草稿、独立测试、负载或基线身份尚需完善。
- **需要修正**：方案无法解析、文件无法读取或基线身份不一致。

“保存配置”会刷新分项状态。“保存并运行前检查”先保存配置并检查接入进度：未生成或选择方案时，显示缺项和“选择函数”“继续本项目已有草稿”等操作；DRAFT 方案会引导编辑脚本、准备基线和 Runner 试跑。页面会列出本项目已经生成的函数草稿，由用户明确选择后继续配置。已配置的验证来源继续使用与优化任务相同的严格预检规则。检查不调用模型、不执行构建、不授予资格或批准；开始正式优化仍必须通过原有完整预检。真实脚本执行使用上面的 Runner 开发试跑入口。

## 已有项目与复用方案

“选择已有库接入方案”要求用户明确选择库、版本和函数，不自动选中目录中的第一个方案。比较基线文件应位于运行 CorePilot 后端的服务器能够读取的位置，身份与方案一致。原有 YAML / JSON testpack 可通过“导入测试方案文件（高级）”继续使用。普通 CTest 文件、单条测试命令或 benchmark 输出不等同于 CorePilot 验证方案；正式 RPC 仍要求独立且合格的 evaluator。

生成的接入草稿保持 DRAFT。当前自动生成器提供构建定义、发现证据和 evaluator 骨架；**不会自动完成 oracle、benchmark 适配、基线冻结或目标机 qualification**。这是必须按库完成的实际工作，不能把一个库的用例套用到另一库。

## CLI 与 API

```text
corepilot project setup <project-id>
corepilot project setup <project-id> --inspect
corepilot project build-options <project-id> [machine-id]
corepilot project validation <project-id> <package-id> <version> <target-id>
corepilot project validation <project-id> <package-id> <version> <target-id> --generate
corepilot project validation <project-id> <package-id> <version> <target-id> --file draft.json
corepilot project trial <project-id> <package-id> <version> <target-id> [--branch <name>]
corepilot project trial-status <project-id> <trial-id>
corepilot project baseline-branch <project-id> <package-id> <version> <target-id> --branch <name>
corepilot project baseline-freeze <project-id> <trial-id>
corepilot project baseline-upload <project-id> <package-id> <version> <target-id> --file libreference.so --library-name HMPPI --library-version <version>
corepilot project baseline-bundle <project-id> <package-id> <version> <target-id> --directory <已解包的库目录> --entry lib/libreference.so --library-name HMPPI --library-version <version>
```

前者返回已保存配置的分项状态，第二条重新进行只读源码识别；`build-options` 读取同一项目的真实构建执行记录与所选机器上的 Runner 工具链，均输出 JSON。网页与 CLI 使用相同 Control API：

- `GET /v1/projects/:id/setup`
- `POST /v1/projects/:id/source-inspection`
- `GET /v1/projects/:id/build-options`，可带 `machine_id` 查询未保存的机器选择；只读，不执行构建。
- `POST /v1/projects/:id/discover`，可带 `symbols: string[]`、`build_command`、`build_cwd`，生成待审的批量目标草稿。旧的单目标 `symbol` 仍可用，但不能与 `symbols` 同时提交。响应含 `targets` 和 `evaluator_paths`；原有 `evaluator_path` 保留为第一个验证资产路径。
- `GET/PUT /v1/projects/:id/validation-assets/:package/:version/:target` 读取或保存 DRAFT 验证资产；`POST .../generate` 返回未保存的 AI 草稿。
- `GET/POST /v1/projects/:id/validation-trials` 列出最近试跑或提交脚本试跑、分支基线构建；`GET .../:trial` 查看准备状态与 Runner 记录；`POST .../:trial/freeze-baseline` 固定成功构建的分支产物。
- `PUT /v1/projects/:id/baseline-upload` 以二进制请求体上传单文件产物；库身份由查询参数提供，最大 512 MB。
- `POST /v1/projects/:id/baseline-bundles` 创建多文件上传；`PUT .../:bundle/files?path=...` 流式上传单份文件；`GET .../:bundle` 读取清单与入口选择；`POST .../:bundle/finalize` 携带 `entry_path` 在 Runner 检查后固定比较包。单文件最大 512 MB、整包最大 1 GB、最多 256 个库或头文件。

项目数据目录中的新接入方案，会被同一实例的状态检查、运行前预检和优化提交共同解析。无需依赖某个预置库，或依赖启动终端碰巧设置了全局 catalog 环境变量。
