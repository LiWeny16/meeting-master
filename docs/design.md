# Meeting Master 产品与设计规范

> **状态**：旧版架构草案，仅作为 Windows 音频与数据边界的参考，不是当前实现权威。iFlytek/MiMo 云 provider 与 demo/simulated-service 假设已废止。当前实现范围见 [`docs/superpowers/specs/2026-10-10-meeting-master-native-cdp-design.md`](superpowers/specs/2026-10-10-meeting-master-native-cdp-design.md) 和对应计划：Tauri 2/Rust 原生基础、开发期 CDP MCP 桥、无伪造会议数据。后续按阶段接入真实 WASAPI、下载管理的本地 ASR 模型及 Claude/Codex/Pi CLI 探测；这些能力目前尚未实现。
>
> **版本**：第一版设计草案（审计修订稿）
> **目标平台**：Windows 10/11 优先，Tauri 2 + Rust + React + MUI  
> **产品形态**：本地优先的桌面会议助手  
> **配套图标**：[`docs/assets/meeting-master-icon.svg`](assets/meeting-master-icon.svg)

## 1. 产品目标与设计边界

### 1.1 产品承诺

Meeting Master 将电脑播放端（包括蓝牙耳机对应的系统输出 endpoint）和独立麦克风的声音分别采集，转成带时间线的实时文字，并在同一会话中提供：

- 实时、可修订的双语转写；
- 增量会议摘要、行动项和关键决定；
- 基于当前会话上下文的实时问答；
- 可搜索、可导出、默认保存在本机的会话历史。

产品不是蓝牙协议分析器，也不读取 A2DP/HFP 空口数据。Windows 第一版使用 WASAPI loopback 获取操作系统发送给所选 render endpoint 的数字 PCM，同时使用独立的输入 endpoint 获取麦克风 PCM。loopback 不是耳机单元实际声学输出的逐样本回采：蓝牙编码、耳机 DSP、音量、ANC 和佩戴状态仍可能改变人耳听到的声音。

### 1.2 已确认的技术方向

- **音频**：目标仍是 Windows WASAPI endpoint loopback + 独立麦克风输入；两路保持独立并保留来源标签，之后按统一时钟合并时间线。尚未接入实现。
- **音频处理**：采集回调只做快速复制；目标使用有界 ring buffer、格式转换、downmix、持久化重采样和可选 VAD，向本地 ASR 提供 16 kHz、mono、f32 PCM 块。尚未接入实现。
- **ASR**：方向改为可在本机运行、由 Settings 下载与配置的流式识别模型；应用不预置权重。具体模型/运行时以 Windows 实测、许可审查、模型校验和性能测试为准；历史候选不构成已选定或已验证的承诺。
- **Agent**：后续探测用户本机现有的 Claude、Codex、Pi CLI，并为实际可用的本地 CLI 提供明确适配器与数据流说明；不得伪造 CLI 存在或答案。CLI 可能连接云模型，发送会议内容前必须披露并征得同意。
- **前端**：React 只呈现真实状态、发起命令和消费事件；音频、模型文件、硬件检测、CLI 探测和持久化留在 Rust/Tauri 后端。开发期 CDP 只通过受保护的 loopback MCP bridge 对当前应用页面开放。
- **云 provider 假设**：旧版 iFlytek/MiMo 与 ECS 章节已退休，不是当前运行时依赖。任何未来外部 provider 都必须单独设计、明确数据授权并通过版本化协议与安全测试；未实现时显示不可用，不发送猜测请求。

### 1.3 首版不做的事

- 不做移动端或浏览器端实时采集。
- 不承诺捕获 DRM、独占模式应用、厂商特殊驱动或 HFP 通话路径中的所有声音。
- 不默认保存原始音频，不自动上传整段录音。
- 当前原生基础阶段不配置云 provider 凭据。后续发现本机 CLI 时，只探测可执行文件/版本并调用其公开命令接口；不得读取、复制或记录 Claude/Codex/Pi 等 CLI 的凭据库。若 CLI 会把会议内容发送到云端，必须在发送前披露目的地和数据范围并取得明确同意。
- 模型下载只能由 Rust 本地服务执行，后续需验证来源、版本、许可、文件大小与 SHA-256，使用临时文件原子安装，并支持取消、恢复和删除；此下载/校验能力尚未实现。
- 不把系统 endpoint loopback 误称为“只捕获某个会议应用”；如果需要进程级捕获，作为后续独立能力评估。

### 1.4 LetShare 视觉参考的诚实边界

用户希望产品受 [LetShare](https://github.com/LiWeny16/LetShare) 启发，但本轮 BrowserOS Neo 尚未连接，无法对该仓库进行视觉核验。因此本文**不声称复现 LetShare 的具体颜色、布局、组件、图标或交互**。本稿只采用“轻量、克制、围绕实时共享信息组织”的临时视觉方向；配套 SVG 是本项目原创矢量概念，不是 LetShare 素材的改绘。

待 BrowserOS Neo 可用后，须按本文末尾的核验清单逐项对比，并只吸收可验证的交互启发，不复制其品牌资产或未确认的实现细节。

## 2. 信息架构、路由与导航

### 2.1 应用外壳

桌面窗口使用单一 Tauri window，React Router（或等价路由层）管理内部路由。窗口标题随路由和会话标题变化，录音期间标题追加 `● 录制中`，系统任务栏/托盘图标也提供同样的非颜色提示。

```text
┌─────────────────────────────────────────────────────────────┐
│ 品牌/窗口区   [新建会议]  [会话库]  [设置]        状态/帮助 │
├───────────────┬───────────────────────────────┬─────────────┤
│ 应用导航       │ 当前路由内容                   │ 上下文面板    │
└───────────────┴───────────────────────────────┴─────────────┘
```

主导航只放三个长期入口：

1. **会话库**：所有已保存会话、搜索、筛选和恢复。
2. **新建会议**：打开录音准备流程，不直接开始采集。
3. **设置**：音频设备、provider、隐私与通用设置。

正在录制时，导航栏将“当前会话”置顶并显示计时器；离开实时页前必须经过有明确文案的保护确认，避免误停录音。应用关闭、窗口关闭和系统挂起均由会话协调器处理，不由前端直接杀死采集任务。

### 2.2 路由表

| 路由 | 页面职责 | 主要入口 | 离开规则 |
|---|---|---|---|
| `/library` | 会话列表、搜索、筛选、空状态、最近删除入口（可恢复） | 启动页、主导航 | 无未保存的实时会话时可自由离开 |
| `/meeting/new` | 会议标题、音频源、语言、翻译、隐私确认和设备测试 | “新建会议” | 通过“开始会议”创建 session；返回不创建数据 |
| `/meeting/:meetingId/live` | 实时转写、双语翻译、摘要、Q&A、设备与 provider 状态 | 开始会议、会话恢复 | 录制中导航会弹出“继续录制/暂停并离开/结束并保存” |
| `/meeting/:meetingId/summary` | 会后完整摘要、决定、行动项、议题和时间线 | 实时页摘要标签、会话历史 | 只读/可编辑摘要，不影响录音状态 |
| `/meeting/:meetingId/qa` | Q&A 历史、引用片段、重新提问 | 实时页 Q&A 标签、历史详情 | 会话无上下文时显示引导，不伪造答案 |
| `/settings/audio` | 输出 loopback、麦克风、权限、profile 和测试电平 | 设置 | 修改在下次开始或明确“应用”后生效；录制中只允许安全切换 |
| `/settings/providers` | iFlytek/MiMo 配置状态、模型、连接测试和错误诊断 | 设置 | 密钥输入离开页面后清空明文输入框 |
| `/settings/privacy` | 本地保存、原始音频、云端处理、导出和删除策略 | 设置 | 每项变更需要说明影响；录制中不可降低隐私保护 |
| `/settings/general` | 语言、主题、快捷键、通知、启动行为 | 设置 | 立即保存非破坏性偏好 |
| `/about` | 版本、许可、诊断导出、隐私说明 | 帮助菜单 | 只读 |

`/meeting/:meetingId/live`、`summary` 和 `qa` 共用一个会话上下文，但路由切换不应重新打开音频或重复请求历史数据。实时页使用标签切换时优先保持内存中的快照；刷新或重新打开时从本地数据库恢复，再由事件流补齐。所有会话、设置、设备测试和导出页面都必须显式呈现 `loading`、`empty`、`error`、`cancelled` 四类请求状态；`error` 状态保留上一次可用快照和重试入口，不能用空数组伪装成“没有数据”。

### 2.3 导航状态

- **未配置状态**：主导航下方出现非阻塞的“完成设置”入口，不以红色警报占据整个页面。
- **录音状态**：导航显示红色录音点、`录制中 12:34` 和可访问文本；暂停显示黄色双竖线和 `已暂停`。
- **离线状态**：顶部显示“网络不可用，文字仍可本地缓冲/已停止云端处理”，具体能力取决于 provider，不把所有离线状态混为一个错误。
- **深链**：历史会话、Q&A 和摘要链接可直接打开；会话已删除或不存在时进入可恢复的 404 状态，不显示空白页面。

## 3. 窗口尺寸与响应式行为

### 3.1 尺寸基线

| 项目 | 规格 |
|---|---:|
| 首次打开默认尺寸 | 1440 × 900 logical px |
| 最小尺寸 | 1120 × 700 logical px |
| 推荐录制尺寸 | 1280 × 800 以上 |
| Windows 工作区命令带 | 64 px；不模拟 macOS 交通灯或标题栏 |
| 内容上/下边距 | 24 px / 20 px（紧凑宽度为 16 px） |
| 主要网格间距 | 20–24 px；文本内部节奏 8–16 px |
| 左侧导航轨 | 204 px，最小 184 px |
| 转写列 | 以 `minmax(600px, 1fr)` 为目标，优先占据剩余空间 |
| 伴侣面板 | 324 px；最小 overlay 宽度 304 px，默认可收起 |

窗口和间距使用 logical px，并以 `rem/em` 参与文字缩放，考虑 Windows 显示缩放 100%–200%。Tauri 窗口不允许小于 1120 × 700，确保录音控制、双来源状态、可读转写和错误操作不被挤到不可用状态。

### 3.2 断点和布局

- **≥ 1360 px**：左侧导航轨约 204 px，中央转写列约 840 px，右侧伴侣面板约 324 px；栏间以 20–24 px 留白分开。转写列是主画布，面板不是第二个信息中心。
- **1120–1359 px**：导航轨收窄至 184–192 px；中央列保持至少 600 px；摘要/Q&A 伴侣面板默认收起，打开时从触发按钮一侧以 304 px overlay 进入，不把正文压缩成窄卡片。
- **接近最小尺寸**：用户可隐藏导航轨；伴侣面板只能作为可关闭 drawer/overlay 出现；停止录音、两路来源状态和当前转写始终在可见工作区内。
- **≥ 1800 px**：转写正文设置约 920 px 的阅读上限；增加留白而不是把行长或信息密度拉满。摘要面板仍保持紧凑，不复制整页内容。
- **高度不足**：命令带和底部录音控制保持可见；转写列和伴侣面板分别滚动；不使用整页滚动把“结束会议”藏到视口外。
- **系统字体放大**：支持 100%–200% 文本缩放；在 125%/150% Windows 缩放下允许标签换行，不以省略号截断会议标题、权限错误或 `ProtocolUnavailable`。

这不是移动端响应式伪装。窗口变窄时采用导航收窄、伴侣面板折叠和可逆 overlay，而不是把桌面工作台压成手机卡片列表。四张静态稿只展示 1440 × 900 基准，不把画布坐标误当成 1120 × 700 的已实现响应式证据；1120 × 700 的 reflow/drawer/内部滚动是实现验收契约，必须在实际窗口和 125%/150% 缩放下验证。

## 4. 视觉设计令牌（映射到 MUI theme）

### 4.1 视觉方向

新的临时方向是“安静的工作台”：让实时转写成为第一视觉层级，用间距、文字权重和来源色条组织信息，减少卡片套卡片、厚重边框和大面积渐变。Windows 桌面语境只保留熟悉的系统工作区、命令带和焦点行为，不模拟 macOS 交通灯、不复制 SF Symbols，也不声称复现 LetShare。青绿色只表达音频/处理活跃，蓝色表达导航和可执行操作，暖色表达风险或暂停；色相永远配合文字和图标。

Chrome 可以使用低不透明度表面表达功能层级，但只在确实悬浮的命令带、drawer 或伴侣面板使用；静态稿统一绘制不透明 fallback，避免把材质效果误读成内容层。内容画布、输入面和转写行保持实色高对比；`prefers-reduced-transparency` 或不支持 backdrop blur 时直接回退到同一不透明表面。

### 4.2 颜色令牌

| 语义令牌 | Light | Dark | 使用 |
|---|---|---|---|
| `primary.main` | `#2D6CDF` | `#8FB0FF` | 主操作、选中导航、链接 |
| `primary.strong` | `#194FAF` | `#B7C9FF` | pressed、焦点和高对比文本 |
| `source.output` | `#087F79` | `#63D6C5` | 系统输出来源、音频活跃 |
| `source.microphone` | `#2D5FB8` | `#9AB7FF` | 麦克风来源；与系统输出保持可区分 |
| `background.canvas` | `#F4F7F8` | `#111A22` | 应用主画布 |
| `surface.chrome` | `rgba(249,251,252,.88)` | `rgba(27,41,51,.90)` | 命令带、伴侣面板；需有实色 fallback |
| `surface.subtle` | `#ECF2F4` | `#1E2C35` | 导航轨、输入、partial 背景 |
| `text.primary` | `#132230` | `#F4F7F8` | 正文和标题 |
| `text.secondary` | `#50616C` | `#B8C6CE` | 辅助说明；不用于唯一状态提示 |
| `success.main` | `#087F79` | `#63D6C5` | 已连接、完成 |
| `warning.main` | `#875500` | `#F3C86E` | HFP、暂停、降级 |
| `error.main` | `#B93845` | `#FF9CA5` | 权限、错误、不可恢复失败 |
| `divider` | `#D4DEE3` | `#3B4B57` | hairline 结构分隔，不围住每段正文 |

语义颜色必须同时通过文本、图标、来源色条、状态徽标或边框表达，不能只靠色相。正文、按钮和焦点文字按 WCAG AA 验证；暗色不使用纯黑底或低对比彩色小字。

### 4.3 尺寸、圆角与层级

- 4 px 基础节奏：`4 / 8 / 12 / 16 / 20 / 24 / 32`；外部布局优先 20–24 px，正文段落使用 12–16 px。
- 主画布不默认包在卡片里。输入行、来源行和伴侣面板使用 9–14 px 圆角；只给真正悬浮的面板使用 14–16 px；不叠加同色半透明表面。
- 结构优先使用单条 hairline divider 和留白。阴影只用于 overlay/drawer 的分离：`0 8px 24px rgba(19,34,48,.10)`；普通转写行不加阴影。
- 主录音、结束和错误恢复控件有效点击区至少 44 × 44 px；桌面其他控件至少 40 × 40 px，焦点环外扩 2 px。
- 计时器、电平、队列、字数和来源时间使用 `font-variant-numeric: tabular-nums`，避免实时刷新造成横向跳动。

### 4.4 字体与组件

- 中文/Windows 优先字体栈：`Microsoft YaHei UI`, `Segoe UI Variable`, `Segoe UI`, `Noto Sans CJK SC`, sans-serif；英文和数字沿用 Segoe UI 系列。不要引入需要下载的字体。
- 令牌以 16 px 根字号定义：正文 `0.875rem/1.5`；转写 `0.9375–1rem/1.625`；页面标题 `1.5–1.75rem/1.15`；辅助说明不低于 `0.6875rem`，重要错误不低于 `0.8125rem`。
- 大标题使用轻微负 tracking（约 `-0.02em`），正文接近 `0`，小号标签使用不超过 `0.02em` 的正 tracking；行高随字号缩放，不用一个固定 letter-spacing 覆盖所有文字。
- MUI `Button`、`IconButton`、`Alert`、`Tabs`、`Drawer`、`Dialog` 和 `LinearProgress` 映射同一套令牌；不再用 `Chip` 堆叠状态。图标为单色 outline、约 1.75–2 px stroke，主图标源遵循第 12.1 节。

## 5. 主工作台：实时录音、转写、摘要与 Q&A

### 5.1 1440 × 900 基准布局

主工作台以转写画布为单一视觉主角，减少并列卡片造成的注意力竞争：

```text
┌──────────────────────────────────────────────────────────────┐
│ 64px Windows 工作区命令带：标题/录音状态/结束                │
├──────────────┬──────────────────────────────┬────────────────┤
│ 导航轨 204px  │ 转写画布 840px                │ 伴侣 324px      │
│ 章节/来源快照  │ 搜索、双语时间线              │ 摘要 | Q&A       │
│ 状态摘要       │ 底部双源电平与录音控制        │ 可收起 overlay   │
└──────────────┴──────────────────────────────┴────────────────┘
```

1440 × 900 时，导航轨约 204 px、转写列约 840 px、伴侣面板约 324 px，栏间 20–24 px。转写行是开放画布上的连续内容，不再用厚边框卡片包住每个 segment。1120 × 700 时导航轨收窄至 184 px，伴侣面板默认关闭；打开时从触发点进入 304 px overlay，不能挤压转写或隐藏 `结束会议`。

### 5.2 顶部命令带与状态

命令带只承载路由回退、会议标题、录音状态和结束保护。`结束会议` 使用显式文字；音频源的详细状态放在中央列底部控制旁，避免用户在录音动作和来源反馈之间来回寻找。

- 正在录制：红色录音点 + `正在录制` + tabular timer；暂停和 `结束会议` 始终可见。
- 暂停：黄色双竖线图标 + `已暂停`，显示用户暂停、设备异常或等待权限的原因。
- 处理中：结束后显示 `正在整理…`，原文、最近快照和可恢复错误仍留在画布。
- 未配置/协议未验证 provider：只在对应翻译、摘要或 Q&A 行内降级；设备采集和原文状态不能被全局 provider 文案覆盖。

### 5.3 导航轨与来源快照

导航轨上方放当前会议和章节时间标记，点击章节定位转写；无章节时显示“识别到议题后会自动生成”。来源快照用两行轻量状态而不是独立大卡片：

- `系统输出`：render endpoint、连接/无信号/loopback 状态、采样率和聚合电平。
- `麦克风`：input endpoint、权限/静音状态、采样率和聚合电平。

队列深度、ASR 延迟、丢帧和 provider 诊断只显示简短摘要，完整诊断进入设置/关于页。电平仅为粗粒度瞬时值，不写入会话正文；两来源始终保留独立成功/失败状态。

### 5.4 转写时间线

- 顶部约 52 px：搜索、`全部/原文/译文`筛选和自动滚动；搜索输入仍可用 `Ctrl/Cmd + K` 聚焦。
- 每个 segment 是有来源色条的时间线行，显示来源、相对时间、稳定原文和译文。原文优先，译文缩进 16 px、字号小一级；系统输出与麦克风不能只靠颜色区分，必须有来源文字。
- partial 使用低饱和 teal 背景、`识别中` 文本和轻微静态插入提示；不逐字动画、不把 partial 当作 final。final 固化后提供复制、引用到 Q&A、用户修订和时间戳入口；修订只写 `user_revision`，不覆盖原始 ASR。
- 自动滚动只在用户停留在底部时生效；用户上移后不强行夺回滚动位置，底部显示 `回到最新` 和未读片段数。
- 翻译 skeleton/失败只占译文行；原文保持可读。加载、empty、error、cancelled 都在原位置说明并保留上一快照，不能用空数组伪装空状态。

### 5.5 伴侣面板：摘要与 Q&A

伴侣面板是一个可折叠的功能层，不是第二个堆叠式 dashboard；无操作时可以完全收起。面板顶部用同级标签 `摘要` / `Q&A`，内容保持紧凑、引用可回到转写。

**摘要**：显示“正在形成”的概览、关键点、决定/行动项和证据时间；每项用分隔线和短文本，不嵌套卡片。摘要状态保留 `更新于 00:42`、覆盖的稳定片段数量、失败类别和 `重试`；更新中保留上一稳定版本，不整块闪烁替换。`ProtocolUnavailable`、未配置、网络失败和取消时，面板显示相应错误/空态，保留上一快照（如有）并仅在协议已验证时启用重试。

**Q&A**：显示 `当前会话 · 已纳入 18:42` 等上下文范围，并继续使用后端校验的 `current_session`、`current_topic`、`selected_segments`、`all_sessions` 枚举。只有 `allow_history_qa=true` 才能出现 `all_sessions`；策略关闭时后端拒绝该值，UI 同时禁用并移除选项。输入框固定在面板底部，支持 `Ctrl/Cmd + Enter`；发送前明确显示问题和必要片段会发送给 MiMo provider。面板覆盖无上下文、无证据、streaming、final、失败、取消和保留部分答案的状态，显示引用片段、时间戳和 `仅根据当前记录/推断` 标签；`ProtocolUnavailable` 时输入可见但提交禁用且不发送请求。

答案保留流式文本、引用时间戳以及“仅根据当前记录/推断”标签；无证据必须说“记录中没有足够依据”。转写、用户修订和历史引用仍是不可信数据，放入结构化 `<meeting_context>`，不能改变系统提示、触发工具或越过 `context_scope`；Rust 校验引用属于授权范围，UI 只渲染通过校验的引用。回答中的取消、超时、网络失败和重试保留问题及部分答案。

### 5.6 底部录音控制

中央列底部固定约 96 px 的控制条：左侧紧邻暂停/结束操作显示两路聚合电平、来源标签、采集/ASR 状态；中央为大号暂停/继续；右侧为显式 `结束会议`、录音时长和“原始音频不保存/已开启”的隐私状态。控制条不随转写滚动，键盘焦点顺序优先经过它；按下立即反馈，提交在释放时完成，取消可通过拖离/恢复焦点完成。

## 6. 新建会议与设备设置

### 6.1 新建会议流程

`/meeting/new` 采用单页分段表单，避免多步向导隐藏关键音频信息：

1. 会议标题（可选，默认为日期 + 时间）；
2. 系统输出 endpoint；
3. 麦克风 endpoint；
4. 原文语言、译文语言和是否显示双语；
5. 隐私确认：默认“不保存原始音频”；
6. 设备测试与 provider 状态；
7. `开始会议`。

只有至少一个可用 ASR 输入源并且录音权限检查通过时，开始按钮才可用。系统输出或麦克风缺失时允许“仅使用可用来源开始”，但必须在按钮旁说明会话能力受限，不能静默丢失一路声音。

### 6.2 音频设置页

`/settings/audio` 分为“系统输出（loopback）”“麦克风”“设备行为”“诊断”四块。

**系统输出**：

- 枚举所有 render endpoints，显示设备名、默认设备标记、连接状态和是否为蓝牙设备；
- 选择后显示“采集的是操作系统混音后的数字输出，不保证等同于耳机实际声学输出”；
- 提供 3 秒安全电平测试，不上传、不持久化测试音频；
- 提示 endpoint 级采集可能包含其他应用的系统提示音。

**麦克风**：

- 独立枚举 input endpoints，允许选择电脑内置、USB 或其他麦克风；
- 显示输入电平、采样率和权限状态；
- 若选择蓝牙耳机麦克风，显示 HFP 警告：Windows 可能切换耳机 profile、降低播放质量或改变采样率；建议会议播放使用蓝牙耳机、输入使用另一支麦克风。

**设备行为**：

- 输出断开：自动尝试按稳定 endpoint ID 重连，失败后暂停并提示选择新设备；
- 默认设备改变：不静默替换用户明确选择的 endpoint；用户选择“跟随系统默认”时才切换；
- profile 改变：显示 A2DP/HFP 状态变化、原因和新的采样率；按原子恢复顺序暂停两路 PCM 入队 → 标记带起止时间的短暂丢音区间 → 停止两条 ASR stream → 重新枚举并按稳定 ID/用户选择绑定 endpoint → 重建格式转换、时钟锚点和两条 stream → 仅在两路状态快照提交后恢复入队。失败时回滚到可用旧配置或保持暂停并要求用户选择；不得让一条旧格式 stream 与另一条新格式 stream 混用。恢复默认自动执行，首次继续前给出一次“蓝牙 profile 已改变，可能影响播放质量”的确认。

### 6.3 Provider 设置页

- iFlytek：显示“未配置/已配置但未测试/可用/最近失败/协议不可用”，凭据输入为密码框；提交只调用 `provider.credentials.set`，成功或失败后立即清空表单，不回显完整值。没有凭据时首次配置路径是：填写 → “保存并测试” → **仅在官方 manifest 与 golden fixtures 已验证后**进行最小握手验证；协议未验证时只显示凭据存在与 `ProtocolUnavailable`，不发送请求。
- MiMo：默认 endpoint 锁定为 `https://token-plan-cn.xiaomimimo.com/v1`；**只有官方 manifest、health fixture 和 golden response 通过后**才显示已验证的模型显示名和可用协议状态，否则显示凭据状态与 `ProtocolUnavailable`。自定义 endpoint 必须走第 10.3 节的显式信任确认，不能在录音中静默切换。
- “测试连接”仅在对应协议清单和 fixture 已验证时调用 `provider.health.check`，只发送协议清单规定的最小健康请求，不发送会议音频、历史文字或用户问题；`ProtocolUnavailable` 时测试/重检控件禁用并明确不发送健康请求，超时、取消和限流都显示独立状态。
- 前端只能读取布尔状态、provider 名称、模型显示名、协议版本和脱敏错误类别；不能读取 token、签名、完整请求头、原始响应或 provider 原始密钥错误。
- 写入过程使用后端原子更新 OS 安全存储；进程崩溃后不提供明文恢复路径，重新打开页面必须重新输入。开发环境可用 `.env` 作为后端只读 fallback，发布包不读取 `.env`，优先级和故障行为见第 10.3 节。

## 7. 路由与状态矩阵

状态是会话状态、设备状态、provider 状态和内容状态的组合，而不是一个巨大枚举。每个来源都有独立的采集、队列、ASR、延迟和重连状态；一路失败不能把另一路渲染成失败。UI 根据状态优先级叠加提示：安全/权限问题 > 采集问题 > provider 问题 > 内容更新提示。

`SessionSnapshot.source_runtime[output|microphone]` 是唯一的来源状态入口，至少包含 `capture_status`、`signal_status`、`queue_depth_ms`、`dropped_frames`、`asr_status`、`latency_ms`、`reconnect_attempt` 和 `last_error_category`。`audio.capture.status`、`asr.*`、`metrics.snapshot` 和 `audio.level` 事件必须携带 `source_id`；全局 provider 状态不能覆盖来源级状态。无信号、静音和不支持不是同一个错误：它们分别映射到可操作的 `NoSignal`、`Muted`、`LoopbackUnavailable`、`ExclusiveMode`、`ProtectedContent`、`Permission`、`UnsupportedAudio`。

### 7.1 关键状态矩阵

| 场景 | 进入条件 | 页面表现 | 用户动作与恢复 |
|---|---|---|---|
| 首次运行 | 没有本地偏好、没有 provider 状态 | `/library` 显示三步引导：选音频、配置 iFlytek、配置 MiMo；“新建会议”可进入设置 | 完成任意可用组合；引导可跳过，但明确跳过后会缺少哪些能力 |
| 空会话库 | 数据库没有会话 | 插画/原创图标、`还没有会议记录`、主按钮 `开始第一场会议`；不显示空白表格 | 进入新建会议或查看隐私设置 |
| 空闲/已配置 | 无活动会话且至少一个 provider 可用 | 会话库显示最近会话、搜索和新建按钮；顶部无录音点 | 创建或打开历史会话 |
| 设备权限未授权 | Windows 音频捕获权限或应用权限检查失败 | 新建页在对应设备行显示锁/权限状态；开始按钮禁用；给出系统设置路径 | `打开系统设置`、重新检查；失败原因可复制但不含敏感数据 |
| 输出设备缺失 | 所选 render endpoint 被移除/无输出设备 | 输出卡片 error；若麦克风可用，允许显式 `仅录麦克风`；顶部不假装正在录制 | 重新选择设备或结束配置；保留用户选择 |
| 麦克风缺失 | 所选 input endpoint 被移除 | 麦克风卡片 error；允许 `仅录系统输出` 并说明没有本地发言者声音 | 插入/选择设备、重新测试 |
| 设备重连成功 | 断线后 endpoint ID 恢复 | 顶部短暂显示 `系统输出已重新连接`，时间线插入设备事件；不丢弃已有文本 | 自动继续；若发生格式变化，提示确认 |
| 设备重连失败 | 重试达到退避上限 | 会话自动暂停，中央列保留最后稳定文字，显示 `等待设备` | 选择新设备并 `继续录制`，或结束并保存 |
| 无活动输出 | 设备已连接，但 loopback 在 2 秒窗口没有非静音样本 | 输出来源显示 `已连接但无活动输出`，电平保持文本 `无信号`；ASR 不显示为正常 | 播放测试音、选择其他 render endpoint 或结束该来源 |
| 系统/麦克风静音 | endpoint 或系统静音标记为 on | 显示 `系统已静音`/`麦克风已静音`，与无信号区分；保留已收文本 | 取消静音或继续仅处理另一来源 |
| loopback 不可用 | endpoint 不提供 shared-mode loopback | 输出卡片显示 `此设备不支持系统回环` | 选择其他 render endpoint；不能退化成假电平 |
| 独占模式 | 其他应用占用 exclusive stream | 显示 `独占模式占用` 和占用检查结果 | 关闭/切换占用应用，或仅使用麦克风 |
| 受保护内容 | DRM/受信任驱动返回空或拒绝 buffer | 显示 `受保护内容无法回环`，不把它解释成 provider 故障 | 播放非受保护音源或仅使用另一来源 |
| 采样格式不支持 | 采集格式无法转换为内部 PCM | 来源停止并显示具体 `UnsupportedAudio` | 重新选择设备/格式；不发送不符合线格式的音频 |
| A2DP → HFP | 蓝牙麦克风启用导致 profile 改变 | 顶部 warning chip、设置页显示 profile/采样率前后值；不隐藏当前转写 | 按原子恢复流程重建两路流；继续、换独立麦克风或暂停检查 |
| 录音中 | 两路采集已启动，至少一条 ASR stream 可用 | 红点、计时、双电平；partial 实时进入时间线；`结束会议` 永远可见 | 暂停、继续、结束；设备变化走独立状态 |
| 暂停 | 用户暂停或设备暂不可用 | 计时停止或显示总时长不变；控制条显示原因；不接受新的音频 | 继续、选设备、结束保存 |
| partial ASR | 音频块已发送但结果尚未稳定 | 片段尾部显示低强调色 `识别中`；允许继续滚动，partial 可被替换 | 无需操作；超时后进入 ASR provider 状态 |
| final ASR | provider 发出稳定结果/端点 | 原文固化，进入翻译、摘要队列；显示来源和时间戳 | 可编辑用户层，不覆盖原始结果 |
| 翻译进行中 | final segment 已入翻译队列 | 原文立即可读，译文行显示 skeleton + `翻译中`；不阻塞录音 | 等待、取消该段翻译或稍后重试 |
| 翻译失败 | 超时、限流、网络或语言不支持 | 译文行显示 `暂时无法翻译`，错误类别和 `重试`；原文保留 | 重试、修改语言/provider；错误不升级为整场失败 |
| 摘要更新中 | 累积到阈值或手动刷新 | 右栏摘要显示上次稳定版本 + 小型更新指示；不闪烁替换整个卡片 | 等待；可继续问答；可取消本次更新 |
| 摘要为空 | 没有足够 final 文本或会议刚开始 | `再积累一些稳定转写后生成摘要`；不展示假摘要 | 继续录音或手动刷新（仍不足时保持说明） |
| 摘要失败 | MiMo 网络/上下文/配额失败 | 上次摘要保留；顶部标明失败时间和 `重试`；显示是否文本已上传 | 重试、缩小上下文、检查 provider；不丢历史摘要 |
| 议题识别中/失败 | 未达到切分阈值，或 topic segmentation 请求失败 | 章节显示 `正在识别议题` 或 `暂时没有可用议题`；不伪造标题；Q&A 的 `current_topic` 相应禁用 | 继续积累 final segment，或重试 `topic.refresh`；不影响当前会话范围 |
| Q&A 有上下文 | 至少一个 final segment 或用户引用片段 | 输入框可用；显示上下文范围与更新时间；答案附时间引用 | 提问、取消、复制、追问 |
| Q&A 无上下文 | 空会话、只有 partial、或选定议题无文字 | 输入框可显示但提交禁用；文案说明 `需要稳定转写或手动引用片段` | 继续录音、选择策略允许的当前会话/当前议题或等待 final；`all_sessions` 仅在后端策略允许时出现 |
| Q&A 无答案 | MiMo 返回没有证据/拒答 | 明确 `当前记录没有足够依据`，列出检索到的片段数量；不写成确定结论 | 改问、扩大上下文、引用片段 |
| Q&A 错误 | 网络、限流、配置或 provider 返回错误 | 保留问题和已生成部分；错误类别、重试、取消 | 重试/设置 provider；部分答案不标记为完整答案 |
| iFlytek 未配置 | 启动检查没有有效凭据 | 设备可测试但开始按钮旁显示 `缺少实时识别配置`；可进入 provider 设置 | 配置并测试；若有本地 ASR 后端则显示明确可选项，否则不能伪装离线 ASR |
| iFlytek/MiMo 协议未验证 | manifest、fixture 或 golden response 缺失/不匹配 | 显示 `协议尚未验证`，禁止健康请求和会议请求；原文/本地保存仍可用 | 安装已审查的协议版本；不允许用户手填 path 或绕过保护 |
| iFlytek 网络错误 | 流连接失败或持续超时 | 录音可暂停/继续；显示 `音频未上传/正在重连` 的准确状态，不能丢弃为“正常录制” | 指数退避重连；达到上限后保留原始本地缓冲策略（若用户启用）或结束 |
| MiMo 未配置 | 没有有效 Token Plan 凭据 | 翻译/摘要/Q&A 各自显示未配置；ASR 和原文录音仍可运行 | 设置 MiMo；可在当前会话之后重新处理文本 |
| MiMo 网络错误 | 请求超时、DNS、TLS、限流 | 原文不受影响；摘要保留旧快照；翻译排队并显示等待/失败原因 | 重试、指数退避；超时后允许本地保存并会后处理 |
| 会话已结束 | 用户结束录音 | `/live` 进入整理态；保存 final segment、摘要快照和 provider 状态后进入详情 | 打开摘要、Q&A、导出或回到库 |
| 历史会话 | 从库打开已保存会话 | 只读详情默认加载原文；按需加载译文、摘要和 Q&A；显示录音设备与隐私摘要 | 搜索、编辑用户层、导出、删除；不会重新发送音频 |
| 会话不存在/已删除 | 深链无记录 | 可恢复错误页，显示返回会话库 | 返回库，不自动创建新会话 |
| 会话库加载中/失败/无结果 | `session.list/search` 尚未完成、存储失败或查询无匹配 | 加载显示骨架；失败保留重试；无结果显示查询词和清除筛选入口，不与空库混淆 | 重试、清除搜索或检查存储 |
| 应用重启后未完成会议 | 发现 `recording`/`finalizing` session 且进程已退出 | 只恢复已落库 segment、snapshot 和尾部丢失提示；默认不自动继续录音或上传 | 用户明确选择继续配置后重新开始，或结束并保存恢复内容 |
| 系统挂起/唤醒 | 睡眠前后设备/网络状态变化 | 挂起时暂停采集并插入生命周期事件；唤醒后重新检查设备与 provider | 自动恢复仅在两路设备和同意状态均有效，否则保持暂停 |
| 数据库迁移/损坏/磁盘不足 | schema migration 失败、校验失败或剩余空间低于 512 MiB | 阻止新写入并显示 `Storage`/`DatabaseCorrupt`/`StorageFull`；已落库内容只读可导出（若可读） | 备份诊断、释放空间或选择恢复；不删除原库掩盖错误 |
| 导出取消/路径冲突/失败 | 用户取消、目标已存在或写入失败 | 显示 `已取消`、`目标已存在` 或可重试错误；保留已生成的会议数据，不伪造完成 | 选择新路径、覆盖确认或重试 |
| 删除失败 | 文件/数据库事务未完成 | 会话保留并标记删除失败，列出未删除类别 | 重试或导出诊断；不能显示“已删除” |

### 7.2 状态优先级与不可逆操作

- 采集异常必须覆盖“云端处理成功”提示；用户首先要知道是否还在收音。
- provider 失败不能覆盖已保存的原文。
- 删除会话、删除原始音频、结束录音均是破坏性或不可逆操作，使用确认对话框说明影响，并支持取消。
- 所有网络错误保留用户可恢复的输入、已生成文本和上次稳定快照。

## 8. 数据流与模块边界

### 8.1 端到端数据流

```text
Windows render endpoint ─┐
                         ├─> AudioCaptureCoordinator
独立 microphone endpoint ┘       │
                                  ├─> bounded PCM queues
                                  ├─> format/downmix/resample/VAD
                                  ├─> source-timestamped ASR chunks
                                  ├─> clock calibrator / drift correction
                                  ▼
                         XfyunStreamingAsrAdapter
                                  │ partial/final
                                  ▼
                         TranscriptReconciler
                         (sequence, timing, source, revisions)
                           ┌──────┼───────────┐
                           ▼      ▼           ▼
                       本地存储  翻译队列    摘要/Q&A context
                                  │           │
                                  ▼           ▼
                         MiMoTranslation  MiMoMeetingIntelligence
                           (Rust only)       (Rust only)
                                  │           │
                                  └─────┬─────┘
                                        ▼
                              Tauri events → React/MUI
```

输出和麦克风始终先各自采集、标记和识别，不在实时 callback 中直接混音或调用网络。内部 PCM 契约固定为 `mono / 16 kHz / f32 / 归一化到 [-1,1]`；采集端可以是 44.1/48 kHz、整数或浮点、多声道，必须在 `pcm-pipeline` 中转换。provider adapter 的出口不是内部 f32：iFlytek 只接受通过其已验证协议清单声明的线格式（位深、端序、采样率、声道、帧时长和编码），由 adapter 显式生成 signed PCM/协议要求的 base64 或其他 framing，缺少清单时拒绝发送。统一时间源是进程启动后的 Windows `QueryPerformanceCounter` 单调时钟；每个来源启动时取 2 秒样本建立初始 offset，之后每 30 秒计算一次 offset 斜率。offset 绝对值超过 80 ms 或斜率超过 100 ppm 时启用持久化 asynchronous resampler，单次校正速率不超过 20 ppm；超过 250 ms 则插入 `clock_discontinuity` 边界并暂停该来源。设备切换重新建立锚点，前后不合并为同一连续片段。provider 时间戳只作为可选校准信息；在用户可见层保留 `系统输出`/`麦克风` 来源，以便定位 HFP 或漏采问题。

### 8.2 模块边界

| 模块 | 唯一职责 | 可依赖 | 不应依赖 |
|---|---|---|---|
| `ui-shell` | 路由、MUI 布局、可访问状态呈现 | `session-store`、事件网关 | 音频库、密钥、HTTP 客户端 |
| `session-store` | 前端快照、选择状态、乐观/回滚 UI 状态 | 类型化命令/事件网关 | provider 细节 |
| `tauri-command-gateway` | 校验命令、序列化 IPC、关联 request/trace ID | Rust application services | React 组件 |
| `audio-device-catalog` | 枚举、稳定 ID、权限和 endpoint/profile 变化 | 平台音频 API | ASR、MiMo |
| `audio-capture-coordinator` | 启停两路采集、重连、生命周期和来源标记 | device catalog、PCM pipeline | React、摘要逻辑 |
| `topic-segmentation` | 从稳定 segment 生成可引用的当前议题边界和状态 | transcript repository、meeting-intelligence-port | 设备 API、React 私有字段 |
| `pcm-pipeline` | 有界队列、采样格式转换、downmix、重采样、VAD、指标 | 纯音频处理库 | 网络、数据库 |
| `asr-port` | 定义 partial/final 流式识别契约 | provider adapter | UI 组件 |
| `xfyun-streaming-adapter` | iFlytek 认证、流连接、心跳、重连和协议映射 | secret store、HTTP/WebSocket transport | MiMo、数据库 schema |
| `transcript-reconciler` | 合并修订、去重、排序、来源和稳定性 | ASR port、clock | provider 私有字段 |
| `translation-orchestrator` | 语言检测/批量/重试/取消和译文状态 | translation port、transcript repository | audio capture |
| `meeting-intelligence-orchestrator` | 摘要窗口、上下文压缩、Q&A 引用和回答状态 | MiMo port、transcript repository | 蓝牙/WASAPI |
| `mimo-adapter` | Token Plan 请求、流式响应、限流和错误分类 | secret store、HTTP transport | 设备 API |
| `session-repository` | 会话、segment、摘要、Q&A 和设置持久化 | 本地数据库/文件系统 | React、HTTP |
| `privacy-and-secret-service` | 明文密钥边界、脱敏、数据删除策略、云端提示 | OS secret store、app data dir | UI 读取密钥值 |
| `diagnostics` | 延迟、丢帧、队列、provider 和设备诊断 | 各模块提供的指标 | 会议正文的默认采集 |

每个 provider 通过端口（接口契约）接入，替换 iFlytek 或 MiMo 不需要修改实时页面。端口 DTO、取消、重试、幂等和错误不携带 provider 私有字段：

```text
AsrPort.start(StreamSpec{session_id, source_id, audio_format, consent_id}) -> AsrStream
AsrStream.send(AudioFrame{source_id, sequence, start_ms, pcm_f32}) -> Result<()>
AsrStream.events() -> Stream<AsrDelta{segment_id, revision, stability, text, timing, confidence}>
AsrStream.finish(reason) / cancel() -> Result<FlushReport>

TranslationPort.translate(TranslationRequest{idempotency_key, segment_id, source_text, languages})
  -> Stream<TranslationDelta{text_delta, status}>; cancel(request_id)
MeetingIntelligencePort.summarize(SummaryRequest{idempotency_key, window, prior_revision})
  -> SummaryResult; answer(QaRequest{idempotency_key, scope, question, cited_segments})
  -> Stream<QaDelta{text_delta, cited_segment_ids, status}>; segment(TopicRequest{idempotency_key, segments, prior_revision})
  -> TopicResult; cancel(request_id)
```

所有端口操作返回统一的 `PortError{kind, retryable, retry_after_ms, safe_message}`；`idempotency_key` 由应用服务生成并持久化，重试不得重复创建 segment、摘要 item 或 Q&A turn。`Stream` 取消必须传播到 HTTP/WebSocket transport 并在本地发出终态；网络重试只由 orchestrator 执行。应用服务输出产品语义错误（`DeviceMissing`、`ProviderNotConfigured`、`NetworkUnavailable` 等），前端不解析 provider 私有错误字符串。

### 8.3 运行时线程/任务原则

- 音频 callback/packet reader 不分配大对象、不阻塞、不访问数据库、不执行模型或网络。
- 音频处理、ASR 网络发送、ASR 结果接收、翻译、摘要和 Q&A 使用彼此隔离的任务/队列。
- 队列使用上限；满载时记录丢帧计数并按策略暂停发送或降级，而不是无限增长内存。首版预算为每个来源 8 个音频块（每块 20 ms，160 ms）供 ASR 发送、每个来源 2 秒的 16 kHz f32 ring buffer（约 256 KiB），翻译队列最多 32 个 final segment，摘要队列最多 2 个窗口，Q&A 同时最多 1 个请求；达到上限先延迟智能处理，音频环节超过 100 ms 积压或任一来源连续丢帧即发出可见降级事件。
- React 只接收节流后的 UI 事件：电平 10 Hz、partial 每来源最多 5 Hz、metrics 1 Hz；final/设备/错误事件立即发送。高频电平和 partial 不造成整个历史列表重渲染。

## 9. 事件与数据契约

### 9.1 事件封套

所有 Tauri 推送事件采用统一封套，字段语义如下：

| 字段 | 类型/约束 | 说明 |
|---|---|---|
| `schema_version` | 整数 | 契约版本，非应用版本 |
| `event_id` | UUID | 单次事件唯一 ID |
| `session_id` | UUID，可空 | 设备/设置事件可为空 |
| `seq` | 单调整数，可空 | 同一 session 内有序；重连后可检测缺口；全局事件不用此字段 |
| `global_seq` | 单调整数，可空 | 仅 `session_id=null` 的全局事件使用；与 `seq` 分开分配和去重 |
| `occurred_at` | UTC ISO-8601 | 对外显示可按本地时区格式化 |
| `monotonic_ms` | 整数，可空 | 本机相对时间，排序和延迟计算用 |
| `kind` | 枚举 | 事件类型，不能使用自由文本 |
| `trace_id` | 字符串 | 关联命令、provider 请求和日志 |
| `payload` | 类型化对象 | 不包含密钥、原始请求头或未脱敏 provider 响应 |

事件必须可重复消费；后端持久化每个 session 的事件序列和最新 `snapshot_version`，前端按 `session_id + seq` 去重并在发现缺口时调用 `session.snapshot.get`。请求携带 `after_seq` 和 `known_snapshot_version`：后端在事件仍可重放时返回有序补发范围，否则返回完整快照及其 `last_seq`，前端先原子替换快照再接收更高序号事件。断线期间不在前端猜测状态；恢复失败显示 `事件流已重置` 并保留本地最后快照。`session_id=null` 的全局事件使用独立的 `global_seq`，去重键为 `global_seq`（不与任一会话 seq 混用）。并发事件由后端在持久化事务中分配序号，前端不得按到达时间重排。

### 9.2 核心领域对象

**SessionSnapshot**

```text
session_id, snapshot_version, title, status, started_at, ended_at,
selected_output_device, selected_microphone,
source_capabilities, source_profile_state: { output, microphone },
source_runtime: { output: SourceRuntimeStatus, microphone: SourceRuntimeStatus },
translation_status, summary_status, qa_status,
topic_status, privacy_policy, last_seq
```

**SourceRuntimeStatus**

```text
source_id(output|microphone), capture_status, signal_status,
queue_depth_ms, dropped_frames, asr_status, latency_ms,
reconnect_attempt, active_stream_id, last_error_category
```

**AudioDevice**

```text
device_id, stable_id, display_name, kind(render|input),
transport(bluetooth|usb|builtin|other), is_default,
connected, sample_rates, channel_count, profile, permission
```

**TranscriptSegment**

```text
segment_id, session_id, source(output|microphone),
start_ms, end_ms, revision, stability(partial|final),
original_text, confidence(optional), language,
translation_status, created_at, user_revision(optional)
```

`original_text` 是 provider 返回并保留的稳定结果；`user_revision` 只表示用户修订，不能覆盖审计和重新处理所需的原始结果。

**TranslationRecord**

```text
segment_id, target_language, status(pending|streaming|final|failed),
translated_text, provider, model_label, error_category(optional), updated_at
```

**SummarySnapshot**

```text
summary_id, session_id, revision, coverage_end_ms,
headline, key_points[], decisions[], action_items[],
source_segment_ids[], status, generated_at, error_category(optional)
```

`key_points[]`、`decisions[]` 和 `action_items[]` 不是字符串数组，而是带稳定 ID 的 `SummaryItem`：

```text
SummaryItem {
  item_id, kind(key_point|decision|action_item), revision,
  state(active|superseded|removed), text, source_segment_ids[],
  confidence(optional), evidence_kind(observed|inferred),
  owner(optional), due_at(optional), updated_at
}
```

摘要合并按 `(summary_id, item_id, revision)` 幂等；同一 item 的更高 revision 替换旧版本，`removed` 保留审计引用但不在活动列表显示。用户修订通过 `transcript.revision.save`/摘要编辑命令生成新 revision，不能修改 provider 原始文本；过期重试带 `base_revision`，冲突时保留双方并要求用户选择。

**TopicSnapshot**

```text
topic_id, session_id, revision, title, start_ms, end_ms,
source_segment_ids[], confidence, status(detecting|active|closed|failed)
```

topic segmentation 在至少 3 个 final segment 且距上次边界 ≥ 30 秒后触发；每累计 12 个 final segment 或 60 秒触发一次，引用边界内 segment。失败只禁用 `current_topic`，不影响当前会话 Q&A 和转写。

**QaTurn**

```text
turn_id, session_id, question, context_scope,
cited_segment_ids[], status(streaming|final|no_evidence|failed|cancelled),
answer, provider, model_label, created_at, error_category(optional),
idempotency_key, policy_snapshot_id
```

**PrivacyPolicy**

```text
save_transcript, save_translation, save_summary, save_qa,
retain_raw_audio, raw_audio_retention_days, allow_history_qa,
consents: [{provider, purpose(asr|translation|summary|qa), granted,
            granted_at, policy_version, revoked_at(optional)}]
```

引用 ID 必须可定位到本地 segment；Q&A 若没有引用或只引用推断，UI 显示相应标签。`context_scope` 只能取 `current_session`、`current_topic`、`selected_segments`、`all_sessions`，由 Rust 根据 `PrivacyPolicy.allow_history_qa` 和 `policy_snapshot_id` 再校验一次。

### 9.3 命令与事件目录

命令通过 Tauri invoke 或等价网关发送，返回 `request_id` 和同步校验结果，长任务结果由事件推送：

| 命令 | 作用 | 关键事件 |
|---|---|---|
| `audio.devices.list` | 获取设备和权限快照 | `audio.devices.changed` |
| `audio.permission.check` | 检查系统权限 | `audio.permission.updated` |
| `meeting.create` | 创建本地 session 草稿 | `meeting.snapshot` |
| `meeting.start` | 启动采集、ASR 和计时 | `meeting.status.changed`、`audio.level` |
| `meeting.pause` / `meeting.resume` | 暂停/恢复 | `meeting.status.changed` |
| `meeting.stop` | 停止采集，flush final 结果 | `meeting.finalizing`、`meeting.completed` |
| `meeting.discard` | 按隐私策略删除草稿及其数据 | `meeting.deleted` |
| `audio.sources.select` | 修改输出/麦克风选择 | `audio.sources.updated` |
| `translation.retry` | 重试一个或一批 segment | `translation.updated` |
| `summary.refresh` / `summary.retry` | 请求增量或重试摘要 | `summary.updated` |
| `qa.ask` | 发送带范围的会话问题 | `qa.delta`、`qa.completed` |
| `qa.cancel` | 取消正在回答的请求 | `qa.completed(status=cancelled)` |
| `session.export` | 导出选定内容 | `export.progress`、`export.completed` |
| `settings.providers.test` | 最小健康测试 | `provider.status.changed` |
| `session.list` | 分页加载会话库 | `session.list.completed` / `error.recoverable` |
| `session.search` | 按关键词、时间和状态搜索 | `session.search.completed` / `error.recoverable` |
| `session.get` | 加载会话详情与按需关联数据 | `session.snapshot` / `error.recoverable` |
| `session.delete` / `session.restore` | 删除或从最近删除恢复 | `session.deleted` / `session.restored` |
| `session.snapshot.get` | 按 `after_seq` 补发事件或返回版本化快照 | `session.snapshot` / `session.events.replayed` |
| `settings.get` / `settings.update` | 读取或更新非秘密设置 | `settings.snapshot` / `settings.updated` |
| `audio.test.start` / `audio.test.stop` | 3 秒本地电平测试，不上传/落盘 PCM | `audio.test.status` / `audio.level` |
| `provider.credentials.set` | write-only 写入指定 provider 凭据 | `provider.credentials.status` |
| `transcript.revision.save` | 保存用户修订层，校验 base revision | `transcript.segment.updated` / `error.recoverable` |
| `summary.revision.save` | 保存摘要 item 的编辑、合并或移除，校验 base revision | `summary.updated` / `error.recoverable` |
| `topic.refresh` | 请求当前议题切分或重试 | `topic.updated` |
| `export.cancel` | 取消导出并清理临时文件 | `export.completed(status=cancelled)` |
| `data.clear` | 按确认范围清除全部本地数据 | `data.clear.progress` / `data.clear.completed` |

上述命令的输入/输出均为版本化 DTO，不允许 `any` 或自由 JSON：

```text
SessionListQuery{cursor, limit<=100, sort, filter}; SessionPage{items, next_cursor}
SessionSearchQuery{query, cursor, limit<=100, filters}; SessionPage
SessionGetQuery{session_id, include(transcript|translation|summary|qa|events)}; SessionSnapshot
SessionDeleteCommand{session_id, purge_audio, reason, confirmation_token}; SessionRestoreCommand{session_id, confirmation_token}
SnapshotGetQuery{session_id(optional), after_seq(optional), after_global_seq(optional), known_snapshot_version}; SnapshotReply{replay[], snapshot?, snapshot_version, last_seq, global_seq}
SettingsUpdate{expected_revision, patch}; SettingsSnapshot{revision, non_secret_values}
AudioTestStart{source_id, device_id, duration_ms=3000}; AudioTestReply{test_id}
ProviderTest{provider, model_ref(optional)}; ProviderTestReply{provider, protocol_version, status, latency_ms, error_category(optional)}
ProviderCredentialsSet{provider, fields, request_id}; ProviderCredentialsStatus{provider, configured, tested}
TranscriptRevisionSave{segment_id, base_revision, text, idempotency_key}; RevisionReply{new_revision}
SummaryRevisionSave{summary_id, item_id, base_revision, patch, idempotency_key}; SummaryRevisionReply{new_revision}
SessionExport{session_id, format(markdown|json), destination, overwrite, include}; ExportProgress{request_id, written_bytes, status}; ExportCancel{request_id}
DataClear{scope(all|sessions|audio|exports|credentials), confirmation_token}; ClearProgress{scope, status, deleted_count}
```

所有长命令先返回 `{request_id, accepted|rejected, validation_error?}`；accepted 进入 `loading/running`，取消进入 `cancelled`，失败返回第 9.4 节错误并保留上一快照，成功才替换对应 revision。`confirmation_token` 由后端为当前破坏性确认对话签发，不能由前端自造。

事件至少包括：`audio.level`（只发聚合电平）、`audio.device.changed`、`audio.profile.changed`、`audio.capture.status`、`asr.partial`、`asr.final`、`transcript.segment.updated`、`translation.updated`、`summary.updated`、`topic.updated`、`qa.delta`、`qa.completed`、`provider.status.changed`、`session.events.replayed`、`error.recoverable` 和 `metrics.snapshot`。来源级事件 payload 必须有 `source_id`；快照事件必须有 `snapshot_version` 和 `last_seq`。

### 9.4 错误契约

统一错误对象包含：

```text
code, category, user_message_key, retryable,
operation, provider(optional), request_id, trace_id,
backoff_ms(optional), details_for_diagnostics(optional)
```

`user_message_key` 由前端本地化；`details_for_diagnostics` 默认脱敏，不可包含 token、签名、完整 URL query、音频 PCM 或完整会议文本。错误类别至少有 `Permission`、`DeviceMissing`、`DeviceChanged`、`NoSignal`、`Muted`、`LoopbackUnavailable`、`ExclusiveMode`、`ProtectedContent`、`ProviderNotConfigured`、`ProtocolUnavailable`、`ConcurrentStreamLimit`、`Network`、`RateLimited`、`InvalidInput`、`UnsupportedAudio`、`Storage`、`StorageFull`、`DatabaseCorrupt`、`ExportConflict`、`Cancelled`、`ConsentRequired` 和 `Unknown`。错误 details 仍只给诊断模块脱敏字段，不能借新增类别泄漏 provider 原始消息。

## 10. API 集成与凭据边界

### 10.1 iFlytek 实时 ASR

- Rust 后端实现 `XfyunStreamingAsrAdapter`，只允许官方实时流式 transport（WebSocket 或官方明确声明的长连接协议）；已有 ECS 代码的 `/v2/upload` 文件上传和 `/v2/getResult` 轮询路径被列入禁止调用清单。
- `XfyunStreamingContract v1` 是 adapter 的启动依赖，必须以版本化、可审查的 manifest 固定：官方 endpoint 的 scheme/host/path、签名输入与 HMAC/编码、握手 JSON 字段、业务参数、音频位深/端序/采样率/声道/帧时长、base64/压缩方式、partial/final 字段映射、心跳与超时、结束帧和并发 stream 限制。每个 manifest 配套握手、20 ms 音频帧、结束帧和错误帧 golden fixtures。
- 当前仓库证据只确认远端使用文件上传/轮询，未确认上述实时 endpoint 和字段；因此在 manifest/fixtures 未通过前，provider 状态固定为 `ProtocolUnavailable`，adapter 不建立网络连接，不得用猜测的 iFlytek URL 或字段上线。集成验收必须证明实际网络路径是官方实时流式路径，并证明没有命中禁止清单。
- 内部 `f32` PCM 不能直接发给 provider。adapter 按 manifest 转成声明的线格式后再分帧；每帧带 `session_id/source_id/sequence/start_ms` 的本地元数据，元数据不进入未声明的 provider 字段。响应只映射为 `AsrDelta{segment_id, revision, stability, text, timing, confidence}`，协议字段不泄漏给 React。
- 连接支持 manifest 规定的心跳、连接/首帧/总超时、可重试错误分类、断线后的新 stream 和重复结果去重。重连创建新的 `stream_id`，按 `(source_id, provider_segment_id, revision, text_hash)` 去重，时间线插入 `asr_reconnect_boundary`，不能假装连续无缝。
- 启动前由后端做账号并发能力检查；如果账号不允许同时维持输出和麦克风两条流，拒绝第二条并显示 `ConcurrentStreamLimit`，允许用户明确选择单来源或另一组凭据，不能把两路音频串到一条未经授权的 stream。
- iFlytek app ID、访问密钥和签名材料只存在于 Rust 进程和 OS secret store/开发环境变量；前端只得到 `configured`、`connected`、`last_error_category` 等状态。
- 录音前展示“音频会离开本机发送给 iFlytek”提示；若用户未同意云端处理，禁止启动需要上传的 ASR 路径。

### 10.2 MiMo Token Plan

- Rust `mimo-adapter` 默认只信任 `https://token-plan-cn.xiaomimimo.com/v1`。`MimoTokenPlanContract v1` 必须在运行时配置中包含且锁定：健康检查 path/method、翻译/摘要/Q&A path、认证 header 名称与 token 传递方式、model 字段、请求 JSON schema、流式 framing（SSE/JSON lines/其他）、delta/终态字段、取消方式、状态码映射和模型/并发/上下文上限。UI 只能选择已验证的 `model_label`，不能编辑 wire 字段。
- 当前仓库只有 base URL 和“MiMo 用于文本能力”的产品约束，没有证据确认 Token Plan 的实际路径、认证头或流式格式。因此未有官方 manifest、health fixture、翻译/摘要/Q&A golden response 前，状态为 `ProtocolUnavailable`，`settings.providers.test` 也不得向猜测的路径发请求；这不是把未知协议默认为 OpenAI 兼容。
- provider 无关请求 schema 固定为：`TranslationRequest{operation, idempotency_key, model_ref, source_language, target_language, segment_id, source_text}`；`SummaryRequest{operation, idempotency_key, model_ref, window_id, prior_summary_revision, segments}`；`QaRequest{operation, idempotency_key, model_ref, context_scope, question, cited_segments, policy_snapshot_id}`。adapter 只把这些 DTO 映射到已验证 manifest，不能让会议文本决定 system prompt、工具或 context scope。
- 翻译优先单段或最多 8 段小批量，摘要使用“增量窗口 + 上次稳定摘要”，Q&A 只发送策略允许的上下文、摘要和必要引用。翻译并发最多 2、摘要最多 1、Q&A 最多 1；每次请求都带幂等键，避免重试重复生成 item/turn。
- 健康检查不包含会议文本；连接超时 5 s，首字节超时 8 s，翻译总超时 15 s，摘要 30 s，Q&A 60 s。支持取消的流式请求必须中断 transport、落库 `cancelled` 终态；不可取消的请求在本地停止消费并标记“已发送但未确认”。限流读取 manifest/响应的 retry-after，单次等待上限 60 s，超过则交给用户重试。
- 会议文本放入结构化不可信数据段，模型输出只接受通过 JSON/schema 校验的文本、状态和引用 ID；拒绝工具调用、外部 URL、越权引用和未在请求范围中的 segment ID。Token 只在 Rust/OS secret store 中读取；前端永远不获得 token，不把请求头、完整请求体、原始响应或 token 计数写入普通日志。
- MiMo 不可用时，原文、会话保存和本地导出仍可使用；翻译/摘要/Q&A 各自降级，不造成全局录音失败。错误映射固定为 `ProviderNotConfigured`、`ProtocolUnavailable`、`Network`、`RateLimited`、`InvalidInput`、`Cancelled` 或 `Unknown`，不把 provider 原始字符串直接展示给用户。

### 10.3 网络、TLS 与重试

- 仅允许 `https`，证书校验必须启用；禁止 HTTP、IP literal、用户名密码、query token、fragment token、跨 scheme 重定向和将凭据转发到重定向目标。MiMo 默认 host 只允许 `token-plan-cn.xiaomimimo.com`，iFlytek 只允许已验证 manifest 声明的官方 host；自定义 endpoint 必须是用户明确输入并确认 host 的新配置，后端保存 host allow entry，后续请求只允许该精确 host/port。
- 自定义 endpoint 连接前校验 DNS 解析结果，拒绝 loopback、link-local、multicast、私有网段、保留地址和解析结果在请求间变化；禁止 `file://`、Unix pipe、任意本地代理目标。系统代理默认关闭；用户显式启用时仅使用 Windows 系统代理，仍对最终 TLS host 和重定向执行同样校验，防止 SSRF。
- 默认 base URL 不能被设置页改写；自定义地址显示完整 origin、证书主机和风险说明，必须由用户确认后才允许写入。正在录音时拒绝变更 endpoint，避免一路使用旧 endpoint、另一路使用新 endpoint。
- 重试采用最多 3 次、1/2/4 s 加抖动、总时限受第 10.2 节操作超时约束；认证失败、输入不合法、权限拒绝、协议不支持和 SSRF 校验失败不重试。网络错误文案区分“尚未发送”“已发送但未确认”“provider 返回失败”，让用户知道隐私和数据状态。
- 凭据路径固定为：发布版只从 Windows Credential Manager/DPAPI 读取，用户的 write-only IPC 只是更新该存储；开发版同样先读安全存储，仅在没有值且进程以 development 标志启动时读取 `.env`。环境变量只作为一次运行 fallback，永不写回或打包；发布包不自动读取 `.env`。缺失 iFlytek 凭据进入“填写并测试”的首次配置流程。

## 11. 持久化、隐私与数据生命周期

### 11.1 默认策略

- 默认保存：会话标题、时间、设备显示名/稳定 ID 的脱敏形式、原始/修订文字、译文（若用户开启）、摘要、Q&A、处理状态和错误摘要。
- 默认不保存：原始 PCM、临时音频 chunk、完整 provider 请求/响应、完整密钥、音量原始波形。
- 原始音频是显式开关，开启时在新建会议和录音中持续显示；停止后按用户设定写入本地受保护目录，并允许在会话详情单独删除。
- 开始会议前显示云端处理说明；用户可以分别同意或关闭 `iFlytek × ASR`、`MiMo × translation`、`MiMo × summary`、`MiMo × qa` 四项用途。用户可以选择不启用翻译/摘要/Q&A，但不能在未同意云端 ASR 时偷偷上传音频。`privacy_policy.consents` 对每个 `provider × purpose` 保存 `{provider, purpose(asr|translation|summary|qa), granted, granted_at, policy_version, revoked_at}`；开始/恢复前后端都校验相应同意。录音中撤回 ASR 立即停止对应 source 的上传与 stream；撤回翻译/摘要/Q&A 只停止该能力并保留已发送文本，不撤销已完成的 provider 处理，后续请求全部拒绝并显示撤回时间。

### 11.2 存储分层

使用 Rust 管理的本地数据库保存结构化会话和事件索引，应用数据目录保存可选的加密音频/导出文件。数据库文件、WAL、journal、临时导出和可选原始音频统一使用本地数据密钥加密；数据密钥由 Windows DPAPI/用户范围保护，进程不把明文密钥交给 React。若底层 SQLite 加密方案不支持加密 WAL，则禁用 WAL 并使用受保护的 rollback journal，不能以明文临时文件作为替代。数据库迁移带 schema 版本；事件和摘要使用 revision，确保 provider 重试不会覆写已确认的历史版本。

敏感配置优先使用 Windows Credential Manager/DPAPI；provider 凭据只通过后端运行时读取。`data.clear` 先停止任务，再在事务中删除会话索引/事件/译文/摘要/Q&A 和临时队列，删除关联音频与导出文件，清理 SQLite WAL/journal/备份文件并执行受保护数据库的 vacuum/rekey；每一步报告成功或失败类别。SSD/备份介质无法保证取证级安全擦除，产品文案明确这是“逻辑删除并清理应用文件”，不作不可证明的安全删除承诺。

### 11.3 用户控制

- 会话详情：导出 Markdown/JSON（明确原文、译文、摘要、引用和 Q&A 来源），删除会话，删除原始音频，重新处理文本。
- 设置：关闭云端翻译、关闭自动摘要、禁止 Q&A 使用历史会话、设置原始音频保留期限。`allow_history_qa=false` 时后端拒绝 `all_sessions`，并让 Q&A 只能使用 `current_session`、`current_topic` 或 `selected_segments`；跨会话检索与 prompt 上下文在 Rust 端按策略隔离。
- 默认不上传遥测；若提供诊断上传，必须单独同意，且只含聚合性能指标。`data.clear` 既是设置页的“清除全部数据”入口，也是首次运行/数据库故障恢复的明确破坏性操作；执行前列出会删除的会话、音频、导出和凭据类别，执行中可取消尚未开始的类别，完成后逐类报告。
- 录音指示器持续可见；支持会议开始前的“我已获得参会者同意”确认文本，但不将其作为法律合规保证。

## 12. 性能、延迟与资源策略

以下是首版目标值，用于基准测试，不是对第三方 provider 的无条件承诺；测试需在 Windows 10/11、典型蓝牙设备、16 GB 内存的参考机器上记录 p50/p95。

| 指标 | 目标 |
|---|---:|
| 设备枚举/状态刷新 | p95 ≤ 500 ms |
| 音频采集回调阻塞 | 不阻塞；单次处理目标 < 2 ms |
| 音频到 partial ASR 展示 | p50 ≤ 1.0 s，p95 ≤ 2.0 s（网络正常） |
| final 结果落库/显示 | 收到 provider 结果后 ≤ 150 ms |
| 翻译开始 | final 后 ≤ 500 ms 入队 |
| 翻译完成 | p50 ≤ 2.0 s（网络正常） |
| 增量摘要 | 达到窗口阈值后 ≤ 8 s；不阻塞转写 |
| Q&A 首 token | p50 ≤ 3 s（网络正常）；支持取消 |
| UI 输入响应 | 常规交互 p95 ≤ 100 ms |
| 长会话 UI | 2 小时/约 20,000 segment 仍可滚动，内存无线性失控 |
| 音频丢帧 | 正常网络和 CPU 预算下 0；异常时可观测并及时暂停/降级 |
| 音频来源 ring buffer | 每来源 2 s（约 256 KiB 的 16 kHz mono f32） |
| ASR 发送队列 | 每来源 8 × 20 ms = 160 ms；积压 > 100 ms 发警告 |
| 翻译/摘要/Q&A 并发 | 翻译 2、摘要 1、Q&A 1；队列分别 32、2、1 |
| UI 事件频率 | 电平 10 Hz、partial 每来源 5 Hz、metrics 1 Hz |
| 应用额外内存 | ≤ 512 MiB（不含模型）；超过预算记录指标并停止扩张 |
| CPU | 平均 ≤ 25%，峰值 ≤ 50%（不含 provider 等待） |
| 数据库搜索 | p95 ≤ 300 ms；无结果必须有独立空结果状态 |
| 离线文本积压 | ≤ 10,000 final segment；超过后暂停智能任务，不丢原文 |

实现策略：

1. WASAPI reader 只把 PCM 复制到有界 SPSC/ring buffer；格式转换、downmix 和重采样在消费任务执行。首版每帧 20 ms；来源 ring buffer 目标容量 2 s，ASR 发送队列 160 ms，满载时按来源计数并触发 100 ms 积压阈值。
2. 采用持久化 fixed-rate resampler；只有检测到时钟漂移时才做异步校正。
3. 保持输出和麦克风各自的 ASR stream；只有时间线和智能上下文层合并，避免一条坏源拖住另一条源。
4. partial 事件节流到 UI 可感知的频率，final 事件立即落库；转写列表使用虚拟化/窗口化渲染，避免 20,000 个 DOM 节点同时存在。
5. 摘要按字数/时间窗口增量更新，并压缩旧上下文；Q&A 仅发送选定范围、摘要和必要引用，不把整个数据库加载到前端。
6. provider 流式响应可取消；结束会议时先停止采集，再在有限时间内 flush 结果，超时也保存当前快照并标记未完成。
7. UI 音量表只保留短时聚合值；不为绘制电平保存原始音频，不在 React 状态中存 PCM。
8. 发生队列积压时优先保护实时采集和 final 结果，翻译/摘要可延迟；明确显示“智能处理落后”而非静默丢文本。参考机器预算为应用额外常驻内存 ≤ 512 MiB（不含模型）、CPU 平均 ≤ 25%/峰值 50%（不含 provider 网络等待）；数据库搜索 p95 ≤ 300 ms，离线文本积压最多 10,000 个 segment，超过后暂停智能任务并保留原文，不无限排队。

### 12.1 图标资产规范

- `docs/assets/meeting-master-icon.svg` 是本项目原创的 AI-authored SVG 矢量概念，不声称由图像生成模型产生，也不取用 LetShare 的品牌图形。LetShare 视觉风格尚未核验，图标不代表其复刻。
- 画布固定为 `256 × 256`；主图形仅使用本地几何和纯色，无位图、脚本、网络资源或外部引用。深蓝单层圆角底板承载一个粗体、可独立识别的 `M` 形会议信号；左右两个色点表达双来源。新版不使用渐变、滤镜、细小气泡、嵌套底板或文字 caption，避免在 Windows 任务栏尺寸下糊成一团；`title`/`desc` 只提供可访问语义，caption 仅属于可审阅的 mockup 画布，不进入 bundled icon。
- 所有主轮廓使用整数坐标和大色块：外框、`M` 形路径和双来源点在 16/24/32 px 仍保留连续 alpha 边界；不依赖文字传达图标含义。栅格验收检查透明边缘、主轮廓无断裂和双来源点可辨识；不以 icon 中不可读的说明文字作为验收项。
- 若本机缓存可用，可按固定链路使用 `@resvg/resvg-js@2.6.2`（resvg core）+ `png-to-ico@3.0.2`：在仓库外临时目录栅格化到 `16,24,32,48,64,128,256,512` PNG，再用 `[16,24,32,48,64,128,256]` 生成 `meeting-master.ico`。构建日志需记录 SVG SHA-256、包版本和 Node 版本；不得把临时 PNG、ICO、依赖或缓存提交到仓库。Tauri 未来统一使用 `bundle.icon = ["icons/meeting-master.ico", "icons/meeting-master-32.png", "icons/meeting-master-128.png", "icons/meeting-master-256.png"]`，不维护第二套手工图标源。
- 应用内小尺寸可以使用同一源的无阴影单色变体；录音/选中状态必须由颜色、文本和状态区域表达，不能只把图标染红。

## 13. 可访问性与动效

### 13.1 可访问性

- 全部功能可用键盘操作：`Ctrl/Cmd+Enter` 提问，`Space` 暂停/继续（焦点不在文本输入时），`Ctrl/Cmd+K` 聚焦会话搜索，`Esc` 关闭 drawer/dialog；快捷键列表可查看和修改。
- 焦点环固定为 `2px solid`，浅色主题使用 `#194FAF`、暗色主题使用 `#B7C9FF`，距控件外缘约 `2px`；不以 `outline: none` 消除焦点。焦点顺序从标题/录音状态到转写，再到伴侣面板和底部控制；overlay 打开后焦点进入标题或首个控件并 trap，关闭后恢复触发按钮；Dialog 同样 trap 且 `Esc` 取消。
- 录音、暂停、设备断开、无信号、provider 错误同时使用图标、文本和状态区域；`aria-live` 只播报 final、设备变化和终态错误，partial 不逐字朗读造成噪声。
- 正文、按钮、焦点和状态满足 WCAG AA；支持暗色主题、Windows 高对比度、`prefers-contrast: more` 和 100%–200% 文本放大。高对比模式使用接近实色表面、明确的对比边框和更强焦点，不依赖透明度或灰色小字。
- 每个图标按钮有可访问名称，tooltip 只是补充；计时、电平、队列和更新状态使用稳定数字布局。电平必须提供文本等价物，例如 `系统输出电平中等，麦克风低`，并允许关闭动态电平动画。
- `prefers-reduced-transparency: reduce` 时取消 blur、提升表面不透明度；`prefers-reduced-motion: reduce` 时取消滚动/骨架动画和 pulse。自动化验收覆盖 1120 × 700、125% 和 150% Windows 缩放：停止录音、来源状态、焦点环、overlay/Dialog 进入与恢复、搜索无结果、loading/error/cancelled 重试均可键盘完成，不能横向滚动或被裁切。

### 13.2 动效原则

- 反馈从按下开始：按钮和切换在 pointer-down 立即改变颜色/压感；提交仍在 pointer-up 完成。交互中的拖拽、drawer 位移和滚动指示 1:1 跟随输入，不用固定延迟。
- 默认状态变化使用短的 opacity/transform 和 critically damped spring（damping ratio `1.0`、response `0.3–0.4s`），不 bounce、不 stagger、不对 partial 文本逐字动画。录音点可低频低幅 pulse，但始终显示静态 `正在录制`。
- drawer/伴侣面板从触发按钮的空间方向进入并沿同一路径退出；动画从当前 presentation value 开始，任何时刻可抓取、反向和取消，不能锁定输入。只有真实 drag/flick 释放才继承速度、做 momentum projection 或轻微回弹（约 damping `0.8`）。
- 不使用 `transition: all`、全视口移动背景、慢速循环或把焦点抢走的进入动画。状态错误/取消/完成以可读的短 cross-fade 表达，不能用位移掩盖文案。
- `prefers-reduced-motion: reduce` 时把 slide/spring 替换为不超过约 200 ms 的 opacity/color cross-fade，移除 pulse、stagger、骨架闪烁、自动滚动动画和回弹，但保留按下反馈、焦点变化和状态颜色；`prefers-reduced-transparency: reduce` 与 `prefers-contrast: more` 的表面 fallback 独立生效。静态 SVG 只能展示这些模式的静态视觉样本（实色 surface、无 pulse、强边框/焦点环），不能证明真实动效、焦点 trap 或可逆 drawer 已实现；这些行为仍以第 14.3 节实际窗口验收为准。

## 14. 验收标准

### 14.1 功能验收

- [ ] 首次运行能解释输出 loopback 与麦克风的区别，并在没有设备/权限时给出下一步。
- [ ] 能枚举、选择和记住稳定的 Windows render endpoint 与 input endpoint；不因系统默认设备改变而静默换设备。
- [ ] 选择真实蓝牙耳机播放语音时，loopback 有可识别 PCM；采集不要求蓝牙协议或虚拟声卡。
- [ ] 输出和麦克风可以独立成功/失败；至少一路可用时，用户明确确认后才允许降级开始。
- [ ] 录音中能显示 partial/final ASR；final 不因后续 partial 重复，时间线顺序稳定并可定位来源。
- [ ] 翻译失败不删除原文；摘要更新有旧快照；Q&A 无证据时不会生成确定性幻觉答案。
- [ ] 能暂停、继续、结束并保存；结束时尽力 flush，超时也保留可恢复会话。
- [ ] 会话库支持搜索、历史详情、导出和删除；已删除会话深链显示可恢复错误页。
- [ ] 设备断开、重连、默认设备改变和 A2DP/HFP 切换都有明确状态、日志事件和恢复动作。

### 14.2 集成与隐私验收

- [ ] iFlytek 接入是实时流式路径，不调用远端 ECS tianye 文件上传/轮询接口。
- [ ] MiMo 请求只从 Rust 发出，默认 base URL 正确；在官方 `MimoTokenPlanContract v1` manifest、health fixture 和三类 golden response 未通过前，测试必须得到 `ProtocolUnavailable` 而不是发送猜测请求；前端 bundle、IPC 事件、日志和导出包不含 token/密钥。
- [ ] provider 未配置时可看到具体缺失能力；网络、限流、认证错误可区分且不无限重试。
- [ ] 默认不写原始音频；显式开启后有持续指示、独立删除和保留策略。
- [ ] 诊断导出不含原始 PCM、凭据、完整 provider 请求/响应或未授权的会议正文。
- [ ] 本地删除操作删除会话索引、译文、摘要、Q&A 及按选择删除音频，并报告结果。

### 14.3 性能、设备与可访问性验收

- [ ] 通过目标 p50/p95 延迟、内存、CPU、队列和丢帧基准；2 小时长会话不卡死、不无限增长；验证每来源 2 s buffer、160 ms ASR 队列、10/5/1 Hz UI 事件和 512 MiB 内存上限。
- [ ] 实测断开/重连、输出设备切换、麦克风切换、HFP 触发、静音、无活动输出、不同采样率、loopback 不可用、独占模式、DRM/受保护内容，并验证每一类状态有独立文案、事件和恢复动作。
- [ ] 以键盘完成新建、开始、暂停、结束、搜索、提问、重试和导出；屏幕阅读器能读出状态和错误。
- [ ] 检查浅色、暗色、高对比、125%/150% 缩放以及减少动态效果/减少透明度模式；执行语义颜色自动化对比度测试，确认 `source.output` 只用于来源/图形或大号文本，`text.secondary` 在普通文本场景达到 WCAG AA。
- [ ] 在 1120 × 700 最小窗口下停止录音、设备状态和当前转写仍可操作且不需要横向滚动。

## 15. 设计审计与未验证项

### 15.1 本轮自审结果

- **空白项扫描**：本文没有 TODO、TBD 或空白待填项；“未验证”描述的是 BrowserOS Neo 尚未连接或官方协议夹具缺失的已知边界，不把未知实现写成已完成。
- **架构一致性**：本轮只改视觉令牌、布局、动效、可访问性和静态 SVG；路由、命令/事件网关、Rust 音频/网络/密钥边界、远端 ECS 排除和状态矩阵保持不变。
- **协议边界**：iFlytek 与 MiMo 仍以官方 manifest、health/golden fixtures 作为联网硬门槛。`ProtocolUnavailable` 时设计稿明确没有健康、测试或重检操作，不发送猜测请求；凭据存在和 provider readiness 在所有相关稿件中分开呈现。
- **状态完整性**：既有状态矩阵仍覆盖首次运行、空库、loading/empty/error/cancelled、权限/设备缺失、无活动输出/静音/loopback 不可用/独占/DRM/格式不支持、重连/HFP、partial/final ASR、翻译等待/失败、摘要更新/空/失败、Q&A 无上下文/无答案/错误、provider 未配置/协议未验证/网络错误、迁移/磁盘/删除/导出和历史恢复。
- **隐私一致性**：原始音频默认不保存；provider × purpose 同意、write-only 凭据提交、Rust 再校验文本范围和数据库/WAL/临时文件边界没有改变。新稿只把“音频会离开本机”和“原始音频不保存”放到用户做决定的近处。
- **性能一致性**：事件序号、窗口化长会话、有界队列、2 s 来源 buffer、160 ms ASR 队列、10/5/1 Hz 事件、512 MiB 内存预算和实时/智能分别降级仍由原技术章节约束。
- **视觉与静态资产审计**：四张 mockup 均是 1440 × 900，并含可见的独立 provisional caption；图中 `1120 × 700` 注释是实现验收契约而不是按比例缩放的窗口证据。canonical icon 不放入 caption：标题/描述提供可访问语义，避免任务栏尺寸把说明文字栅格化为噪声。SVG 采用本地几何、无脚本、无外部引用，ID/ref、XML、尺寸和 stale branding 检查在本轮命令中验证。若本机存在缓存的 resvg，只在仓库外做临时栅格检查，不把生成物或依赖写入仓库。

### 15.2 静态 SVG 概念屏幕

以下四张图是基于本稿 Windows system UI 字体、安静画布令牌与 1440 × 900 桌面基线绘制的静态 SVG 概念屏幕，用于评审信息层级、状态文案和 1120 × 700 收窄策略；它们只改设计文档和静态矢量资产，不是 React/Tauri 应用代码，也不承诺已实现交互：

- [实时工作台](assets/mockups/live-workspace.svg)：转写优先的开放画布；双来源 final/降级状态、底部近控制区双电平、可收起摘要/Q&A 伴侣面板。
- [空会话库](assets/mockups/empty-library.svg)：不套大卡片的空状态、搜索命令行和第一场会议入口。
- [新建会议](assets/mockups/new-meeting.svg)：平面分段准备流程、双源差异、隐私同意、权限错误，以及凭据存在与 `ProtocolUnavailable` 分离的开始前状态。
- [音频与 Providers 设置](assets/mockups/settings-audio-providers.svg)：endpoint、麦克风、A2DP/HFP 警告、3 秒本地电平测试，以及协议未验证时不显示 health/test/recheck 动作的 fail-closed provider 行。

四张 mockup 都包含可见的 `Meeting Master · provisional Apple Design direction; LetShare style not yet verified` caption；它们固定为 1440 × 900，不能证明 1120 × 700 已实现响应式重排、drawer、sticky controls 或内部滚动。图中 compact 注释只记录实现契约；实际验收必须在最小窗口和 125%/150% 缩放下检查没有横向溢出、裁切或不可达控件。canonical icon 刻意不放 caption，以保证 16/24/32px 栅格可读。BrowserOS Neo 未连接，因此没有对 LetShare 进行视觉检查，也不声称其颜色、布局、组件或品牌资产被复现；这些是本项目独立的 Apple Design 方向概念稿。

### 15.3 LetShare 视觉核验清单

BrowserOS Neo 可用后，在不复制其资产的前提下进行以下小范围对比，并将结论写入后续设计修订：

1. 对照首页/主工作台：确认其信息密度、主导航位置和主操作层级；记录与本稿三栏工作台是否冲突。
2. 对照录音/实时状态：比较录音按钮、暂停/结束保护和状态反馈是否清晰；本稿必须保留“文本 + 图标”双重反馈。
3. 对照主题和表面：比较色彩温度、圆角、阴影和深浅主题；只吸收可验证的视觉原则，不复制颜色值或品牌图形。
4. 对照空状态/错误状态：确认空库、断线、权限和历史页是否需要更强的引导层级。
5. 对照响应式行为：在 1120 × 700 和宽屏窗口检查其是否有可借鉴的面板收起方式。
6. 对照图标语义：确认本原创 `M` 形会议信号与双来源色点在 16/32/64 px 下仍可辨识，不将 LetShare 图标作为素材来源。

在完成上述核验前，本文的视觉方向必须视为本项目独立的临时基线，而不是 LetShare 的已验证风格复刻。
