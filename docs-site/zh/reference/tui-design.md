# 终端 TUI 设计规范（Design Spec）

> 本文件是 AuroraAgent 终端所有 dialog / selector / 输入框的**单一真值源**。新增或改造交互组件前先读本文件，提交前对照文末「自查清单」。
> 基准组件：模型选择器（`/model`）。所有列表型 dialog 的头部、hint、搜索、选中 / 当前态都以它为准对齐。
> 落地模块：`util/tui/`（theme / printable-key / searchable-list / symbols / render）与 `util/agent/` 的 TUI 组件。

---

## 1. 视觉状态

| 语义 | 规范 | 常量 / token |
|---|---|---|
| 选中项指针 | `❯ `（`primary`） | `symbols.mjs` → `SELECT_POINTER` |
| 选中项文字 | `primary` + bold | `painter.bold('primary', …)` |
| 当前 / 生效项 | 行尾 ` ← current`（`success`） | `symbols.mjs` → `CURRENT_MARK` |
| 危险项 / 操作 | `error`（选中再加 bold） | `painter.error` |
| 危险确认 `[y/N]` | `warning` + bold | `painter.bold('warning', …)` |
| 开关项：开 | 名称后 `  enabled`（`success`） | `painter.success` |
| 开关项：关 | 名称后 `  disabled`（`textDim`） | `painter.dim` |
| 列表 / 选择器边框 | 平直 `─`（`primary`），仅顶 / 底各一条 | `render.hline` |
| 输入框边框 | 圆角 `╭ ╮ ╰ ╯`（`primary`） | — |

- **不要**自造选中指针（`>` / `▶` / `→` 等）；统一用 `SELECT_POINTER`。
- **不要**用 `● ` / `(current)` 表示当前项；统一用 `CURRENT_MARK`（行尾、`success`、前置一空格）。
- 当前项与选中项**互相独立**：当前项是「现在生效的值」（行尾 marker），选中项是「光标所在行」（指针 + 高亮）；两者可同时落在同一行。

## 2. 颜色

- 一律使用**语义 token**：`painter.paint('<token>', text)` 或 `painter.<token>(text)`。仓库守卫 `guard-no-raw-color-outside-theme` 强制：`util/tui/` 内除 `theme.mjs` 外禁止出现原始 SGR。
- 可用语义 token 见 `theme.mjs` 的 `TOKEN_NAMES`：`primary` `accent` `text` `textStrong` `textDim` `textMuted` `border` `borderFocus` `success` `warning` `error` `diffAdded` `diffRemoved` `diffAddedStrong` `diffRemovedStrong` `diffGutter` `diffMeta` `roleUser` `shellMode` `think` `status`。
- **Painter 每次渲染从当前色板新建**（`createPainter(colors)`），勿在模块顶层缓存样式函数——主题切换须当帧生效。
- 新增视觉语义必须先往 `ColorPalette`（暗 / 亮两套）加 token，并由 `auditPalette` 通过对比度：文本类 ≥ 4.5:1、次要（dim/muted/gutter/meta）≥ 3:1、边框 ≥ 1.5:1、聚焦边框 ≥ 3:1。
- **hint 行不做键位高亮**：整行 `textMuted`，不给 `Enter` / `Esc` / `D` 等键位单独上色。

## 3. 列表 dialog 标准布局

以模型选择器为准，自上而下逐行固定为：

```
─────────────────────────────────────────  ① 顶部边框（primary，整宽 ─）
 Select a model  (type to search)          ② 标题（primary+bold）+ 可搜索且无 query 时的后缀（textMuted）
 ↑↓ navigate · Enter select · Esc cancel    ③ hint（textMuted，紧贴标题，无键位高亮）
                                            ④ 空行
 Search: gpt                                ⑤ 搜索行：仅在有 query 时出现（` Search: ` primary + query text）
  ❯ GPT-5            openai                  ⑥ 列表项：指针 + 名称（左）+ 次要列（右，textMuted）
    Kimi K2          Kimi Code ← current        当前项行尾 ` ← current`（success）
                                            ⑦ 空行
 ▼ 3 more                                   ⑧ 滚动 / 匹配指示：无 query 时 `▼ N more`，有 query 时 `x / y`
─────────────────────────────────────────  ⑨ 底部边框（primary，整宽 ─）
```

硬性约定：

- **头部只有顶部一条 `─`**。标题下方紧跟 hint，**不得**再插一条 `─`。整个 dialog 全宽 `─` 仅 2 条（顶 + 底）。
- **`(type to search)` 只出现在标题后缀**（可搜索且 query 为空时）；hint 行**不再**重复。
- **`Search:` 行在空行之下、列表之上**，只在有 query 时渲染。
- hint 紧贴标题（中间无空行）；hint 与正文之间有 1 空行。
- 每行最终经 `truncateToWidth(line, width)`，CJK / 窄终端不超宽。

## 4. hint 行与文案词汇

每段 hint 形如「**键位 + 描述**」，段间用 ` · `（`symbols.SEP`，单空格中点）分隔。

| 动作 | 键位 token | 描述词 | 完整片段 |
|---|---|---|---|
| 移动 | `↑↓` | navigate | `↑↓ navigate` |
| 翻页 | `←→` 或 `PgUp/PgDn` | page | `←→ page` |
| 确认 / 选中 | `Enter` | select | `Enter select` |
| 取消 / 关闭 | `Esc` | cancel | `Esc cancel` |
| 删除 | `D` | delete | `D delete` |
| 清空搜索 | `Backspace` | clear | `Backspace clear` |
| 切 provider | `Tab` | toggle provider | `Tab toggle provider` |
| 搜索（标题后缀） | 打字 | — | `(type to search)` |

- **键位 token 首字母大写**（`Enter` / `Esc` / `Tab` / `Backspace` / `D`），**描述词全小写**（navigate / select / cancel / page / delete / clear）；方向符 `↑↓` / `←→` 原样。
- 「离开对话框」统一只说 `cancel`（不混用 close / back / exit / dismiss）。
- hint 随状态精简：可搜索列表无 query 时「type to search」在标题后缀已出现，hint 不重复；有 query 时 hint 追加 `Backspace clear`。

## 5. 键盘映射

| 按键 | 语义 | 判定 |
|---|---|---|
| 上 / 下 | `↑` `↓` | 移动 | `matchesKey(data, KEY.up/down)` |
| 翻页 | `PgUp` `PgDn` | 翻页 | `matchesKey(data, KEY.pageUp/pageDown)` |
| 确认 / 选中 | `Enter` | `matchesKey(data, KEY.enter)` |
| 取消 / 关闭 | `Esc` | `matchesKey(data, KEY.escape)` |
| 删除 | `D` | `printableChar(data) === 'D'`（也接受 `'d'`） |
| 搜索 | 打字 | `printableChar(data)` |

- **字符比较必须经 `printableChar()`**（Kitty 协议 CSI-u），由守卫与单测强制；功能键用 `matchesKey(data, KEY.*)`。
- **`Esc` 两段式**：有 query 时先清空 query（`list.clearQuery()`），无 query 时才 `onCancel()`。
- **删除键统一用字母 `D`**。字母键要求该列表**不可 type-to-search**（否则会打进搜索框）。

## 6. 开关列表与多选

适用于「每行可独立开 / 关」的列表（如 MCP server、插件）。区别于单选（`Enter` 选中即提交并关闭），开关列表用 `Space` 就地切换，dialog 不关闭。

```
 Plugins
 ↑↓ navigate · Space toggle · Enter details · Esc cancel
 Installed plugins (2)
  ❯ Kimi Datasource  enabled
    id kimi-datasource · 1 skill · official
    Superpowers  disabled
```

- **`Space` 切换当前行状态**，即时生效、dialog 保持打开；hint 含 `Space toggle`。
- **状态标签**紧跟名称、空 2 格：开 ` enabled`（`success`）、关 ` disabled`（`textDim`）。
- 多套独立动作时，hint 逐项列全，键位首字母大写：`Space toggle · Enter details · D remove`。

## 7. 输入框（多字段）

- 圆角盒 `╭ ╮ ╰ ╯`（`primary`）。
- 字段切换：`Tab` / `Shift+Tab` / `↑` / `↓`。
- `Enter`：非末段→推进到下一字段；末段→提交。
- 取消：`Esc` / `Ctrl+C` / `Ctrl+D`。
- footer 随焦点动态：非末段 `Enter next`，末段 `Enter submit`。
- 必填校验按字段顺序定位，错误用对应的子提示态。

## 8. 共享组件（优先复用）

| 形态 | 组件 |
|---|---|
| 列表光标 / 搜索 / 翻页状态机 | `util/tui/searchable-list.mjs` → `SearchableList` |
| Kitty 可打印字符 | `util/tui/printable-key.mjs` → `printableChar` / `isPrintableChar` / `matchesKey` |
| 选中指针 / 当前项标记 | `util/tui/symbols.mjs` → `SELECT_POINTER` / `CURRENT_MARK` |
| 宽度 / 截断 / 对齐 / 水平线 | `util/tui/render.mjs` → `displayWidth` / `truncateToWidth` / `padToWidth` / `hline` |
| 颜色 | `util/tui/theme.mjs` → `createPainter` / `paletteFor` / `auditPalette` |

新列表组件**必须复用 `SearchableList`**（光标 / 搜索 / 翻页），并手工对齐本文件第 3–6 节的布局、键位、文案。

## 9. OSC 终端标题

- 序列：OSC 0（`\x1b]0;标题\x07`），同时设窗口与图标标题；实现在 `util/tui/title.mjs`（`buildTerminalTitle` / `oscTitle` / `clearTitle`）。
- 拼装：按 `tui.terminalTitle` 项序取 `state`（状态词）/ `session`（会话名）/ `app`（`AuroraAgent`）三段，` | ` 连接，例「生成中 | 新会话 | AuroraAgent」。
- **置空项序 = 关闭**：`buildTerminalTitle` 返回 `null`，调用方不写任何序列；配置经 `GET/POST /api/settings/tui` 读写。
- 生命周期：会话切换 / 生成态变化 / 侧边对话切换实时重设；**退出与挂起必须清空**（`clearTitle`），恢复后由调用方按当前状态重设。
- 注入防护：会话名等动态段写入前剥离 ESC / BEL / 换行（`oscTitle` 内建）。

## 10. 系统通知

- 三通道：OSC9（`\x1b]9;正文\x07`）/ OSC777（`\x1b]777;notify;标题;正文\x07`）/ bel（`\x07`）；实现在 `util/tui/notify.mjs`（`writeNotification` / `createNotifier`）。
- 配置 `tui.notifications`：`when`（`unfocused` / `always` / `never`）× `method`（`auto` / `osc9` / `osc777` / `bel`）× `events`（`turn-complete` / `turn-failed` / `permission-required` / `question-required`）各自独立容错。
- `auto` 依 `TERM_PROGRAM` 择 OSC777 终端列表，否则 OSC9；`unfocused` 经 `osascript` 200ms 超时尽力探测焦点（结果缓存 3s），**失败按未聚焦处理**——宁可多响不漏响。
- 通知异步发送、fire-and-forget，不阻塞渲染；标题与正文同样剥离 ESC / BEL / 换行并截断（80 / 200 字符）。

## 11. footer 状态栏与目标芯片

- footer 是单行纯渲染（`util/tui/footer.mjs`）：`模型 · 模式 · 思考 · 权限 [· 计划 · 标题 · 目标 · 生成态 · tokens/费用]`，方括号为可选段，超宽时**从右到左**逐段裁剪（ANSI 不计宽）。
- **目标芯片**：有 `active` 目标时插入 `目标` 段（`accent` token），值形如 `12.5K / 50.0K · 2m30s`（tokens 用量 / 预算 · 活跃时长；无预算时省略 `/ 预算`，时长 `Ns` / `Nm` / `Nms` 短形态），与 turn 渲染器同源（`goal/budget.mjs` 的 `goalUsageChip`）。
- 状态词进 OSC 标题的 `state` 段：就绪 / 生成中 / 侧边对话。

## 12. 新增 / 改造 dialog 自查清单

- [ ] 头部按第 3 节：顶部一条 `─`、标题（+`(type to search)` 后缀）、hint、空行、`Search:` 行、列表、底部一条 `─`；标题下**无**内层 `─`。
- [ ] hint 整行 `textMuted`，**不**做键位高亮；键位首字母大写、描述词小写、` · ` 分隔。
- [ ] 选中指针用 `SELECT_POINTER`，当前项用 `CURRENT_MARK`，未自造 `>` / `▶` / `→` / `● ` / `(current)`。
- [ ] 颜色全部来自 `painter.<token>`，无原始 SGR（守卫强制）。
- [ ] 键位：`↑↓` 移动、`PgUp/PgDn` 翻页、`Enter` 确认、`Esc` 取消（可搜索列表两段式）、`D` 删除；字符比较经 `printableChar()`。
- [ ] 「离开对话框」只说 `cancel`。
- [ ] 开关列表用 `Space toggle` 就地切换、不关闭；状态标签 ` enabled`/` disabled` 紧跟名称空 2 格。
- [ ] 长列表有滚动 / 翻页指示（`▼ N more` 或 `x / y`），空态文案明确（`No matches` 等）。
- [ ] 每行经 `truncateToWidth(line, width)`，CJK / 窄终端下不超宽。
- [ ] 复用 `SearchableList`；有对应的组件测试（render + 键位行为）。
