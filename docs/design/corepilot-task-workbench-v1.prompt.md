# CorePilot 工作台效果图：生成记录

生成方式：内置 imagegen；新图生成，无输入参考图，无后续编辑。用途：已确认的首版视觉基线，不代表网页已经实现。图片中的日期、任务、候选和测量值都是演示。

图片：[corepilot-task-workbench-v1.png](corepilot-task-workbench-v1.png)。实施方案：[网页工作台 V1](../architecture/web-workbench-v1.md)。

以下为生成时的提示词。实际实现遵守方案中的真实数据与图表口径，不机械照搬图片的占位文本。

```text
Use case: ui-mockup.
Create one high-fidelity, beautifully polished desktop web application screenshot for the real product "CorePilot", an open-source AI-assisted CPU performance engineering workbench. This is an initial visual concept for discussion, NOT a marketing landing page. The user will deploy it on a persistent Linux server and access it with a desktop browser. Show the optimization task detail/workbench screen. Flat, straight-on entire interface, wide landscape approximately 16:10, high resolution, crisp legible typography including excellent simplified Chinese. No laptop mockup, no perspective, no collage, no external annotations, no oversized promotional headline.

Design language: restrained premium engineering tool, calm near-white and very light cool-gray backgrounds, white panels with 1px soft gray borders and subtle 8px corners, dark slate typography, one cobalt-blue accent, emerald only for successful status and amber only for running. Beautiful spacing, precise column alignment, balanced density, ample breathing room, refined small outline icons. Inter/SF-style Latin + clean Chinese sans. Strong hierarchy without clutter, no decorative gradients, no neon, no floating glass panels, no huge metric tiles. Comparable polish to a well-designed professional developer workspace. Chinese is the primary UI language with English technical IDs. Make the content readable rather than filling with tiny pseudo-text.

App layout:
- Slim left sidebar about 210px wide, subtle pale slate background. Top small clean abstract geometric mark and "CorePilot" wordmark. Below project switcher "IPPI-FT". Nav with outline icons and Chinese labels: "项目概览", "优化任务" (blue selected), "实验分析", "优化报告". Lower separator and secondary "模型与机器", "项目设置". Bottom small green dot "服务器在线", smaller "2 台 Runner".
- Top bar: breadcrumb "IPPI-FT / 优化任务 / OPT-024", right an outlined small capsule "演示数据" (MUST visible to establish all values are illustrative), a search icon, a help icon and small user avatar.
- Main page header generous whitespace. Title "Dilate3x3 性能优化" with adjacent soft amber status "独立复验中". Subtitle monospace "ippiDilate3x3_64f_C1R". At right understated outline button "查看报告" and secondary outlined "取消任务" (no destructive red fill). Context line small tags "S5000C", "CPU 0", "NUMA 0", "1 thread".
- Thin horizontal workflow stepper across main content: "源码调查", "候选实现", "正确性", "性能测试" each completed green tick; "独立复验" active blue/amber circle; "报告与审阅" neutral future circle. Connect with elegant thin lines.
- Compact four-column summary strip, not big card-dashboard: labels "当前候选" / "正确性" / "首轮加速比" / "已运行"; values "C003" / "19 / 19" / "1.28×" / "08:42". Subtle context under performance "复验完成后确认". Keep all numbers explicitly illustrative through the global demo badge.
- Main body two columns, about 65% left / 35% right. Left upper panel header "执行进度", small live dot and "正在运行"; a clean vertical timeline with 5 rows: completed "调查热点与数据访问", completed "候选 C003 已冻结", completed "正确性测试通过" detail "19 个用例全部通过", completed "首轮性能测试完成" detail "6 个 workload · 1.28×", active "独立复验" detail "正在测量 medium_wide · 4 / 6". Each row has small status icon, restrained timestamp on right. Below a collapsed-style calm footer "查看完整日志" with chevron, not a black terminal dominating the page.
- Left lower panel "Workload 性能对比" with small subtitle "首轮结果 · 相对 baseline"; horizontal paired baseline gray and candidate blue bars for only four readable workloads "small_square", "medium_wide", "large_square", "large_tall"; ratios "1.12×", "1.31×", "1.24×", "1.36×" aligned at right. Small blue/gray legend. Do not invent confidence intervals. A compact "查看 6 个 workload" link. Avoid random decorative charts.
- Right upper panel "候选方案", three neat list rows "C001" with muted amber "正确性未通过", "C002" with neutral "已比较", "C003" highlighted pale blue with blue selection outline and "复验中". Include a terse hypothesis per row, such as "减少重复读取", "调整循环边界", "复用邻域最大值". Only a modest file-link "查看源码差异" at bottom.
- Right lower panel "运行配置". Aligned label/value pairs: "模型" "可切换模型", "目标机" "S5000C", "Baseline" "已固定", "Evaluator" "Qualified", "资源" "1 thread · NUMA 0". Bottom small text "批准后单独交付源码". Clear professional tool content, no vendor model logos.

Keep screen composed and realistic with everything aligned on an 8px grid, main content generous margins. Footer tiny restrained "所有数据为界面演示". The visual should immediately communicate a usable engineering product with clear next action, pleasant light mode, visually organized trustworthy experiment results. All specified Chinese text should be accurate and readable. Do not show a chat-bubble-first assistant UI or a generic SaaS analytics dashboard.
```
