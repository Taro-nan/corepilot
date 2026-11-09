# 准备正确性与两库性能测试

CorePilot 的测试准备流程是：选择函数和机器 → 准备比较基线 → 确定测试条件 → 接入测试代码 → Runner 试运行。源码接入后可以先准备正确性测试；生成两库性能代码前，需要固定比较基线和资源/API 条件。代码起草不要求候选产物已构建，也不要求执行机器此刻在线；真正运行时必须完成构建、连接机器并验证产物。已有方案可复用，候选迭代期间不重新生成测试标准。

## 网页操作

打开左侧独立的“构建与验证”页面，选择本项目的方案和函数。没有可用方案时，从“创建优化任务”也会进入测试准备。

1. 在“准备比较基线”选择“从 Git 分支构建”或“导入外部库”。已有基线显示来源和固定身份，可直接进入测试准备，需要替换时点击“更换比较基线”。正确性参考单独定义，性能基线不会自动成为正确性 oracle。
2. 打开“配置当前函数的测试方案 → 1 测试条件”，在性能负载表中填写尺寸、数据类型、布局等输入。可以复制一行后修改尺寸，新增输入参数支持数字、文本和开关。
3. 在“线程与绑核方案”点击“配置多线程与绑核对比”，多选线程数，并按已连接机器的真实 NUMA 节点添加绑核方案。预览会列出每组实际 CPU 集合。输入只填一次，后端按输入 × 线程 × 方案展开；两端始终使用相同资源。
4. 选择“快速检查”（1 次独立预热、每端 3 个样本）或“重复测量”（3 次独立预热、每端 9 个样本），确认计时范围。预热、采样、样本内调用次数、固定种子和测量顺序位于“高级采样设置”。预设仅在主动点击时生效，既有草稿不自动改动。正确性输入和误差在“正确性测试与误差规则”中编辑；两端 API、产物路径和计时约定在“测试程序接入”中编辑。保存条件后准备代码。
5. 已有测试时分别上传入口脚本，并在“构建测试程序与支持文件”上传构建入口、C/C++、Python、头文件或数据文本。缺少哪部分，就生成哪部分：正确性代码与两库性能代码可以分别请求 AI。生成前可填写“生成提示词（可选）”；留空时根据当前源码、函数和配置直接生成。
6. 查看代码，保存草稿，进入“3 试运行与对比”。可先只跑正确性，或直接试运行正确性加两库性能对比。修改未保存内容后，需要先保存。

点击“用 AI 生成正确性代码”直接调用已配置模型，不要求先起草或采用一份方案。提示词可补充覆盖重点、参考方法和诊断要求；提示词留空也能生成。生成上下文包含选定源码版本中的 API/实现/既有测试、已保存的逻辑输入、资源条件和可获取的机器/工具链信息。CLI 与网页使用同一路径。

已有明确的输入参数、独立参考、容差、资源条件和性能输入由后端保留。缺少的正确性用例、参考或容差可随代码一起起草，待用户查看后保存；只剩 pattern 名称、缺少具体数值构造方式时，模型同时补齐确定的数据生成规则。新建议会展示在生成结果中，尚未保存，不改变既有测试标准或授予资格。已有数据生成规则保持原值。

数据生成规则保存在 evaluator 的 `correctness/input-generation.json`，按逻辑输入 ID 记录索引、公式/固定值、数据类型转换及填充方式，随测试包导出、快照和摘要固定。Runner 的用例清单继续使用原有格式；`TestContext.input_id` 将执行用例映射回逻辑输入，`TestContext.input_generation` 提供对应规则。一个逻辑输入覆盖全部已选线程/绑核组合，代码生成不受“12 个用例”的限制；最多 12 条只用于没有实际输入时建议的新逻辑输入。

“用 AI 生成两库性能代码”同样直接调用已配置模型。脚本按 Runner 在运行时传入的 `artifact_path` 分别测试 BASELINE/CANDIDATE；控制端 Windows 基线文件由 Runner 上传流程准备，代码中不硬编码其路径。已有负载参数、名称、权重、关键负载标记、线程、CPU/NUMA、采样和 seed 均保留。只有名称而没有参数的负载可随代码起草明确尺寸与构造规则；这类补全属于待保存建议，不从 `small-64` 等名字猜测已有输入含义。新的计时说明与负载参数可在“查看生成草稿的性能负载与计时方式”中审阅。

性能数据规则保存为 `benchmark/input-generation.json`，以逻辑 workload ID 关联，随完整测试包及摘要固定，`TestContext.input_generation` 在性能模式也可读取。内核计时排除准备/分配，并优先使用原生调用循环避免 Python 调用开销；每个样本的调用次数、预热与采样次数来自已保存计划，生成代码不另加采样轮次或自行调整资源。输出单位为每次调用的秒数。是否满足该口径仍须结合实际代码与目标机运行检查。

性能输入和正确性输入分别保存，也可明确点击“使用性能输入作为正确性输入”复制。`review-required`、`No trusted oracle exists`、`UNKNOWN_REVIEW_REQUIRED` 是待补全的占位信息，代码提交时会校验是否已补全。生成脚本发生在实际构建前，因此候选产物尚不存在、控制端基线路径为 Windows 路径、缺少性能 benchmark 等不会单独阻塞正确性代码起草。实际执行时由 Runner 构建并传入产物路径、准备依赖和独立记录测量身份。真正无法确定的 API/ABI 语义仍可返回具体问题，不会伪造通过结果。

需要先研究方案时，“正确性测试与误差规则”中仍可单独起草方案；这是可选功能。默认直接生成代码，查看、编辑、保存草稿后进入 Runner 试运行。

网页生成在后台进行，显示阶段、耗时和取消按钮。可以切换测试步骤、查看其他页面或刷新后返回；服务端继续执行并保留结果。取消会中止实际模型请求；服务重启导致无法取得结果时显示 `INTERRUPTED`，不自动重新消费模型请求。生成期间编辑了内容时，新结果单独保留，确认后应用代码；测试条件保持当前值。已保存的条件版本变更后需要重新生成。

每次生成记录请求的模型、实际发送的模型 ID、接口、请求次数、服务端返回的模型字段、请求 ID 和可获取的 token 用量。回执缺少的字段显示未知；请求 ID 可能来自响应头或响应体 ID，token 显示最近一次响应，不冒充多轮总成本。凭据不写入该记录。记录和结果位于项目数据目录的 `validation-generations/<id>.json`，通过 evaluator 摘要关联输入版本。旧版生成没有这些回执，不能由代码内容倒推当时服务端实际使用的模型。

AI 草拟时，系统提供标准 shell 入口和 `support/corepilot_test.py` 协议适配器。模型主要编写 `support/test-correctness.py` / `support/test-performance.py` 中的库调用、独立参考或计时逻辑；需要时增加 C/C++ 适配器和构建脚本。`TestContext` 统一读取清单、固定 seed 和条件，记录库与程序身份并输出测量 JSON，减少模型误写文件位置或结果字段的机会。控制机可用 Python 时先做语法和明显未定义全局名称检查，错误经 Pi 原生工具反馈交给模型修复；该检查不执行生成代码，不证明算法或计时逻辑正确。目标机试运行仍是必要步骤。

对已观察到的性能生成错误，静态检查还会反馈：把 Python/ctypes 调用开销算入内核计时、对已配置输入使用硬编码默认值、原生计时器返回总耗时却没有按调用次数归一化，以及支持目录中的构建脚本没有接入 Runner 实际执行的 `setup_script`。原生计时适配器约定返回循环总秒数，再由 Python 显式除以已保存的 `inner_iterations`。这些是生成期检查，不能代替目标机编译和运行。

动态库加载优先按公开 C 名称查找；若库仅导出 C++ 名称，协议适配器使用目标机的 `nm` / `c++filt` 查找名称精确匹配的唯一导出，并记录实际符号及声明。存在重载歧义时返回需要显式 ABI 适配器的错误，不猜测重载。参数/结构体 ABI 仍由测试程序明确声明，实际正确性依靠独立参考和目标机执行验证。

“查看或编辑测试代码”和“下载代码”优先显示实际执行的测试程序，例如 `support/test-correctness.py`，可放大查看完整内容。标准 shell 启动入口只校验参数并调用该程序，在“高级：启动入口”中查看。直接上传独立 shell 测试时，主要编辑区仍展示上传的脚本。生成记录与试运行代码视图也优先显示实际程序；单文件下载便于审阅，执行和移交时使用完整测试包以带齐配置与依赖。

尚未生成时显示“尚未生成测试程序”，不会把 `DRAFT evaluator is not executable` 占位入口当成生成结果。模型需要补充信息或调用失败时保留历史记录，页面显示具体状态；只有成功返回的实际程序才作为新代码展示。

生成复用现有 Pi 运行时，由它管理工具校验、错误反馈和原生 follow-up。说明文字不会被当作完成的代码；只有成功提交的代码草稿才返回页面。生成仍受模型配置中的输出预算、推理设置和超时约束。

模型适配层保留 Pi 的厂商思考参数格式。支持非思考工具提交时，请求直接输出工具参数；显式启用思考时保留普通工具选择与原生 follow-up，避免思考模式拒绝强制工具调用。生成成功只代表拿到代码，脚本是否能运行仍由下一步试运行确定。

## 性能负载的保存与 JSON 导入

高级 JSON 中，每行填写唯一的 `workload_id` 和 `parameters`。名称使用英文字母、数字、点、下划线或短横线，例如 `small-128`。参数值支持有限数字、文本和开关；多个尺寸拆成多行，复数等复合值拆成 `alpha_real`、`alpha_imag` 等独立参数，由测试程序构造实际输入。

省略 `threads`、`weight`、`critical` 时，同名已有负载沿用保存的设置；新增负载默认 1 线程、权重 1、非关键负载。执行矩阵仍按用户选择的线程和绑核方案展开，这些默认值不改变已有采样、种子或资源条件。明确填写的 0 权重、非法线程数、重复名称或嵌套参数会被拒绝，不静默改成默认值。

网页应用 JSON、保存表格和 CLI/API 保存使用同一套校验。错误指出具体行和字段，失败不覆盖已保存版本。API 返回 HTTP 422 和 `INVALID_VALIDATION_INPUT`，便于自动化入口识别输入问题。

## 分支基线的真实机器构建

“在执行机器上构建这个分支”固定所选本地分支的 commit，使用 `git archive` 导出源码，通过 Runner RPC 上传、核验 SHA-256，在执行机器解包并提交原有 `DEVELOPMENT_FEEDBACK` Experiment。控制端不创建该分支的 worktree，因此 Linux 源码中的长路径无需在 Windows 上检出。未提交的本地修改不属于该分支归档。

分支基线构建与正确性/两库试运行共用构建隔离处理。直接的相对 CMake `-B` 构建目录会映射到本次运行独立的 `build/`，避免使用源码归档中带来的旧 `CMakeCache.txt`。编译器、选项、目标和并行数保持原值；原命令与实际执行命令分别记录。测试产物也同步映射，例如配置中的 `build/lib/libexample.so` 会从本次运行的 `build/lib/libexample.so` 读取，而不是读取 `source/build/` 下的旧文件。自定义脚本、heredoc 或显式外部目录按现有命令执行，可使用 `COREPILOT_BUILD_ROOT` 指定独立构建树。

每次运行使用独立目录；工作区根由维护者登记的机器配置决定：

```text
<workspace>/projects/<项目名>-<项目ID前8位>/
  branches/<分支可读名>-<分支摘要前8位>/runs/
    <UTC时间>-baseline-<commit前8位>-<运行ID前8位>/
      source/          # 固定版本的源码
      build/           # 本次运行的独立编译输出
      artifacts/       # 本次新生成或改变的库/可执行产物副本
      logs/stdout.log
      logs/stderr.log
      logs/artifacts.json
      run.json         # 源码身份、机器、命令、状态、产物与日志位置
      source.tar.gz
      source.json
```

页面展示这次实际的服务器目录、机器、分支、完整 commit、构建命令和日志，可复制目录及查看历史构建。`logs/` 中保留完整输出，页面滚动读取最新部分。UTC 时间后缀 `Z` 对应服务器和本机所在时区的实际同一时刻。

“本次基线构建设置”默认复用该分支最近一次设置，首次采用接入方案的构建定义。标准 CMake 配置命令中的相对 `-B` 目录，以及对应 `--build`、`--install` 目录，默认映射到本次运行的独立 `build/`。切换新分支、复用旧的失败命令和 CLI/API 直接提交均应用同一规则，避免使用源码中跟踪的历史 `CMakeCache.txt`。页面展示转换后的命令；后端在提交时也执行同一转换。调整只随这次基线构建保存，后续同分支可复用；不改写候选优化的 Package 构建定义。编译器、编译选项、构建目标和并行度由使用者控制，例如：

```sh
cmake -S "$COREPILOT_SOURCE_ROOT" -B "$COREPILOT_BUILD_ROOT" -DCMAKE_BUILD_TYPE=Release
cmake --build "$COREPILOT_BUILD_ROOT" --parallel 8
```

这两个变量由分支构建注入，分别指向本次 `source/` 和 `build/`；`COREPILOT_ARTIFACT_ROOT` 指向 `artifacts/`，可供自定义构建直接输出文件。自动转换保留编译选项及源码内工作目录；多个 CMake 构建树分别映射到 `build/`、`build/tree-2/` 等目录。显式的绝对路径或自定义变量按原命令执行。脚本文件、heredoc 和复杂 shell 程序按库约定填写，需通过上述环境变量自行指定输出目录。

成功后选择“本次构建产物”，再明确点击“固定这次构建为比较基线”。系统只收集本次新生成或改变的产物并记录 SHA-256，不把源码中原有的旧 `.so` 当作新构建结果。构建成功不自动替换基线，也不代表正确性、性能或方案资格已通过。失败、重试和其他分支分别保留自己的记录与目录。

CLI 走同一 API，可使用本机脚本文件提供多行构建命令：

```text
corepilot project baseline-branch <project-id> <package-id> <version> <target-id> --branch main --build-script baseline-build.sh --build-cwd . --request-id <本次唯一标识>
corepilot project trial-status <project-id> <trial-id>
corepilot project baseline-freeze <project-id> <trial-id> --artifact build/lib/libexample.so
```

源码上传和日志需要新版 Runner 的 `source_archive_upload`、`execution_logs` capability。维护者部署 Runner 时让其 `--workspace-root` 覆盖登记的工作区。历史目录继续保留。

## 导入外部比较库

外部库与 Git 分支是同一目标的两种基线来源，选一种固定即可。外部库中的单个 `.so`、多个依赖库和头文件统一进入一份导入清单，不再分别配置“单文件基线”和“多文件比较包”。

1. 填写库名称和实际版本，选择库文件（可多选）或已解包的文件夹。页面列出动态库与头文件数量、大小和文件清单；README 等其他文件会显示为已忽略。当前接收 `.so`、版本化 `.so` 和 `.h/.hpp/.hh`，压缩包、RPM、DEB 请先解包。
2. 上传文件。只有一个动态库时自动选为入口；有多个时由使用者明确选择“用于对比的入口库”。其他动态库与头文件仍属于同一导入。
3. 点击“在执行机器上检查兼容性”。Runner 在所选 Linux 机器上核验实际字节身份、ELF 架构、动态依赖和未解析符号。缺少依赖时，可在这次导入中补充文件并重新检查；追加文件会作废旧检查。刷新页面后可以继续尚未完成的导入。
4. 检查通过后，明确点击“固定为比较基线”或“替换当前比较基线”。上传和检查均不切换当前基线。固定后显示库名称、版本、来源、入口、文件数量、SHA-256 和检查时间，下一步配置两端 API、用例、负载和资源条件，再生成或上传测试代码。

导入及检查记录保存在当前项目数据目录的 `baseline-bundles/<id>/`。文件、所选入口、检查结果、执行机器与最终绑定分别记录。执行机器/连接、文件或入口变化需要重新检查；导入期间若当前基线被其他操作替换，旧导入不会覆盖新的选择。检查通过只证明该机器上的运行兼容性，不授予 evaluator qualification、正确性通过或性能收益。

后端复用 `BaselineBundleService` 和现有 Package/evaluator 绑定。浏览器分步调用：

```text
POST baseline-bundles                 # 创建导入，记录当前选择的身份
PUT  baseline-bundles/<id>/files       # 流式上传 .so / 头文件
GET  baseline-bundles/<id>             # 清单、入口候选、持久化检查状态
POST baseline-bundles/<id>/check       # 兼容性检查，不修改当前基线
POST baseline-bundles/<id>/bind        # 使用已核验的文件与入口固定基线
```

路径均位于 `/v1/projects/<project-id>/`。`GET baseline-bundles` 通过 `package_id`、`package_version`、`target_id` 筛选导入记录。CLI 的 `baseline-upload` 和 `baseline-bundle` 是明确的“导入、检查并固定”命令，兼容入口 `finalize` 编排相同的 check/bind；单文件也经过相同的 Runner 检查。失败返回非零退出码并提供导入 ID 和诊断。既有固定基线继续可读，不批量改写历史数据。

## 测试资源的执行

Runner 统一施加 CPU affinity、NUMA CPU/内存绑定和线程环境，并记录实际资源。当前 UI 使用同 NUMA 节点的 `cpunodebind + membind`；未提供跨节点或 interleave 策略。CPU 集合必须属于选定节点。离线识别、模型建议和填写配置都不代表已执行。

绑核方案支持“按线程数限制 CPU 数”（N 线程使用 CPU 池中编号最小的 N 个 CPU）和“始终使用整个 CPU 池”。可在高级项自定义 CPU 池和 OpenMP `close` / `spread`。这里的 CPU 编号是操作系统逻辑 CPU，不能据此推断物理核心或缓存拓扑；OpenMP 放置只适用于遵守该设置的运行库，不保证任意线程库的逐线程映射。内存固定绑定到方案选择的单个 NUMA 节点，当前不支持跨节点内存策略。

可选择 1..16 个不同线程数、1..8 组绑核方案，每类输入展开后最多 200 条；保存前检查单次总命令数不超过 2048。线程数不能超过任一方案的 CPU 池容量。规模预览包含构建、正确性、预热和双方样本，避免无意启动过大的组合。

保存的 `test-plan.json` 可含 `execution_matrix.thread_counts` 与 `execution_matrix.profiles`。每个 profile 明确 `id`、`name`、`cpu_set`、`numa_node`、`cpu_allocation`（`per_thread` / `shared`）和 `omp_proc_bind`（`close` / `spread`）。实际 inventories 使用 `<输入ID>--<方案ID>-t<线程数>`，并记录 `execution.input_id` 和 `execution.profile_id`。脚本按收到的实际 ID 查询展开清单；AI 同样获得这份真实清单。API 的编辑视图折叠为一份输入，不重复展开。CLI 使用同一 JSON 契约；旧版单一资源草稿继续按原有逐行线程方式运行。

矩阵执行要求 Runner 报告 `capabilities.resource_matrix = 1`，旧 Runner 会明确提示更新。每组结果展示输入、方案、线程、CPU、NUMA、中位数和原始样本；不同条件的样本分别统计。声明、施加、观测资源保留在原有命令及 Experiment 记录中。

控制面使用同一个 evaluator 计划展开器，按负载、预热和采样逐次调用两端。可以选择固定“基线先”或按样本序号交替先后；顺序可复现。原始耗时采用秒/次调用，页面展示双方样本、中位数和比值；不把该比值标为置信区间。

固定种子、每样本调用次数和计时范围同时写入 `test-plan.json` 并通过环境变量传入测试代码。脚本应按清单处理实际输入；Runner 核验输出的参数、测量身份、库文件身份、单位和资源记录。代码是否正确实现算法语义与计时范围，仍需审阅和目标机验证。

## 测试程序约定

| 入口 | 位置参数 |
| --- | --- |
| `scripts/build-evaluator.sh` | `runtime_root` |
| `scripts/run-correctness.sh` | `case_id artifact_path threads runtime_root` |
| `scripts/run-performance.sh` | `phase role workload_id artifact_path iteration_index threads runtime_root` |

`COREPILOT_TEST_ASSETS_ROOT` 指向输入清单、脚本和 `support/` 所在目录；`runtime_root` 用于编译输出。当前库源码根路径通过 `COREPILOT_CANDIDATE_SOURCE_ROOT` 提供；两端产物通过 `COREPILOT_CANDIDATE_ARTIFACT`、`COREPILOT_BASELINE_ARTIFACT` 提供，实际测量仍使用脚本收到的 `artifact_path`。

`COREPILOT_TEST_SEED`、`COREPILOT_INNER_ITERATIONS` 和 `COREPILOT_TIMING_SCOPE` 是保存的输入条件。测试程序按调用次数计时并除以调用次数；kernel 模式排除输入准备和格式转换，end-to-end 模式包含这些操作。两端采用相同口径。

正确性或性能采样输出一行 `COREPILOT_MEASUREMENT ` 加 JSON。包含测量类型、角色、用例/负载 ID、样本序号、结果/耗时、单位、有效性，以及 `domain_payload.parameters`、实际产物身份和测试程序身份。预热不输出留存样本。仅退出码 0 不代表正确性通过。

## 版本、查看和下载

每次保存按 evaluator 内容摘要留存版本。提交试运行时在后台准备前复制测试方案，并固定源码、基线、机器和条件；之后编辑不会影响该试运行。可以从当前编辑区下载脚本，或下载已保存的完整测试包；试运行详情和正式任务详情可以查看、下载实际引用的版本。

下载包包含 `evaluator/` 下的原始文件以及独立的 `context.json`。后者记录导出上下文；试运行下载包含实际使用的基线与机器记录。evaluator 摘要只覆盖原始 evaluator 内容，比较基线和机器由实验另外固定，不混成一个身份。下载包不包含模型/Runner 凭据或库二进制。

## CLI 与共享 API

```text
corepilot project validation <project-id> <package-id> <version> <target-id>
corepilot project validation <project-id> <package-id> <version> <target-id> --file <草稿.json>
corepilot project validation <project-id> <package-id> <version> <target-id> --propose
corepilot project validation <project-id> <package-id> <version> <target-id> --accept-plan <generation-id>
corepilot project validation <project-id> <package-id> <version> <target-id> --generate --scope correctness
corepilot project validation <project-id> <package-id> <version> <target-id> --generate --scope correctness --prompt "重点覆盖边界尺寸，失败时输出实际值与参考值"
corepilot project validation <project-id> <package-id> <version> <target-id> --generate --scope performance
corepilot project validation <project-id> <package-id> <version> <target-id> --download tests.tar.gz
corepilot project trial <project-id> <package-id> <version> <target-id>
corepilot project trial <project-id> <package-id> <version> <target-id> --compare
corepilot project trial <project-id> <package-id> <version> <target-id> --calibrate
corepilot project trial-status <project-id> <trial-id>
```

保存 JSON 使用 `expected_digest` 对照读取时的 `evaluator_digest`，避免覆盖他人的新版本。CLI 也可以直接读取导出草稿中的 `evaluator_digest` 作为保存前提。`--generate` 默认只生成正确性代码，不保存；`--scope both` 可补齐两者。普通 trial 只试运行正确性，`--compare` 执行双方性能采样。

浏览器与 CLI 都调用项目下的 `validation-assets` 和 `validation-trials` API，不另建运行时或事实数据库。Runner 需报告 `capabilities.controlled_validation = 1` 并启用资源约束，才能执行该受控试运行。

网页点击试运行后立即显示提交状态；取得试跑 ID 后，每 2 秒读取准备阶段、Runner 当前步骤、已用时间、已完成的正确性结果和有效性能样本。可展开查看 Runner 最新输出；原始命令记录保留供排查。正在执行时，试运行按钮会暂时禁用，刷新或重新进入页面会恢复最近一次试跑。CLI 的 `trial-status` 通过同一接口读取执行中的已有测量，不必等待全部结束。

分支构建或试跑的创建响应丢失时，网页保留随机请求标识，并提供“核对上次请求”。若原作业已经创建，页面打开原作业；若尚未找到，也不能假设原请求不会到达。可选择“关闭未创建的请求”：它会与在途创建原子竞争，只有作业尚未创建时才关闭，已创建的作业不会被取消。浏览器仅在本机 localStorage 保存请求标识及页面所属的项目、方案和用途，不保存构建命令或配置；清除浏览器站点数据、更换浏览器或设备会丢失这一恢复入口。多标签页同时各自发起的操作可能使用不同标识。

CLI 的 `project trial` 和 `project baseline-branch` 可使用 `--request-id <唯一标识>`。首次执行前自行生成并保留标识，例如 `node -p "crypto.randomUUID()"`；响应丢失后以完全相同的参数和标识重试，返回原试跑，参数变化会报冲突。需要新试跑时使用新标识。未提供 `--request-id` 的旧调用仍按每次新建处理。请求登记和关闭栅栏需要数据目录所在文件系统支持原子硬链接；不支持时会报错，不会降级为可覆盖写入。

试运行属于 `DEVELOPMENT_FEEDBACK`，完成后保持 DRAFT，不自动授予 qualification、正式 Evidence 或 Human Approval。

「测试条件」还可编辑语义覆盖与已知错误实现检验；「重复测量」启用真实统计区间；第 3 步可做 A/A 同产物校准。校准不替代两库资格试跑。完整操作、排队恢复和版本约定见[性能可信度与复现](performance-assurance.md)。

两库对比完整通过后，“保存并运行前检查”会显示“试跑已通过，请确认测试方案用于正式优化”。选择“查看试跑并确认测试方案”，进入第 3 步的“审阅并启用测试方案”：核对正确性参考与误差、两端代码、比较基线、采样与执行条件、构建命令和可修改源码范围，填写审阅人，再点击“确认启用并运行前检查”。系统留存明确的人类决定，更新当前函数的资格记录并继续同一套运行前检查，无需重新生成代码或重复试跑。

确认绑定精确 evaluator 摘要、Package 内容和试跑 ID。系统检查两库采样齐全、正确性通过、有效资源观测及真实机器身份；代码、测试条件、基线、构建或机器发生变化时会给出对应下一步。审阅回执与原始测量保存在 Package 的 `onboarding/validation-review-<target>/`，摘要写入 evaluator 的 `qualification.json`；测试内容摘要不因确认而改变。多个目标分别确认，其他未确认函数仍可编辑和试跑。已确认版本保持只读。

CLI 使用相同接口：`corepilot project validation-review <project-id> <package-id> <version> <target-id>` 读取待审内容；把该 JSON 保留为文件，补充 `reviewer` 和 `confirm: true`，再用同一命令加 `--file <人工确认.json>` 提交明确决定。HTTP 为该函数 `validation-assets/<package>/<version>/<target>/review` 的 GET/POST。资格证据来自已通过的受控试跑；这些开发测量仍不是 Formal Evidence，也不表示已经批准优化代码或执行合并。正式优化继续使用独立且合格的 evaluator，以及同一套资源、负载和采样定义。


网页使用同一生成服务的后台接口（位于该函数的 `validation-assets/<package>/<version>/<target>/` 下）：

```text
POST generate                         # {scope, instructions?:"用户提示词", background:true}；默认 TEST_CODE
GET  generations                      # 历史状态与模型回执
GET  generations/<id>                 # 当前状态与完成后的代码草稿
POST generations/<id>/cancel          # 请求停止实际模型调用
POST generations/<id>/adopt           # {expected_digest}，人类采用已查看的正确性方案草稿
```

CLI 的 `--generate` 直接生成代码，`--prompt` 可选；`--propose`、`--accept-plan` 保留为单独方案研究入口。它们与网页调用同一服务、模型适配器和 Pi 循环，保留相同回执及本次提示词；起草和生成不会自动保存、执行或取得 qualification。单独方案的采用决定保存在 Package 的 `onboarding/correctness-plan-review-<generation-id>.json`，含旧/新测试摘要、源码 commit 和时间。
