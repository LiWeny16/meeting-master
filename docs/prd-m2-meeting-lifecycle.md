# PRD · M2 — 会议记录生命周期（Meeting record lifecycle）v2

状态：待实现（本版替换 v1）。基线：`docs/delivery-record.md`（D2 未解）、`docs/code-standards.md`、`docs/ui-design-system.md`。实现后回填 `delivery-record.md` §2/§4。

v1 的缺陷是只有能力规格、没有用户定义，于是每次评审都在「这个细节要不要做」上重吵一遍。v2 先用 PART A 把用户与取舍钉死；PART B 的规格一律以主目标用户为准，与它无关的细节删除或延后，并在 B5 逐条交代。

三个跨能力不变式：
1. 数据根 `./data` 本身就是交付物：一场会 = 一个文件夹 + `meetings.json` 里的一条记录。
2. 任何写操作失败都必须把 Rust 原始错误串透出到 UI，禁止替换成通用文案。
3. 不打磨「AI 更聪明」，只打磨「这场会能不能被交出去」。

## PART A — 产品定义

### A1 目标用户

| 段 | 一句话画像 |
|---|---|
| S1 会议记录责任人 | 中文为主的技术/产品团队里的 PM、技术负责人、项目 PMO，每周 5+ 场跨部门会，散会后 30 分钟内要在群里交一份书面纪要（结论 + 待办） |
| S2 访谈/调研研究员 | 每周 2–5 场 1v1 深访，录音要变成文本进编码表或交给业务方，同一段材料会被反复引用 |
| S3 需留档的咨询/法务从业者 | 会议记录是对客户的交付凭证，关心可追溯、未被篡改、能按案例归档 |

**M2 主目标用户 = S1。** 三条理由：

1. 只有 S1 同时满足两个前提：会议已在本应用里跑完（有 `transcript.jsonl` 和 `summary`），且产物要交给会外的人读。M2 的四个动词全在「记录 → 交付」这条尾巴上。
2. S1 的痛点能被文件级动作解决，不依赖后端能力；S2 的痛点更靠转写质量与外部工具集成，S3 的痛点靠证据链，M2 结构上给不了。
3. S1 的一天就能覆盖全部验收路径（开会 → 改名 → 清一次错纪要 → 导出交出去），不必构造研究场景。

**明确不服务的段（M2 内）：** S3 的「存档合规」用途（无哈希、留痕、保留期，`exports/*.txt` 谁都能改写，本版不承诺合规）；纯会中消费者（只看实时字幕、会后不回看，而 M2 全发生在会后）；团队/多机用户（无账号无同步，产物只能靠用户自己传）；移动端与非 Windows 桌面用户。

### A2 使用场景

- **U1 会后 10 分钟，还在会议室收拾东西。** 评审会刚结束，用户要赶在午饭前把结论发出去。列表里这场会叫「未命名会议」，靠时间戳分不清是和谁的会。想改名 → 今天没有入口（D2）。
- **U2 下午回到工位，打开 `SummaryPage`。** 助手写的纪要整段跑偏（被某段闲聊带偏），而录音和转写是花一小时换来的原始材料。用户想只扔掉那段文字 → 今天唯一选项是连会议一起删（D1）。
- **U3 晚上回听访谈，要把每句贴进编码表。** `transcript.jsonl` 每行一条 JSON、时间戳是帧号，给人看不了，用户只能临时写脚本。缺的不是「导出能跑」，是「人能直接读」——这是 M2-3 的真实理由。
- **U4 一周后同事来要原始记录。** 用户自己也不知道文件在哪：数据目录是工程结构 `data/recordings/meetings/<id>/`，任何界面都没有「在资源管理器里定位」的入口。映射：U1 → M2-1；U2 → M2-2；U3/U4 → M2-3。

### A3 核心任务（JTBD）

| # | 任务 | 必须存在的工作流 |
|---|---|---|
| JT1 | 当我刚结束一场会、标题分不清是哪场，我想给它一个一周后还能认出来的名字，这样我不靠时间戳回忆 | 行菜单 / `F2` → 对话框 → 写 `meetings.json.title` → 行内就地更新 |
| JT2 | 当我发现纪要方向写错了，我想只扔掉那段文字、保住录音和转写，这样我能重生成而不毁掉原始材料 | 行菜单 → 二次确认（写明行动项保留）→ 清 `summary` |
| JT3 | 当我要把这场会交给不在场的人，我想拿到一个双击就能打开的文本文件，这样对方不用装这个应用 | 行菜单 → 导出 → `exports/*.txt`（人可读，带四要素头部） |
| JT4 | 当我需要核对一句原话，我想在文件管理器里立刻看到那份文件，这样我能把它拖进别的工具 | 导出后自动 Explorer 选中 + toast action 可重试定位 |
| JT5 | 当我确信一份记录不再需要，我想把记录连同音频一起从本机删掉，这样不会留下我不知道的副本 | 已交付（M1 `meetings_delete`），M2 只回归验证，不重做 |

### A4 现状与替代方案

S1 今天怎么做：Windows 录音机（或手机录音）+ Word 手打 + 会后凭记忆补结论；或者干脆把会议搬进飞书妙记 / 腾讯会议纪要 / 讯飞听见。云端方案在「转写质量 + 自动纪要」上明显强于本产品，本产品**不在这两条上竞争**。必须明显更好的只有两条：

1. **本地留存、无上传。** 原始音频与转写始终是本机普通文件，无账号、可离线核验；S1 团队内的涉密评审会不允许把音频送到别人的服务器。
2. **可交付的文件结构。** 一场会 = 一个文件夹 + 一份人可读文本，Word、编辑器、脚本都能直接消费，不依赖本应用在线；云端方案的导出是二等公民（先入会、再点导出、格式由平台定）。

除这两条之外不做任何宣传性表述：不承诺「更准」「更快」「更懂会议」。

### A5 成功度量

| 信号 | 目标 | 如何测量 |
|---|---|---|
| S-1 交付闭环率 | 最近 30 天 `status=completed` 且有转写的会议中，≥ 40% 被导出过 | 扫 `exports/*.txt` 头部 `Meeting ID:` 反查 `meetings.json`；纯静态扫描，不需要埋点 |
| S-2 默认标题残留率 | 最近 30 天新建会议里 < 10% | `meetings.json` 中标题为空 / `Untitled meeting` / 纯日期形态的占比 |
| S-3 失败可诊断率 | 100% | 逐条注入失败（目录只读、删后重试、越界 reveal），toast `detail` 与 Rust 原文逐字比对，结果记入 `delivery-record.md` §2 |
| S-4 不可恢复误操作投诉 | 0 起 | 用户反馈手工统计；任一投诉即视为 M2 设计缺陷，回到 D1 的可恢复性决策 |

### A6 明确不做（产品级）

1. 云同步 / 多端 / 分享链接 —— 等于用「无上传」换云存储，直接放弃 A4 第 1 条优势。
2. 账号体系与团队权限 —— 单机单用户，权限模型没有承载对象。
3. 实时字幕投屏 / 直播场景 —— 与「会后交付」是两条产品线，抢的是会中稳定性预算。
4. macOS / Linux —— Explorer 定位、DPAPI 密钥、音频通路都是 Windows 专属，属重写不属适配。
5. 摘要与转写质量调优 —— M2 只解决「有没有、能不能交出去」；质量要用评测集单独衡量，混进来会让验收标准不可判定。
6. 合规级证据链（哈希、留痕、保留期、脱敏）—— 面向 A1 的非目标段。
7. 会议内容全局检索 —— 属于「回看」产品线，M2 只做单场会议的交付动作。

### A7 未知与假设（全部未验证，按假设对待）

- **H1** 真实卡点是「找不到、认不出、交不出去」，而不是「摘要不够聪明」。无用户访谈、无使用日志；证据只有 D2 的缺陷记录与本仓库的数据结构。
- **H2** 纯文本 `.txt` 足够交付（能贴进 Word / 飞书文档 / 邮件）。没观察过真实交付格式；Markdown / SRT 可能是硬需求，也可能是伪需求。
- **H3** 主用户群以中文为主。依据只有 ASR 适配器默认配置与 zh-CN 文案优先级，没有语言分布数据。
- **H4** 用户接受导出目录固定在 `<data_root>/exports`（不能自选）。用「少一个系统对话框 + 文件名可断言」换「用户少一次选择」，未验证。
- **H5** 清空纪要后用户会重新生成，而不是放弃这场会。未验证；若出现「清完就丢」的反馈，应让「从转写重生成」优先于「清空」。

## PART B — M2 范围与规格

范围：M2-1 Rename（JT1/U1）· M2-2 Clear recap（JT2/U2）· M2-3 Export transcript + reveal（JT3+JT4/U3+U4）· M2-4 生命周期动词审计（只记录，不实现）。

### B0 共通契约（实现者先读这一节）

**入口与键盘。** 鼠标：`src/pages/MeetingsPage.tsx` 行右键 → `ContextMenu`。键盘：行 `tabIndex=0` 聚焦后 `Shift+F10` 或 `ContextMenu` 键 → 同一份 items（已实现），`↑ ↓ Home End` + `Enter` 选择，`Esc` 关闭并把焦点还给行。新增快捷键只有 `F2`（重命名），仅在行本身获得焦点时生效（`event.target === event.currentTarget`）。

**菜单顺序（固定 7 项）**：打开 · 重命名… · 复制标题 · 复制会议 ID · 导出转写… · ⟨sep⟩ 清除纪要… · ⟨sep⟩ 删除会议…。`separatorBefore` 用在「清除纪要」和「删除会议」前。

**状态词汇（每个动词齐 5 态）。** default = 常态；pending = 该项 `disabled` + 行 `aria-busy="true"`；success = `success` toast；failure = `error` toast，`title` 用本地化兜底文案，`detail` 是 Rust 返回的原始错误串（禁止吞掉、禁止改写成通用文案）；retry = 失败后该项仍可再次触发（不做一次性禁用）。

**原生不可用（browser shell）。** 三条能力在 `!isTauri()` 时仍然渲染（与「删除会议…」一致），调用后由服务层抛出真实原因并走 failure toast；不加灰色死按钮，也不隐藏菜单项。三条能力的差异只在于对话框是否保持打开，见各节。

**焦点与刷新。** 写操作成功后就地更新列表数据（不整页 reload），焦点保持在同一 `meeting.id` 上以便连续 `F2`；若搜索结果因重命名不再匹配而消失，焦点退到 `.row-list` 容器 + success toast，不静默清空列表。重命名与清除纪要写进 `meetings.json`（重启后仍在）；导出产物是普通文件，与应用状态无关。

### B1 M2-1 重命名（Rename）

**用户故事。** 作为刚开完会的 S1，我想把「未命名会议」改成真实议题，这样列表和导出文件名都能认出来。

**形式：对话框，不是行内编辑。** 行 `<li>` 是 `role="link"` + `Enter/Space` 打开会议，内嵌 `<input>` 会把可编辑控件塞进链接语义、吞掉 `Enter` 并与 click-to-open 抢事件。对话框沿用 `ConfirmProvider` 已建立的 MUI `Dialog` 外观（`--sh-3`、`--r-md`），校验文案、pending、失败保持打开重试都能在一处收口。代价是多一次点击，接受。

| 状态 | 表现 |
|---|---|
| default | 标题 `renameMeetingTitle`；单行输入（`autoFocus`，内容全选）；辅助文案 `renameMeetingHint`；主按钮 `save`（contained）；次按钮 `cancel`（outlined） |
| empty | `trim()` 后为空 → 主按钮 `disabled`，输入下方内联错误 `renameTitleEmpty`（不用 Alert）；与当前标题 trim 相同 → 同样 `disabled`，关闭后不写盘不弹 toast |
| pending | 主按钮 `disabled` + `CircularProgress size=16`；输入 `disabled`；`Esc` / 点背景不关闭（防丢写） |
| success | 关闭对话框；`success` toast `meetingRenamed`，`detail` = 新标题；行标题就地更新 |
| failure | 对话框保持打开，`detail` = Rust 原文；主按钮恢复可点；不改内存数据 |

**边界。** 长度上限 120，前端用 `[...value].length`、Rust 用 `chars().count()`，按 code point 计（ZWJ/旗帜 emoji 会被算成多个，已知限制，接受）。首尾 `trim`，中间空格与大小写保留。标题含 `\n` 或路径分隔符：允许（标题不参与任何路径，导出名单独 slug 清洗，见 B3）。正在录制的会议允许重命名（标题是元数据，录音目录名用 `meeting.id`）。会议已被另一窗口删掉：Rust 返回缺失错误，toast 后刷新列表。

### B2 M2-2 清除纪要（Clear recap）

**用户故事。** 作为现场发现纪要写错的 S1，我想清掉它并从零重生成，而不是把整场会议删掉。

**决策：只清 `summary`，保留 `actions`。** 纪要是一次生成的整段文本，可由助手整段重写；行动项带 `completed`、`owner`、`dueDate`，是用户已经处理过的独立数据，隐式删除等于毁掉工作。行动项的清空进 B4 backlog（单独动词 + 单独确认）。因此确认文案必须写明「行动项会保留」。

| 状态 | 表现 |
|---|---|
| default | `summary` 非空时可用；`trim()` 后为空时该项 `disabled`（行副标题已显示 `summaryUnavailable`，不加解释文案） |
| pending | 确认按钮 `disabled` + spinner；对话框不响应 `Esc` |
| success | `success` toast `summaryCleared`，`detail` = 会议标题；行副标题回落 `summaryUnavailable`；`SummaryPage` 显示 `summaryNotGenerated` |
| failure | `error` toast `summaryClearFailed` + Rust 原文；数据不变 |

**边界。** 纯空白 = 空。录制中允许清除（与录音无耦合）。与助手 `save_meeting_summary` 并发时以最后一次写为准，本轮接受该竞态并在 `delivery-record.md` 记一条观察项。第二次进入时该项已 `disabled`，不存在「清两次」。会议已不存在 → 错误 toast + 刷新列表。

### B3 M2-3 导出转写（Export transcript）+ 定位文件

**用户故事。** 作为要交差的 S1，我想把转写交给同事或存档，并且能立刻在文件管理器里看到那个文件。

**决策：无系统「另存为」对话框，写到 `<data_root>/exports/`。** 数据根的产品决策就是「用户可见的普通文件」（`delivery-record.md` §1），`exports/` 与之同源、可备份可交接；也避免为一次导出引入 `tauri-plugin-dialog` 与新 capability。文件名确定性生成，可测试、可断言。

**文件名。** `YYYYMMDD-HHmmss__<slug>.txt`；`slug` = 标题 trim → `[\\/:*?"<>|]` 与控制字符换 `-` → 折叠连续 `-` → 去首尾 `-` 和 `.` → 截断 60 chars，空则 `meeting`。时间戳取 `endedAt ?? createdAt` 的本地时间。**不覆盖任何已有文件**：同名依次尝试 `-2`、`-3`（与 `code-standards.md` §3 的「后缀 `-2`」对齐，规范优先），50 次后返回明确错误。

**文件内容。** UTF-8 无 BOM、CRLF；头部固定 5 行：`Title:` / `Meeting ID:` / `Date:`（同上本地时间，`YYYY-MM-DD HH:mm`） / `Segments:` / 空行；随后每 segment 一行 `[HH:MM:SS] <source>: <text>`，按 `sequence` 升序，`source` 逐字取 `TranscriptSource` 的 `microphone|system-output`。只导出已定稿行（`transcript.jsonl`），部分结果不导出，行尾半截 JSON 跳过而非失败。

**一次动作完成「拿到文件 + 找到文件」。** 成功后 `success` toast（`transcriptExported`，`detail` = 绝对路径，`action.label` = `revealsInFolder`），**并自动**调 `reveal_in_explorer(path)` 选中该文件；toast 的 action 提供重试定位。

| 状态 | 表现 |
|---|---|
| default | 常驻可用；不做前端磁盘预检查，空转写在 Rust 判定 |
| pending | 行 `aria-busy`；先 `show({tone:'info', title:'exportingTranscript'})` 记下 id，结果时 `dismiss(id)` 再推结果条（同屏只留一条） |
| success | 见上 |
| failure | `error` toast `transcriptExportFailed` + Rust 原文（权限拒绝、磁盘满、文件名耗尽都原样透出）；可再点重试；不留半截文件（先写 `.tmp` 再 `fs::rename`，失败即删 tmp） |
| 无转写 | Rust 返回 `This meeting has no transcript to export.` → `detail` 即该原因；不生成空文件 |
| 定位失败 | 导出成功但 reveal 失败：保留 success toast（含可重试 action），另推 `error`：`revealFailed` + 原文（路径已在 success 文案里） |

**边界。** 数据根回退（Program Files 场景）时导出跟随回退后的根；回退目录也不可写则透出 `os error 5` 原文。录制中允许导出（快照语义）。转写文件为空或全是坏行 → 按「无转写」处理。删除会议后已导出文件**不随之删除**（用户资产）。

### B4 M2-4 生命周期动词审计（只记录，不实现）

| 数据 | 现有动词 | 缺失动词 | 优先级 |
|---|---|---|---|
| `actions[]` | 助手 `save_meeting_actions` 写入 | 清空全部、删除单条、编辑 `text/owner/dueDate`、切换 `completed` | P1（`completed` 用户可见但不可点是死控件） |
| `summary` | 助手写入、M2-2 清空 | 手工编辑、从转写一键重生成 | P1（H5 的验证依赖它） |
| `exports/*.txt` | M2-3 生成 | 列出、重新定位、删除、**打开导出文件夹**、批量导出 | P1（本版从 M2 移出，见 B5-1） |
| `title`（列表外） | 仅 M2-1 行菜单 | `SummaryPage` / `LiveMeetingPage` 标题处重命名入口 | P2 |
| `agenda` / `tags[]` / `participants` | 建会写入 / 无 UI / 只读计数 | 会后编辑议程、增删标签、编辑参会人 | P2 |
| `recordings/.../audio*.wav` / 整库 | 随会议删除 / 读写 | 单轨播放另存、单轨删除；备份 / 恢复 / 迁移 | P3 |

### B5 本版相对 v1 的范围变化

1. **删掉「打开导出文件夹」常驻菜单项与 `meetings_exports_folder_reveal` 命令**（进 B4 P1）。它是导出目录管理，不是交付动作；S1 只需要「我这次那份文件在哪」，而导出成功已自动 reveal。收益：reveal 收敛为单一入口，路径边界收紧到 `exports/` 内，验收少一条命令。
2. **文件名冲突后缀 `(2)` → `-2`**：`code-standards.md` §3 已约定 `-2`，规范优先于 v1 的括号写法。
3. **导出行的来源标签由 `microphone|system` 改为 `system-output|microphone`**：与 `src/domain/contracts.ts` 的 `TranscriptSource` 逐字对齐，否则实现者要自造映射，X2 的断言也无法成立。
4. 细节裁剪：reveal 只接受 `exports/` 内已存在的**文件**（不再接受任意数据根路径）；B4 优先级按主目标用户重排。保留不动：全部状态矩阵、四态要求、i18n 双语、错误串即 IPC 契约、`.txt` 范围、无撤销决策。

## PART C — 交付契约

### C1 i18n keys（`src/i18n/strings.ts`，en + zh-CN 同时加；`t()` 无插值，动态值在 TSX 拼接）

| key | English | 简体中文 |
|---|---|---|
| `menuRenameMeeting` | Rename… | 重命名… |
| `renameMeetingTitle` | Rename meeting | 重命名会议 |
| `renameMeetingHint` | Only the title changes. The recording folder and transcript stay as they are. | 仅修改标题，录音目录与转写文件保持不变。 |
| `renameTitleEmpty` | Enter a title. | 请输入标题。 |
| `renameTitleTooLong` | Titles are limited to 120 characters. | 标题最多 120 个字符。 |
| `meetingRenamed` | Meeting renamed | 会议已重命名 |
| `meetingRenameFailed` | The meeting could not be renamed. | 无法重命名会议。 |
| `menuClearSummary` | Clear recap… | 清除纪要… |
| `clearSummaryTitle` | Clear this meeting's recap? | 清除这场会议的纪要？ |
| `clearSummaryBody` | The recap text is removed from this device. Action items are kept. This cannot be undone. | 纪要正文会从本机移除，行动项会保留。此操作无法撤销。 |
| `clearSummaryConfirm` | Clear recap | 清除纪要 |
| `summaryCleared` | Recap cleared | 纪要已清除 |
| `summaryClearFailed` | The recap could not be cleared. | 无法清除纪要。 |
| `menuExportTranscript` | Export transcript… | 导出转写… |
| `exportingTranscript` | Exporting transcript… | 正在导出转写… |
| `transcriptExported` | Transcript exported | 转写已导出 |
| `transcriptExportFailed` | The transcript could not be exported. | 无法导出转写。 |
| `transcriptExportEmpty` | This meeting has no transcript to export. | 这场会议没有可导出的转写。 |
| `revealsInFolder` | Show in folder | 在文件夹中显示 |
| `revealFailed` | The folder could not be opened. | 无法打开文件夹。 |
| `revealNativeOnly` | Showing files in Explorer requires the Windows desktop app. | 在资源管理器中显示需要 Windows 桌面版。 |

共 21 个新 key（v1 的 22 个减去 `menuOpenExportsFolder`）。复用不新建：`cancel` `save` `meetingTitle` `summaryUnavailable` `meetingDeleted` `deleteMeetingTitle` `retry`。

### C2 Rust API（`meetings/commands.rs` + `store.rs`，注册进 `lib.rs` 的 `generate_handler!`）

```rust
// store.rs：全部走 self.mutate（内存 + meetings.json 一次原子落盘）
pub fn rename(&self, id: &str, title: String) -> Result<Meeting, String>;
pub fn clear_summary(&self, id: &str) -> Result<Meeting, String>; // 复用 update_summary(id, "")

// commands.rs
meetings_rename(id: String, title: String) -> Result<Meeting, String>
meetings_summary_clear(id: String) -> Result<Meeting, String>
meetings_transcript_export(id: String) -> Result<TranscriptExport, String>
reveal_in_explorer(path: String) -> Result<(), String>

#[derive(Serialize)] #[serde(rename_all = "camelCase")]
pub struct TranscriptExport { pub path: String, pub file_name: String, pub segment_count: usize, pub bytes: u64 }
```

**每条错误都是一个能直接给用户看的句子（英文即 IPC 契约，前端 `detail` 原样显示）。** `meetings_rename`：`That meeting no longer exists.` / `Enter a title.` / `Titles are limited to 120 characters.` / `Could not save meetings to <path>: <io error>`。允许 `in-progress`；不改 `recording_dir`，不重命名任何文件或目录。

`meetings_summary_clear`：`That meeting no longer exists.` / `Could not save meetings to <path>: <io error>`。

`meetings_transcript_export`：`That meeting no longer exists.` / `This meeting has no transcript to export.` / `Could not create <dir>: <io error>` / `Could not pick a free export file name in <dir>.` / `Could not write <path>: <io error>`。先写 `<name>.tmp` 再 `fs::rename`，任一步失败即删 tmp。

`reveal_in_explorer`：`That file no longer exists: <path>` / `That path is outside the meeting data folder.` / `Revealing files in Explorer requires the Windows desktop app.` / `Could not open Explorer: <io error>`。Windows 分支用 `explorer.exe /select,<canonical path>`；边界校验 = `canonicalize` 后必须以 `<data_root>/exports` 为前缀且是文件（本版不再接受任意数据根路径）。

**前端服务层。** `NativeServices.ts` 增 `renameMeeting` `clearMeetingSummary` `exportTranscript` `revealInExplorer`（走 `invokeNative` 的 `fallback` 兜底）；`UnavailableServices.ts` 必须实现同名方法并抛 `Meeting Master is running outside its native Windows host.`，否则 browser shell 会 `TypeError` 而不是 failure toast。

### C3 验收（可判定，不需要再问）

**Rename** R1 右键与 `F2` 打开同一个对话框。R2 空标题或与当前标题 trim 相同 → `save` 不可点、显示 `renameTitleEmpty`（相同情形不显示该错误、直接关掉不写盘不弹 toast）。R3 输入第 121 个中文字符被阻止，计数停在 `120/120`。R4 保存成功后行标题立即变化、`meetings_get` 返回新标题、重启后仍是新标题。R5 失败时对话框不关闭、toast `detail` 与 Rust 原文逐字相同、可再次点保存。R6 重命名前后 `recording_dir` 与 `data/recordings/meetings/<id>/` 内文件数与 `mtime` 完全一致。R7 `status=in-progress` 的会议可成功重命名。R8 `Esc` / 取消 / 点背景（非 pending 时）均不写盘。

**Clear recap** C1 有纪要的会议该项可用，`summary` 为空或纯空白的为 `disabled`。C2 确认后 `meetings_get().summary === ""`，`actions` 深比较前后一致。C3 取消不写盘。C4 失败时 toast `detail` 与 Rust 原文一致。C5 `SummaryPage` 对已清空纪要显示 `summaryNotGenerated` 且无异常渲染。C6 重启后仍为空。

**Export** X1 导出后 `exports/` 新增恰好 1 个 `.txt`，命令返回的 `path`、`file_name`、`bytes`、`segment_count` 与该文件实际值一致。X2 行数 = `segment_count + 5`，第 1 行为 `Title: <当前标题>`，第 2 行含 `Meeting ID: <id>`，第 4 行为 `Segments: <segment_count>`，每条 segment 行匹配 `^\[\d{2}:\d{2}:\d{2}\] (microphone|system-output): `。X3 同一会议导出两次得到 2 个文件，先前文件的 SHA-256 不变，新文件名不同（同一秒内为 `-2` 后缀）。X4 预置同名文件后导出，新文件名以 `-2` 结尾且原文件字节不变。X5 无转写会议 → `exports/` 文件数不变，`detail` 在英文环境逐字为 `This meeting has no transcript to export.`。X6 把 `exports` 设为只读后导出 → `error` toast 且 `detail` 含原生错误，`exports/` 内无 `*.tmp` 残留。X7 成功后 Explorer 打开并选中该 `.txt`。X8 `reveal_in_explorer` 传 `exports/` 之外的路径 → 拒绝，`detail` 逐字为 `That path is outside the meeting data folder.`。X9 标题含中文与 `/:*?` 时 slug 清洗正确、记事本打开中文不乱码、换行为 CRLF。X10 录制中导出成功，行数 = 已定稿行数 + 5，末尾半截 JSON 行被跳过而非失败。X11 删除会议后已导出文件仍存在。

### C4 M2 明确不交付

- 不改文件/目录名：重命名只写 `meetings.json` 的 `title`。
- 不做撤销 / 回收站 / 历史版本：清空纪要、删除会议都不可恢复。
- 不清空行动项、不编辑行动项、不手动编辑纪要正文（B4 backlog）。
- 导出只做纯文本 `.txt`：不做 Markdown / SRT / VTT / PDF / DOCX，不上传云端，不导出音频。
- 不做导出目录管理：「打开导出文件夹」、导出清单、删除已导出文件全部延后（B5-1）。
- 不做系统「另存为」对话框（不引入 `tauri-plugin-dialog`），导出目录不可配置。
- 不做批量操作（多选重命名 / 批量导出），不加 `F2` 以外的新快捷键，不加 `ContextMenu` 子菜单能力。
- 不改 `docs/ui-design-system.md` 与 `src/styles/tokens.css`；新增 UI 只用现有 primitive 与 MUI 主题默认值。

### C5 完成定义

1. `npx tsc -p tsconfig.app.json --noEmit` 通过；`cargo check --manifest-path src-tauri/Cargo.toml` 通过。
2. C3 的 R1–R8 / C1–C6 / X1–X11 每条都在运行中的 Tauri 窗口里手工走通，失败路径用真实原因（把 `exports` 临时设为只读即可复现）。
3. 无标题、无转写、录制中三种会议各走一遍，不出现异常或死按钮。
4. en / zh-CN 切换后 C1 的 21 个 key 全部有文案，无回落到 key 名。
5. 新增样式（若有）只用 token：无 raw hex、无 raw `font-size`、无 token 外圆角；新增代码零注释。
