# AGENT.md — 笔记插件开发规范

给后续接手这个仓库的 Agent / 人看的约定。改代码前先读一遍，尤其第 3、5 节是硬约束。

- 插件 id：`io.github.g1oow.sidebar-note`，宿主：PI-Desktop 0.22.0（Electron 43 / Chromium 150）
- 形态：`contributes.views` 单视图 `note`，停靠右侧工作面板；命令 `note.open` + 可配置快捷键（默认 `Mod+Shift+N`）
- 权限：只有 `ui.view` + `clipboard.write`。加权限要能说清为什么非它不可

## 1. 目录与职责

| 文件 | 职责 |
|---|---|
| `manifest.json` | 清单：视图、命令、快捷键、i18n、权限。字段含义见 `docs/spec/07-plugins/02-plugin-manifest-schema.md` |
| `main.js` | 插件进程：注册 `note.*` 通道、读写 `notes.json`、快照、`note.open` 命令 |
| `views/index.html` | 视图骨架 + 内联 Iconoir sprite（`<symbol>`） |
| `views/styles.css` | 全部样式：双主题变量、组件、动效 |
| `views/app.js` | 视图逻辑：列表/编辑器、Markdown 渲染、缩放、提示气泡、快捷键 |
| `README.md` / `CHANGELOG.md` | 用户向说明 / 版本记录（改了行为要同步） |

## 2. 运行模型

- 视图页是**独立页面**，只有 `window.pluginBridge`，没有 `pi`。
  - 内置通道（`app.getAppearance`、`ui.showToast`）走 bridge。
  - 其它全部是本插件通道 `note:*`，由 `main.js` 的 `onPanelInvoke` 处理。
  - 新增通道：`main.js` 加 case + 校验入参 + 返回纯数据；`app.js` 加 `call("note:xxx")`。
- 面板与主进程之间**只传 id / 标题 / 正文**，主进程按 id 合并，未知字段丢弃。

## 3. 硬性约束

1. **无运行时外链**：`net.domains` 为空，不能引 CDN、远程字体、远程图标。图标用内联 `<symbol>`；字体只按系统字体名 `@font-face { src: local(...) }` 引用。
2. **不拼 HTML**：页面里出现的任何用户文本都走 `textContent` / text node，禁止 `innerHTML`。
3. **链接只认 `http(s):` / `mailto:`**；沙箱不能开外链，点击是复制 URL。
4. **动态创建 SVG 必须 `createElementNS(SVG_NS, ...)`**：`document.createElement("svg")` 得到的是 `HTMLUnknownElement`，图标根本不画。
5. **只写插件私有目录**：`pi.plugin.getDataPath()`；`pi.fs` 网关会拒绝 PI 数据目录，所以数据层用 `node:fs`。不读不写用户工作区。
6. **不弱化验证通过条件**：不注释测试、不吞异常、不写死假结果。

## 4. 数据层

- `notes.json` 单文件，原子写：`tmp → fsync → rename`。
- 快照：`snapshots/`，10 分钟最多一份，保留 5 份；`notes.json` 损坏时自动回退到最新快照。
- 上限：5000 条 / 标题 200 字 / 正文 200000 字，超长截断。
- 结构变更必须同时改：读取时的字段校验、写盘时的白名单、`smoke-main.cjs` 的用例。

## 5. 交互规范（重要）

### 5.1 快捷键门禁

**所有组合键只在「鼠标点过面板，并且面板仍持有焦点」时生效。**

- 实现：`document` 上监听 `pointerdown`（capture 阶段）置 `pointerFocused = true`；`window` 的 `blur` 置回 `false`。
- 判定：`shortcutsEnabled()` = `pointerFocused && document.hasFocus()`。
- 必须经过这道门禁的：`Ctrl/Cmd+S`（保存）、`Ctrl/Cmd+N`（新建）、`Ctrl/Cmd+F`（搜索）、`Ctrl/Cmd+滚轮`（缩放）。
- 唯一例外是 `Esc`：它只在视图内关闭浮层 / 返回列表，出不了视图，所以不做门禁。
- 新增任何组合键，一律先 `if (!shortcutsEnabled()) return;`，并在这里登记。

### 5.2 离开编辑器

- 有未保存改动时离开（返回按钮、`Esc`、`Ctrl+N`、`Ctrl+F`）必须先 `await confirmLeaveEditor()`：
  - 弹 `.dialog`（保存并离开 / 放弃修改 / 取消），`false` 就留在原地。
  - 弹层期间**暂停自动保存**（清掉 `saveTimer`），并且输入框的 `blur` 处理器要 `if (dialogResolve) return;`，否则「放弃修改」会被悄悄写盘。
  - 取消后重新安排一次防抖保存。
- 「返回列表」不会自动聚焦搜索框（`showList()` 里不要加 `searchInput.focus()`）。
- 新建笔记前也要过同一道闸门。

### 5.3 缩放

- `.shell` 恒为 `width/height: 100%` + `zoom: var(--ui-zoom)`。**不要写 `calc(100% / zoom)`**：百分比已经在缩放坐标系里解析，会二次缩小、界面缩到左上角。
- 缩放入口只有顶栏的放大镜（列表页与编辑器各一个），面板里有「自适应」开关与滑杆；`Ctrl/Cmd+滚轮` 是 5% 步进，并弹出底部百分比 HUD。
- 顶栏放不下时（窄面板 / 高缩放）由 `fitEditorBar()` 加 `.is-tight`：收起面包屑、图标收窄，保证不溢出。

### 5.4 浮层定位

- 气泡 / 缩放面板 / 对话框在 `.shell` 之外，用 `position: fixed`。
- `getBoundingClientRect()` 的返回值**已经包含 `.shell` 的 zoom**，`overlayRect()` 直接返回原始矩形，再乘 `--ui-zoom` 会把底栏锚点推出视口。
- 提示气泡优先出现在按钮上方；顶栏按钮上方物理没空间时才落到下方，并翻转箭头。
- 动画不要在 `requestAnimationFrame` 里加类：后台标签页不跑 rAF，浮层会停在不可见状态。改成「移除类 → `void el.offsetWidth` 强制重排 → 加类」。

### 5.5 列表卡片

- 卡片整体是 `<button>`，所以卡片里的置顶图钉必须是**外层 wrapper 里的兄弟按钮**（HTML 不允许 button 套 button），点击时 `stopPropagation()`。
- 置顶状态变化后要 `refreshList()`，让卡片在「置顶 / 笔记」分组间移动。

### 5.6 行号槽（编辑态）

- 布局：`.body-wrap` 是定位上下文，`.gutter` 绝对定位在左侧（宽 40px / 窄面板 32px），正文用 `padding-left` 让开；`.gutter-inner` 由 `transform: translateY(-scrollTop)` 跟随正文滚动。
- 折行对齐：软换行时一个逻辑行可能占多行，所以每行的 gutter 高度由 `.editor-mirror`（隐形镜像）逐行量 `offsetHeight` 得到。**镜像与 `.body` 必须共用 `--editor-font` 与同样的 `white-space/overflow-wrap/tab-size`**，否则编号会错行。
- 超过 800 行不再逐行测量（性能），退化为单行高度；此时编号仍然正确，只是不对齐折行。
- 输入 `input` → `scheduleGutter()`（120ms 节流）；`showEditor` / `setPreview` / 尺寸变化 / 字体就绪都会 `renderGutter()`。

### 5.7 面板自适应

- `window.resize` 与 `ResizeObserver(document.body)` 都走 `scheduleLayoutFit()`（90ms 合并）：更新窄面板标记、缩放、滑块、`.is-tight`、行号槽。
- **ResizeObserver 必须保存引用**（`bodyObserver`）：不保存会被 GC，回调永远不会来。
- 一律用 `panelWidth()` = `min(body.clientWidth, innerWidth)` 判断宽度，不用媒体查询：iframe 里 viewport 与面板宽度不一定一致，宿主也可能让 body 比可见区域宽。
- 三档响应：`is-narrow`（<300px：`新建` 只留图标、页签计数隐藏、行号槽 32px）/ `is-tiny`（<240px：搜索框独占一行、操作按钮右对齐到第二行、行号槽 27px）/ `.editor-bar.is-tight`（由真实溢出触发：收起面包屑、图标 21px）。
- `maxZoomForWidth()` 给缩放封顶（虚拟宽度不低于 ~240px），否则 160% 会把顶栏图标挤出可视区。

### 5.8 超宽面板

- 内容列（`.groups` / `.body-wrap` / `.title` / `.empty`）按 **780 渲染像素**封顶并居中；顶栏搜索框与页签按 **480 渲染像素**封顶，`#newNote` 用 `margin-left: auto` 贴右边。
- `.shell` 只写 `max-width: 100%`；页面级护栏放在 `html, body` 上（见 5.8）。
- 真正限制页面宽度的是 `html, body { max-width: 100vw }`（body 不在 zoom 里，`100vw` 才等于视口）。
- 缩放面板的「自适应」提示会顺带显示视图认为的面板宽度（`跟随面板宽度 · 380px`），排查宿主尺寸问题时直接看这个值。
- **窄宽度下不要再压缩内边距**：卡片 10/12px、正文右侧 14px 必须保住，否则文字会贴到边框上（用户明确反馈过「文字没有显示边界」）。
- `.shell` 额外加 `max-width: 100vw`：body 比可见区域宽时也不溢出被裁。

## 6. 视觉规范

- 字体：`MiSans UI`（界面 + 编辑区正文 + 预览）、`JetBrains Mono`（仅代码块等代码内容）。编辑区排版参数收敛在 `--editor-size` / `--editor-line` / `--editor-font`，行号槽与折行镜像都从这里取，改字号只改这三个变量。
- 配色：OpenCode 双调色板，全部走 CSS 变量（`--bg` / `--bg-bar` / `--field` / `--line` / `--text` / `--muted` / `--accent` …），新增颜色先加变量再引用。
- 分段滑块：`.seg` / `.seg-thumb` / `.seg-option` 一套外观，选中块是**纯色块**（`--bg` + 发丝描边），位移用 `--spring` 弹簧曲线。
- 组件气质参考 Obsidian：发丝分隔线、6px–8px 圆角、克制的 hover、无重投影、无渐变。
- 动效一律可被 `prefers-reduced-motion: reduce` 关掉（该媒体查询在文件末尾统一处理）。
- 图标：Iconoir，1.5 描边、24 网格，只用 `currentColor`。

## 7. 文案（i18n）

- `STRINGS` 里 `zh-CN` 与 `en` 必须**同时补齐**，键名一致。
- 新增按钮 / 浮层时在 `applyStrings()` 里同步 `textContent`、`aria-label`、`data-tip`。
- 默认中文，代码注释也用中文；命令、日志、外部原文保留原样。

## 8. 提交前验证

```powershell
node --check main.js
node --check views/app.js
# CSS 括号配平（PowerShell）：
$c = Get-Content views/styles.css -Raw; "$(([regex]::Matches($c,'\{')).Count)/$(([regex]::Matches($c,'\}')).Count)"
```

- 数据层冒烟：`node <scratch>\smoke-main.cjs`（24 项，含快照 / 损坏回退 / 上限 / 未知通道）。
- 插件校验：`PluginCheck`（清单、入口、面板、权限、包体上限），必须零警告。
- 视觉 / 交互：用 `<scratch>\build-preview.cjs [dark|light] [list|editor|preview]` 生成带 mock bridge 的预览页，在浏览器面板里逐态核对计算样式与截图。
- 打包：`PluginPack` 生成 `dist/io.github.g1oow.sidebar-note-<version>.piplug`；不要用 shell 手工打 zip（安装器只认未压缩归档）。
- **不提交 git**：除非用户明确要求。

## 9. 已知坑（踩过的，别再踩）

1. 作者样式里的 `display` 会盖掉 UA 的 `[hidden]` → 全局写 `[hidden] { display: none !important; }`。
2. 全局正则（带 `g`）在递归的 inline 解析里共用会互相改写 `lastIndex`，直接死循环 → 每次 `new` 一个实例。
3. Web 视图里的 `zoom` 会作用到 `getBoundingClientRect()`，但**不影响** `position: fixed` 的浮层坐标，两者的换算关系见 5.4。
4. `window.open` 被宿主拒绝，外链只能复制。
5. 视图 tab 属于会话：没有会话时命令只能提示。
6. 面板关闭 / 切走前会 `flushSave()`（`visibilitychange`、`window blur`），所以「未保存」提示只覆盖编辑器内的离开动作。
