# Changelog

JellyBot（对外品牌 Larry Agent）— 基于 Git 提交历史整理的项目建设 Change Log。
格式参照 Keep a Changelog；按版本节点划分，0.x 时代按里程碑归组。

---

## v1.6.9 — 2026-11-14

### 新增与改进
- **Skills 项目归属**：区分通用与项目技能，搜索、创建、更新和自动策展遵循项目范围；桌面端和 Relay 技能库同步显示归属
- **Skills 界面重构**：项目二级导航、Installed / Suggestions 页签、斑马纹列表、可展开详情与管理操作；名称行显示使用次数和成功率，支持 Light / Dark
- **Dev Mode 布局精修**：展开的底部面板与 Outline 使用独立圆角卡片；文档符号按类型着色，精简筛选和计数，优化详情抽屉、时间线及工具栏
- 编辑器支持内联代码补全，可通过 Escape 和右键菜单控制；统一各界面的下拉选择器
- **macOS Unreal**：自动识别 Epic 安装的引擎、选择平台构建脚本，支持系统 / Xcode lldb-dap；已安装的纯内容项目可直接启动
- 桌面端和 Relay 演示卡片支持最大化与 Escape 退出，内嵌示例同步响应退出操作

### 修复
- CoCo 在整个连续运行期间保持防休眠；发送消息时仅在新消息不可见时滚动到可读区域
- 完善技能目录提示、项目范围匹配与维护建议；改进 Outline 横向拖动、活动标签对比度和调试代码等宽字体

### 发布
- 版本统一至 1.6.9：macOS Apple Silicon DMG / ZIP、Windows x64、Linux arm64 agentd 与 Relay
- 官网 Skills、Dev Mode 交互示例复用最新客户端界面，补齐项目归属、使用统计、管理弹窗与独立面板布局；断点演示支持继续、单步、调用栈切换和变量展开

---

## v1.6.8 — 2026-11-11

### 新增
- **Unreal 多构建工作区**：选择构建目标与配置、识别引擎和进程、协调构建与调试活动
- 支持 .NET / CoreCLR 调试启动；跨工作区保留调试会话并提示会话所属工作区
- 编辑器新增独立断点栏；Dev Mode 面板改为带间距的圆角卡片，优化工具栏、标签与语言状态菜单
- 新增 `glob` 工具与工作区文件匹配；为 agent 提供仓库快照上下文
- Git / SVN 页脚显示待拉取提交或可用更新

### 修复
- clangd 按 UTF-8 字节解析消息，完善 C/C++ 签名帮助与补全
- 构建期间的调试取消与面板重入行为
- Windows 调试器升级至 23.1.1-larry.5，修正调试图标和等宽字体回退

### 发布
- 发布 macOS Apple Silicon DMG / ZIP 和 Windows x64 安装包；官网下载与两处客户端更新源同步至 1.6.8
- 官网 Dev Mode 演示复用完整客户端控制器，补齐工作区标题、胶囊、Composer、Outline 与 Quick Open
- GitHub Releases 下载完成全量校验，下载源与官网共 47 项在线检查通过

---

## v1.6.7 — 2026-11-09

### 新增
- **Skill 自我改进体系**：turn-end reflect gate v2、skill 工具（merge/deprecate/install）、使用量台账与策展流程
- Git bar 新增 Pull：合并冲突由 LLM 解决
- `run_dev_task` 工具接入 dev task runner；工具分类新增 development 图标
- Windows 调试器升级 23.1.1-larry.3，lldb-dap zip 打包 VC++ 运行时
- 文件树揭示 F12 / Ctrl+click 落点；CoCo 工作简报要求自然英文
- 根 CHANGELOG.md、官网 curated changelog 页、GitHub Releases 下载托管

### 修复
- CoCo turn-window 压缩；Git Pull 状态刷新
- relay web 控制台补 `deprecate_skill` 的 archive 图标

### 发布
- mac/win/relay 三平台构建 + web 部署；公开快照 v1.6.7

---

## v1.6.6 — 2026-11-06

### 新增
- **clangd 语义引擎集成**：C/C++ find-references、工作区符号接入 Quick Open、可取消的 go-to-definition
- C/C++ 补全链路：compile flags、索引符号、文本补全兜底
- CoCo 会话监督（supervision）与 hand-over 流程；新增 `coco_balance` 工具

### 修复
- 工作区删除时停止并清理隐藏的 `coco_internal` 会话
- relay web 客户端连接状态展示、品牌化刷新；安全卡片图标
- 官网首页/banner Windows 等宽字体栈修复（font audit R1/R2）

### 发布
- mac/win/relay 三平台构建 + web 部署

---

## v1.6.5 — 2026-11-04

### 新增
- 公开快照发布器（LarryAgent 仓库，含导出 manifest）
- 官网 About 页、relay demo、安全卡片图标
- FileReaderView 换用 Lucide 原始线性图标；图标页与 NewTask demo

### 修复
- 发布管线控制台文案英文化（chinese-text-watch run 5）
- 官网排除出公开快照；downloads manifest 跟踪 1.6.5
- 陈旧本地 manifest 时跳过 downloads-verify 单测

### 发布
- 三平台发布、relay 重部署、官网刷新

---

## v1.6.4 — 2026-11-03

### 新增
- CoCo 上下文压缩（compaction）
- EDG FSM action 节点 + 内置图谱（含测试）
- plan_execute 轮次效率收紧；新增 `plan_done` 节点支持 composer 退出
- Relay Web CoCo：协议镜像、设备桥、三栏 UI 对齐客户端；手机端层级（底栏 Tab + 全屏聊天页）；CoCo 磁贴严格跟随当前选中设备

### 修复
- coco web composer 发送在真实 DOM 下的崩溃
- 768px 以下 CoCo 空白面板；console web 部署不构建的发布坑

---

## v1.6.3 — 2026-11-03

### 修复
- 手机端 CoCo 磁贴严格跟随当前选中设备

---

## v1.6.2 — 2026-11-02

### 新增
- CoCo 工作结果（work results）、prompt 队列视图、共享 ask-user 面板
- 账本（ledger）驱动的自主唤醒，取代 check-in 机制
- v1.6.2 图标标识共享填充插画；FSM prompt-token 基线（ask-user schema）
- downloads manifest agentd 推进至 1.6.2；下载卡显示发布日期

---

## v1.6.1 — 2026-10-30

### 修复
- verify 分支闭包窄化适配 `exactOptionalPropertyTypes`

### 发布
- mac/win 安装包上线、console 静态刷新、docs write-back

---

## v1.6.0 — 2026-10-28

### 新增
- **CoCo 自动化套件**（自动化规则、运行界面、overview 排序）
- 设置页更新卡（Update card）+ 手动原地升级管线

### 修复
- 流式 reasoning 块可展开状态检测

---

## v1.5.x — 2026-10-20 ~ 2026-10-27（v1.5.0 ~ v1.5.10）

### 新增
- v1.5.0：**MCP Hub**（relay 端点 + Web UI + MCP 同步）；OpenAI Responses API 支持 + 合并工具行 UI；LLM 层重构为 adapter 架构 + apiDispatch；reasoning 范围绑定（防跨 Provider CoT 重放）；请求边界工具策略与工具执行检查点
- v1.5.1：字号缩放（fontScale）双端同步；PWA 图标 / standalone 缩放；客户端能力门控的桌面维护动作；细粒度更新进度（agentd 1.4.1 + console stepper）
- v1.5.2：会话加载失败视图的 Retry 按钮；免打扰修复等移动端体验
- v1.5.3：Windows 独立构建；`upload_files` Windows scp 回退；agentd 原子写 temp 目录修复
- v1.5.4：对话滚动视口 + 移动端布局重构；Windows rsync 打包；工具卡体虚拟化；Maintenance 按设备平台通道解析
- v1.5.5：**Skill Hub**（relay hub 端点/存储、zip 打包、桌面同步）；共享 SVG 图标系统（功能/工具双目录）；发布管线 + relay web 维护自动检查
- v1.5.6：移动端对话排版统一 13px
- v1.5.7：滚动自动跟随修复；`userPromptEdit` 重构为 `userPromptReclaim`
- v1.5.8：Thought 块排序修复；交互式 demo 卡片与可靠确认流（参数 popover 化）；会话自动打开最近交互；E2EE 等待 streamKey 修复
- v1.5.9：Dev Mode 图编辑器暗岛主题；Build 图标重绘
- v1.5.10：Tools 二级导航；Auto V2 demo-first 图谱；Dev Mode Deploy 按钮 + Safe Mode 审批卡

### 其他
- 移除 graphite 主题（仅 Dark/Light，旧 id 迁移）；截断 Thinking 短文本折叠；GLM 风格 reasoning 提取与 `reasoning_text.delta` 流

---

## v1.4.x — 2026-10-10 ~ 2026-10-19（v1.4.0 ~ v1.4.2）

### 新增
- **E2EE v1** 中继流加密；relay 运行条纹动画、终端镜像动画、plan 审批面板
- agentd 无头节点（远程维护）；OpenRouter / Qwen Code 用量适配器；托盘用量弹窗（含常驻模式与焦点模型重构）
- 多语言符号索引工具（symbols tool）
- 模型品牌图标扩充（Gemini、NVIDIA、MiniMax、Mistral 等）；设备执行沙箱（deviceExec sandbox）
- Token Provider Hub 同步（v1.3.6）；动作按钮色板与 token hub 重排；文件阅读器自定义 Windows 标题栏
- Subagents 独立窗口与 dev-mode 可执行启动；顶部渐隐、临时 Patch 失败行、子代理标签条

### 修复
- Responses 有状态默认值统一（显式落 false）；Windows 托盘右键双击；Responses Provider Stop 前内容回滚
- relay web 维护进度 tick 全量重绘；孤 workspace 会话按 raw-id 打开；跨设备 session not found

---

## v1.3.x — 2026-10-14 ~ 2026-10-15（v1.3.0 ~ v1.3.6）

### 新增
- VCS 凭证提示流（git push / svn）；SSH key 回退；SVN commit 支持
- Dev Mode 任务面板、Build/Run/Commit/Push 动作、VCS 元数据 watch、git gutter 标记、blame 注释、逐路径 commit 与 diff 编辑器
- 加密设置备份导出/导入；并排 diff 视图；Shell Safe Mode 设置移入 Settings

---

## v1.2.x — 2026-10-10 ~ 2026-10-12（v1.2.0 ~ v1.2.1）

### 新增
- relay 演示页清理；v1.2.1 为版本号纠错发布（由误标的 1.4.1 修正）

---

## v1.1.x — 2026-10-08 ~ 2026-10-09（v1.1.0 ~ v1.1.4）

### 新增
- **删除即总结**：session 删除时归档并 LLM 总结进 work history
- 自有通知系统 + `notify` 工具、菜单栏骨头图标；归档时设备快照
- memory 双端同步（relay v1.4.0 服务端 + 客户端归档同步）
- 内置 `loops` 工具（LLM 全量管理 Loops）；round_interrupted 流封口、通知提示音、狗头菜单栏图标

### 修复
- Stop 后重复 prompt 与打断插入边界；Agent→Plan 文档交接（revision 感知采纳）

---

## v1.0.x — 2026-10-04 ~ 2026-10-05（v1.0.0 ~ v1.0.2）

### 新增
- **首个公开发布线**：统一落地页（下载、星云背景）
- 高亮色设置；UBT 构建进度追踪（UE 构建 4h 超时）；DMG 双行标题
- Relay web 嵌入缩略图图片工具卡

---

## 0.x 时代 — 2026-07-21 ~ 2026-09-20（里程碑归组）

### 0.0.x / 0.1（07-21 ~ 08-02）项目奠基
- Bootstrap：Electron macOS agent shell；Session/Message 领域类型、工具注册表、流事件契约
- Agent 主循环接入桌面外壳；流式会话 + SQLite 持久化
- 多 Provider LLM 配置、`ask_user` 交互工具、权限分级（Level-1/2 内联审批卡）
- Projects 侧边栏工作区；图像附件 + vision 设置；Dev Terminal
- Plan 模式与 plan-and-execute 策略；MCP 服务器 + 每工具权限
- 上下文压缩：Hot/Warm/Cold 桶策略、Round Protect（后更名 iterationProtect）
- 子代理异步派发 / 批量 join / 优先级队列；PDF 工具与 Mermaid 渲染
- 设置自动保存；PROJECT.md 项目记忆；发布 0.0.2 ~ 0.0.4

### 0.2 ~ 0.4（08-07 ~ 08-19）FSM 工作流成型
- Turn 级 StateGraph → **FSM 成为默认工作流**（Neon 主题、图编辑器、pin 路由）
- plan_execute v2/v3、plan 文档门控、Socratic 评审轮、analyser 角色
- Skills 管理完整化（完整技能包 zip 安装、NodeActionPreferSkills 技能预检）
- `generate_image` 工具 + 独立 ImageGen Provider；多档 ImageGen profile（图生图 / 水印）
- **Loops**：daemon 定时后台 agent 运行、app-handoff、mid-turn prompt 编辑
- `turn_handoff` 工具；FIFO prompt 队列取代单槽 steer；自定义 FSM 图作为运行模式
- Hermes 风格 patch 工具取代 edit_file/append_file；S3/COS 对象存储附件
- 加密密钥存储；Shell Safe Mode；语音输入（push-to-talk）；注意力提示音

### 0.5 ~ 0.9（08-20 ~ 09-20）跨平台与 Dev Mode
- **Windows v1 支持**：平台门控、exec_command shell、自定义标题栏、托盘常驻
- **Dev Mode 工作台**（09-15 起）：Monaco 编辑器 + 文件树 + VCS 状态、任务面板、workspace 标签入标题栏、一键 commit
- **LLDB-DAP 调试集成**（09-19）：捆绑 lldb-dap 23.1.1-larry.2、UE 支持、惰性变量树、hover 求值、调用栈帧标记
- Electron CDP 调试；Node + Chrome web 调试配方；Unreal C++ 语言包（符号索引 / F12）
- Find Usages（Shift+F12）；双击 tab 切换 .h/.cpp；任务面板与终端合并为统一底部面板
- **Relay 远程 Web 控制台**（09-09 起）：远程设备/会话管理、渐进加载、live stream 渲染、移动端 UI 大规模适配、PWA、验证码 + 持久 IP 封禁
- Loops 调度器 in-app 化并跨平台启用
- 版本推进至 0.9.9（进入 1.0 公开发布）
