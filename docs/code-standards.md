# 代码规范

适用范围：本仓库全部代码。与 `docs/ui-design-system.md`、`docs/prd-m2-meeting-lifecycle.md` 同级，冲突时以本文件为准。

## 1. 注释：默认不写

注释只用于**代码无法表达的“为什么”**，不用于复述“做了什么”。

允许：
- 会让人踩坑的**不变量**（例：`// 该表在 0 点时长度必须为偶数，下游分页依赖它`）
- **绕过**了某库/某平台行为的说明（例：`// WebView2 会忽略 scrollbar-gutter，这里用 JS 轨道代替`）
- **安全边界**（例：`// 只允许 reveal 数据根内的路径，禁止 webview 传任意路径`）
- **产品决策**（例：`// 删除即物理删除，不做回收站，见 delivery-record D1`）

禁止：
- 复述函数名的 JSDoc（`/** 获取会议 */ getMeeting()`）
- 逐行解释显而易见的赋值、循环、条件
- 保留被注释掉的旧代码（要留就进 git 历史）
- 大段 markdown 分隔线、无信息量的 banner 注释

命名优先于注释：能靠 `isPendingUserConfirmation` / `legacyPrefix` 表达清楚的，就不要再写一行注释。

## 2. TypeScript / React

- 严格模式，禁止 `any`。外部数据在边界用 `unknown` 收窄，不信任 `JSON.parse` 的形状。
- 组件只做渲染与事件转发；**业务规则集中在 service 层**，页面不复制一份。
- 副作用全部在 `useEffect`/事件处理器内；不在渲染期写 ref 或调用 setState（现存历史问题见 delivery-record，新代码不得再犯）。
- 每个异步动作必须显式建模四态：`pending / success / failure(真实原因) / retry`。禁止空 `catch {}`。
- 列表渲染必须有稳定 `key`；禁止用数组下标（除非列表不可重排）。
- 禁止在组件内硬编码用户可见文案，一律 `t('key')`，且 en 与 zh-CN 同时补齐。
- 对外 props 显式声明类型；同目录内复用的类型就近定义，跨模块类型放 `src/domain/contracts.ts`。

## 3. Rust / Tauri

- 所有 `#[tauri::command]`：参数在边界校验，失败返回 `Err(String)` 且**信息可直接展示给用户**（说清对象、原因、下一步）。
- 禁止 `unwrap()`/`expect()`/`panic!` 出现在可失败的生产路径；用 `?` 加 `map_err` 补上下文。
- 业务规则只在 store 层实现一次，command 只做编解码、校验与编排。
- 文件系统操作必须：先校验目标在数据根内、区分“记录已删/文件删除失败”、不覆盖已有导出（后缀 `-2`）。
- 共享状态沿用现有 `Mutex<StoreData>` + 原子写；不引入第二个状态源。
- 新增命令必须注册进 `lib.rs` 的 `generate_handler!`，否则前端调用会在运行时才暴露。

## 4. 样式

- 只用 `src/styles/tokens.css` 的 token：`--c-*` `--brand*` `--r-*` `--fs-*` `--sh-*` `--sp-*` `--dur-*`。
- 禁止新增十六进制颜色、裸 `font-size` px、token 集之外的圆角。
- 复用 `src/styles.css` 的共享原语（`.panel` `.list-row` `.meta-line` `.segmented` `.empty-state`），页面样式表不得重复定义它们。
- MUI 组件外观统一在 `src/theme/appTheme.ts` 覆盖，禁止逐页覆写 MUI 内部 class。

## 5. 文件与命名

- 组件 `PascalCase.tsx`，hooks `useThing.ts`，工具 `camelCase.ts`，样式按域命名（`chat-rail.css`、`context-menu.css`）。
- 一个文件一个主要导出；同文件内组件 + 其专属 hook 可共存（加 `eslint-disable react-refresh/only-export-components` 并写明理由）。
- 单个文件超过 400 行视为实现信号：拆分而不是继续堆。

## 6. 提交前自检（每条都要能回答“是”）

1. `npx tsc -p tsconfig.app.json --noEmit` 通过；Rust 侧 `cargo check --manifest-path src-tauri/Cargo.toml --no-default-features` 通过。
2. `npx eslint src` 没有**新增**错误。
3. 新增的每个用户可见动作都有 pending / 成功 / 失败（带真实原因）/ 重试。
4. 新增的每条文案都有 en + zh-CN。
5. 没有新增 `any`、空 `catch {}`、`unwrap()`、裸颜色、裸字号。
6. 没有为了“看起来完成”而弱化校验或伪造成功。
7. 注释数量与复杂度匹配：普通 CRUD 代码应当**零注释**。
