# 网页工作台：启动、使用与 Linux 部署

网页与 CLI 连接同一个 CorePilot Control 服务，共用 `/v1` API、SQLite、项目配置、优化执行链和报告。`corepilot web` 就是现有 `serve --web` 的入口；生产环境只需启动这一个 Node 进程。

## 从源码启动

要求 Node.js `>=22.19.0`、Git；Control 需要 SSH/scp 时安装 OpenSSH 客户端。目标机的编译器、算法库依赖和 Runner 按原有[优化流程](optimization-workflow.md)准备。

```bash
npm ci
npm run build
export COREPILOT_SERVER_TOKEN='<自行设置的私有访问凭据>'
node dist/entry.js web --host 127.0.0.1 --port 4317 --data-dir ./corepilot-data
```

浏览器打开 `http://127.0.0.1:4317`，输入上述凭据。数据目录可以指定为持久化的绝对路径。默认是 `~/.corepilot`，数据库是该目录的 `workflow.sqlite`。监听非回环地址时必须设置 `COREPILOT_SERVER_TOKEN`。本地回环地址也支持不设置凭据直接使用。

项目配置统一使用 `corepilot.yaml`。启动时，系统会迁移数据目录中原先由工作台托管的项目配置文件名，并同步更新项目与历史任务的配置路径，保留配置内容和实验身份；手工导入的外部配置不擅自移动。用户设置使用 `~/.corepilot/`，环境变量统一以 `COREPILOT_` 开头。未获资格的旧草稿在保存时更新脚本和清单的协议并生成新摘要；已冻结测试资产按原清单读取，不改写既有证据。

前端开发时，另一个终端运行 `npm run dev:web`；Vite 的 `/v1` 请求代理到 `127.0.0.1:4317`。部署时使用 `npm run build` 的静态资源，不启动 Vite。

Windows 上后台启动的 SSH/scp、Git 和打包子进程应隐藏控制台窗口，输出继续由工作台日志收集。用户手动打开的启动终端可保持显示。更新后端代码需要重启 Control 服务才能应用；刷新网页只更新页面。常规更新应安排在当前优化任务结束后。

重启已有服务时沿用原 `--db` 和 `--data-dir`，避免切换到另一个空数据库。例如原数据库是仓库下 `.corepilot/workflow.sqlite` 时，停止旧服务后在仓库根目录执行：

```text
node dist/entry.js web --host 127.0.0.1 --port 4317 --db ./.corepilot/workflow.sqlite --data-dir ./corepilot-data
```

## 第一次使用

项目概览展示项目的默认分支、执行机器和目标函数，点击任一项可直接更换并保存，用于后续任务；已有任务保留创建时的条件。分支选择只列服务端已有本地分支，不会切换源码工作区。函数可从已识别源码或当前接入方案中选择，也可手动输入；识别结果来自当前检出版本，其他分支需要另行核对。目标函数与现有测试方案不一致时，页面提示准备匹配方案，不能直接提交优化。这里的“已配置”只表示设置齐备；提交时仍检查源码、方案和机器。最近任务只展示少量记录，统计入口可进入对应筛选列表；完整历史保留在“优化任务”。源码路径、配置文件、运行前检查与只读源码调查放在“项目详情与诊断”。

常用模型来源、Key 和模型 ID 直接展示。代理、推理强度、厂商 Endpoint 和工具调用验证位于“高级连接与诊断”，收起后仍显示当前配置摘要。自定义模型的 Endpoint 直接显示。模型连接在项目设置中维护；默认机器可从概览或项目设置更换，使用同一配置。注册机器、部署连接等位于“系统维护”。配置中的凭据不放进浏览器持久草稿；有未保存配置时刷新会提示。

1. **添加项目**：填写服务器可读取的源码目录，或点击“浏览”打开独立文件夹选择器。左侧是用户目录、服务启动目录、最近项目和 Windows 盘符 / Linux 根目录；右侧列表单击选中、双击进入，也可点击行尾箭头进入。顶部支持前进、后退、上一级、可点击目录层级和完整路径输入，搜索框筛选当前位置的子文件夹。底部始终显示将要选择的路径；确认后回填，取消不改变原表单。检测到 Git 仓库后显示当前检出、各本地分支和最新提交，可选择默认优化分支。首次使用无需准备配置文件；已有 CLI 用户可展开“导入已有 CorePilot 配置（可选）”，填写 `corepilot.yaml` 的路径。留空则在数据目录创建项目配置，源码不因添加项目而改变。
2. **配置模型**：选择厂商或填写自定义 endpoint，填入 API Key（支持 `${ENV_VAR}` 引用）。模型列表自动加载，在“模型 ID”中直接选择；更改 endpoint、Key 或代理后自动更新，无需先保存。已有模型 ID 会保留，也可切换为手动输入；连接失败时可修正后自动重试，或点击“刷新模型列表”。列表加载不会保存其他配置或发起推理；“验证工具调用”仍需单独点击。
3. **选择执行机器**：维护者先在左侧“执行机器”注册 Runner，填写一次 RPC 地址、凭据与部署环境。项目用户在“模型与机器 → 目标机器”选择已注册机器并保存，即可复用连接，不再填写地址、Token 或 SSH。页面显示实际在线状态、架构、CPU 数、部署准备情况和最近检测时间；“检测所选机器”只读取服务与硬件，不调用模型或创建实验。详见[共享执行机器](execution-machines.md)。导入的旧配置保留原模式，选择已注册机器后才切换后续任务。
4. **构建与验证**：在左侧独立的“构建与验证”页面只读识别源码和测试资产，在“怎样编译这个库”比较最近构建命令与结合机器工具链生成的推荐；点击“自定义构建”才展开命令输入。生成接入草稿后，可按函数编辑或上传正确性与性能脚本，也可用 AI 起草；保存后在 Runner 上开发试跑。比较基线可从另一 Git 分支在目标机构建并固定，或上传外部库产物。页面展示已保存配置的缺失项；“保存并运行前检查”结果显示在按钮下方。完整步骤见[新库接入配置](library-setup.md)。
5. **创建优化任务**：在一个表单中确认函数、分支和执行机器。模型、比较基线和已保存测试口径直接复用；本次机器选择不更改项目默认值。提交前展示输入范围、线程/绑核、采样、误差和预算；调查入口、预算与是否测量性能放在“高级设置”，收起后保留摘要和调整标记。未提交的任务表单在当前浏览器标签页内保留，关闭弹窗或刷新后重新打开可继续。运行前检查核对本次所选机器，不会创建实验或调用模型。分支在提交时解析为固定 commit，候选在独立工作区优化，不切换原目录的分支。关闭或刷新浏览器不取消后台工作。
6. **查看实验**：任务列表可按状态、分支及函数名/任务 ID 查找，筛选条件保存在页面 URL，刷新与往返详情后保留。任务详情优先展示当前阶段、资源等待及适用操作；最近过程记录直接可见，完整 Agent 日志和阶段证据按需展开。结果分别显示实验执行、正确性、性能验收、人工批准和源码交付。首轮与独立复验不混合，退化与测试条件直接展示；逐负载数据使用表格，历史实验、原始样本、完整报告和身份标识可展开查看、复制或下载。旧任务标记已交付但缺少匹配的源码身份时，提示核对原记录，不再建议重复批准或合并；API 汇总状态为 `DELIVERY_UNVERIFIED`，原历史事实保持不变。
7. **审阅与交付**：“优化报告”提供适用范围和 Markdown/JSON 下载。任务详情中先点击“审阅与批准”，准备并查看或下载冻结证据，填写批准人及授权说明并明确批准；批准不会合并源码。之后点击“交付已批准候选”，填写提交说明并单独确认交付。系统核对当前正式实验、独立复验、证据和批准身份；不一致时暂停交付。目标分支已有工作区时保留无关本地修改，同路径冲突时保留候选并提示处理。

交付中断时，任务详情提供“核对交付状态”；系统核对原请求和目标 Git 分支，不自动重复合并。目标尚未更新且验证仍匹配时可继续；验证已变化时可撤回未完成请求并重新处理，历史请求仍可展开查看。若原 Git 进程终态未知，应先在运行 CorePilot 的机器上确认进程已停止。交付已记录但工作区存在需要保留的内容时，先处理这些内容，再点击“重新清理候选工作区”。

“调查源码”调用现有只读 onboarding，输出 Draft 及证据，写入持久化 catalog。它不会创建合格 oracle、授予 qualification 或替代 Human Review。正式新库接入仍按[库接入指南](library-onboarding.md)完成。

分支选择列出服务端仓库已有的本地分支及其 upstream，不自动联网 fetch。需要优化远端分支时，先在服务端获取并建立相应本地分支。普通源码目录和无提交的 Git 仓库仍可添加，首次优化沿用现有源码基线初始化流程。

文件夹选择器中，方向键选中，Enter 进入，Alt + 左 / 右箭头后退 / 前进，Alt + 上箭头返回父目录，Ctrl/Cmd + L 编辑路径，Ctrl/Cmd + Enter 确认选择，Esc 取消。单击选中的文件夹可直接确认，无需先进入该目录。列表有独立滚动区，手机上也保留固定的路径确认栏。最近项目来自现有项目记录，浏览不会新增项目或任务。

“导入已有配置”复用 CorePilot 的模型、目标机器、构建与验证设置。它支持绝对路径或相对源码目录的路径；后续在页面保存配置会更新所导入的文件。首次使用可留空，添加后分别在“模型与机器”和“构建与验证”页面完成配置。

预检提示“尚未配置测试方案”时，进入独立的“构建与验证”页面接入该函数的正确性测试、性能负载和比较基线。提示“测试方案文件不存在”时，核对 Control 服务器上的实际文件路径。源码中有 `ctest` 或 benchmark 程序，只说明有可接入资产，仍需整理为 CorePilot testpack 或对应 Package/evaluator；调查产生的 Draft 需要继续完善和验证。

模型 Key 和 Runner token 在网页读取配置时显示引用或掩码；同一模型 endpoint 下原样保存掩码保留原凭据。切换模型来源会清空原来源的 Key，使用新来源已存储的凭据、服务端环境变量或新输入的 Key。模型请求使用服务器的网络和代理配置。环境变量引用由 systemd 服务环境解析，不由浏览器解析。

配置页面会显示保存状态，未保存的草稿在本次页面会话中按项目保留，切换标签或页面后可以继续编辑。草稿不写入浏览器持久存储，刷新会清除；可点击“放弃更改并重新读取”恢复服务器版本。添加项目失败、检查失败或交付失败时，错误直接显示在当前表单中。断线时保留上次同步记录并显示重连状态。

Runner 连接正常只说明服务和协议可用，不等于正式实验已经具备运行条件、evaluator 已获资格或结果已批准。维护者修改地址或凭据后重新检测；Token 掩码只会在同一 RPC 地址下复用。新任务固定所选机器的配置版本，后续机器更新不改变已提交任务或历史报告。

SSH 部署、升级、排障和服务端传输环境由维护者管理，日常“目标机器”不展示这些设置。当前仍用 SSH/scp 暂存候选、evaluator 与 baseline；维护者在“执行机器”的部署环境中登记对应的连接和工作目录，并在服务端准备 known_hosts 与密钥。该机器的所有项目共享配置；部署环境未完成的机器会标记待准备，正式提交会提示维护者补齐。

运行前检查会使用创建任务表单中填写的目标函数；导入配置也可以使用相对源码目录的路径。本轮具体行为与验证说明见[网页联调记录](../development/frontend-integration-review.md)。

报告是持久化事实的只读快照。兼容 testpack 若只报告总退出码而缺少逐 case 证据，或复验记录不完整，页面明确显示无效/不完整；原始速度值保留用于诊断。源码人工合并与冻结 Evidence 的领域 Approval 记录分别展示，报告下载不授予任何批准。

测试覆盖与错误实现检验、Runner 排队、真实统计区间、A/A 测量校准，以及报告中的冻结源码重建复现，见[性能可信度与复现](performance-assurance.md)。这些入口复用同一后端，不需要另一套 CLI 服务。新增队列与复现能力需要相应版本的 Runner；本轮不制作离线部署包。

## 用 CLI 操作网页中的项目

下面的命令在服务器或另一台已安装 CorePilot 的机器上执行。使用同一个服务地址和管理员凭据即可，不要求客户端拥有服务器源码或配置文件。

```bash
export COREPILOT_SERVER_URL='https://corepilot.example.com'
export COREPILOT_SERVER_TOKEN='<与网页登录相同的私有访问凭据>'
corepilot project list
corepilot project add --name my-library --root /srv/sources/my-library --branch main --config /srv/config/corepilot.yaml
corepilot project inspect <project-id>
corepilot project check <project-id>
corepilot optimize --project <project-id> --branch feature/simd --performance --watch --output ./report
corepilot workflow list
corepilot workflow status <workflow-id>
corepilot workflow report <workflow-id> --output ./report
corepilot workflow cancel <workflow-id>
```

`--project` 的路径在服务器解析，函数可从验证配置读取，也可明确指定 `--function`。它与读取客户端文件的 `--config` 模式互斥。网页创建的任务和 CLI 创建的任务使用同一组 workflow ID，可相互查看、取消、下载报告和人工交付。

`project add --branch` 设置项目默认分支；`optimize --branch` 覆盖本次任务的分支，`--config` 模式也支持。未传入分支的历史项目和 API 请求继续沿用原来的当前检出版本语义。

已有 `--config`/TUI 入口保留。要共用记录，两端必须指向**同一个 Control 实例和数据库**；网页不会自动合并历史上散落于各项目 `.corepilot/workflow.sqlite` 的数据库。需要查看某个旧数据库时，可停下原实例后对它运行：

```bash
corepilot web --db /srv/old-project/.corepilot/workflow.sqlite --data-dir /var/lib/corepilot
```

旧记录按原 ID 和路径读取；项目可导入对应原配置。不要并发启动两个 Control 写同一数据库。

## Linux 常驻部署

仓库提供 [systemd unit](../../deploy/linux/corepilot.service)、[环境变量示例](../../deploy/linux/corepilot.env.example)、[Caddy 示例](../../deploy/linux/Caddyfile.example)和 [Nginx 示例](../../deploy/linux/nginx.conf.example)。

推荐目录：

```text
/opt/corepilot/releases/<release>/   程序、生产依赖、web/dist、deploy
/opt/corepilot/current              指向当前程序目录的符号链接
/var/lib/corepilot/                 workflow.sqlite、projects、catalog、worktrees、reports
/etc/corepilot/corepilot.env        管理员凭据与模型/Runner 环境变量
/srv/sources/                      源码仓库（可另行指定）
```

先建立专用账户和目录，再将已构建的发行目录放入 `/opt/corepilot/releases/`，创建 `current` 链接。下面以已经准备好的 `/opt/corepilot/releases/0.4.0` 为例；版本目录可以带构建号。

```bash
sudo useradd --system --create-home --home-dir /var/lib/corepilot --shell /bin/bash corepilot
sudo install -d -o corepilot -g corepilot -m 700 /var/lib/corepilot
sudo install -d -m 755 /opt/corepilot/releases /etc/corepilot
sudo ln -s /opt/corepilot/releases/0.4.0 /opt/corepilot/current
sudo install -m 600 /opt/corepilot/current/deploy/linux/corepilot.env.example /etc/corepilot/corepilot.env
sudoedit /etc/corepilot/corepilot.env
sudo install -m 644 /opt/corepilot/current/deploy/linux/corepilot.service /etc/systemd/system/corepilot.service
sudo systemctl daemon-reload
sudo systemctl enable --now corepilot
sudo systemctl status corepilot
journalctl -u corepilot -f
```

环境文件中的占位符必须替换；可用 `openssl rand -hex 32` 生成随机值。unit 使用 `/usr/bin/node`，应先确认该路径版本符合要求；Node 安装在别处时调整 `ExecStart`。源码、导入配置和 baseline 必须可由 `corepilot` 用户读取；Git 仓库与候选交付需要该用户的写权限。

以服务账户准备 SSH 公钥、known_hosts 和所需 Alias，并以同一账户测试到目标机的连接。服务不依赖管理员当前终端的 SSH Agent 或环境变量。Runner 仍是目标机独立服务；Control 的登录 token 与 Runner RPC token 用途不同。

公网/内网浏览器访问可由 Caddy 或现有 Nginx HTTPS 服务转发到 `127.0.0.1:4317`。保留原始 `Host` 和 `X-Forwarded-Proto`；它们用于同源写请求校验与 HTTPS 会话 cookie。V1 在域名根路径提供服务，不支持挂在 `/corepilot/` 等子路径下。

## 打包、升级与备份

```bash
node scripts/package-cli.mjs
node scripts/verify-cli-install.mjs
```

发行包 `build/corepilot-0.4.0.tgz` 包含后端、`web/dist`、生产依赖、Package/evaluator、使用指南和部署模板。解压后不需要下载前端依赖或现场编译网页；Node 运行时和 Git/SSH 不包含在 CLI 包中。建议在部署平台制作并验证离线包。

升级前通过网页或 `corepilot workflow list --json` 确认没有活动 Agent/实验，停止服务，再切换程序版本。数据目录独立于 release，不因换版本而移走。历史候选工作树包含对源码仓库的引用，源仓库也应保持原路径。

停服务后一致性备份示例：

```bash
sudo systemctl stop corepilot
sudo tar -czf /srv/backups/corepilot-$(date +%Y%m%d-%H%M%S).tgz /var/lib/corepilot /etc/corepilot
# 源码、导入的外部配置、baseline 和 output_dir 位于上述目录之外时，另行纳入同一备份。
sudo systemctl start corepilot
```

浏览器重连会继续读取同一份记录。当前 Pi Agent 会话不能在 Control 进程崩溃后自动续跑；页面与 CLI 会指出尚未被当前进程接管的活动记录，保留实验与日志，不自动重复启动远端实验。应核对原 Runner Experiment 后决定后续工作。正式实验的身份和状态仍按现有 RPC 契约处理。

## 开发验证

“构建与验证”现在支持编辑或上传测试脚本、让已配置模型起草验证草稿、在 Runner 开发试跑、构建另一 Git 分支作为固定基线，以及上传外部单文件或已解包的多文件动态库。网页和 `corepilot project` 命令共用项目 API、Package 与试跑 ID；步骤、脚本参数和上传要求见[库接入指南](library-setup.md)。试跑、依赖检查与正式实验资格分别展示。

```bash
npm run typecheck
npm run build
npm test
npm run test:web
git diff --check
```

浏览器测试使用本机 Chrome/Edge，或 Playwright 安装的 Chromium；可用 `COREPILOT_BROWSER_PATH` 指定可执行文件。Linux 上首次需要时运行 `npx playwright install chromium`。测试通过真实 HTTP、Git、Pi 协议夹具、子命令、SQLite 和报告验证网页/CLI 互通，不依赖付费模型或内部 ARM 机器。

`build/web-workbench-fixture.png` 是浏览器测试生成的实际页面截图，里面的实验来自离线测试夹具，不代表飞腾硬件性能。生产页面不内置演示任务或演示测量。
