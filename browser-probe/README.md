# browser-probe · 内网浏览器验证全自动体检包

拷进内网，双击一个 bat，输入轮数，剩下全自动：环境检查、脚本测试、逐轮让模型做五套页面的验证任务、自动评分、报告落到桌面。回答的问题只有一个：**在你们的内网机器和私有模型上，哪一档浏览器验证方案能用、稳不稳。**

## 四档方案

| 档 | 方案 | 谁握方向盘 | 测什么 |
|---|---|---|---|
| 1 | 系统 Edge/Chrome 无头命令行 | 脚本 | 截图、DOM 导出、console；零依赖 |
| 2 | Playwright 脚本（固定流程） | 脚本 | 登录、点击、截图、像素比对、布局树、console |
| 2.5 | 场景执行器 | 模型写 JSON 场景，脚本执行 | 模型能不能照格式写场景并跑通 |
| 3 | Playwright MCP | 模型直接操控浏览器 | 模型能不能靠文本快照完成任务、要多少次调用 |
| 附 | 看图 | 模型 | 模型能不能看图，决定截图要不要转成文本 |

## 五套测试页面

内置一个零依赖的演示站，同一个登录（admin / admin123），五套风格不同的页面，覆盖你们实际项目里常见的形态：

| 套 | 页面 | 考什么 |
|---|---|---|
| a 管理后台 | 登录 + 侧栏 + 表格 + toast + 故意报错的设置页 | 基本交互、像素比对（预埋 6 处样式偏差）、错误捕获 |
| b 表单向导 | 三步向导、校验提示、单选 / 下拉 / 复选、提交出编号 | 填表、读校验文字、多步流程 |
| c 列表交互 | 服务端分页、搜索、弹窗新增、原生 confirm 删除 | 翻页、弹窗、对话框处理；每次打开自动重置数据 |
| d 数据看板 | 标签页、统计卡、canvas 柱状图、折叠明细、刷新计数 | 标签切换、canvas 只能看图 |
| e 老系统 | 表格布局、左侧树菜单、iframe 内容区、1.5 秒慢加载、2 秒慢导出 | iframe、等待、老式页面 |
| f Vue 单页应用 | Vue 3 + vue-router history 模式 + Element Plus；登录后按权限动态注册路由；组件嵌套三层；函数式组件；用 h 函数按配置渲染的表单；Teleport 弹窗；异步组件 + Suspense | 动态路由、组件库 DOM、语义选择器、异步时序、归因到组件 |

每套各有一个"写场景"任务和一个"MCP 直驱"任务，标准答案在 `tests/<套>/expected.json`，评分是机械比对，不靠人看。

f 套全部走 `demo-site/public/vendor/` 里的 UMD 文件（npm dist 原样复制，版本见 VERSIONS.txt），不需要构建也不联网。它用的是 Vue 开发版，布局树能把每个节点归因到组件链，例如 `UsersView>UserTable>StatusTag[ElTag]`；生产构建没有这个引用，约定组件根元素加 `data-comp` 属性即可。场景执行器支持按标签、角色、占位文字、可见文字定位，不依赖 id 和类名；可以忽略 `[Vue warn]` 这类开发态噪音，可以关动画、给动态区域打遮罩。

## 目录

```
browser-probe/
├─ 全自动体检（双击我）.bat        主入口：问轮数 → 全自动 → 报告
├─ 只跑脚本测试（双击我）.bat      不用模型的部分单独跑
├─ 启动演示站 / 停止演示站（双击我）.bat
├─ 外网准备（双击我）.bat          外网机器跑一次
├─ probe-auto.ps1                全自动主脚本（参数见文件头）
├─ 0-prepare-online.ps1          外网：装依赖、下便携 Node、生成素材、自测、-Zip 打包
├─ 1-check-env.ps1               环境检查 + 按本机路径生成 .mcp.json / .claude\settings.json
├─ 2~5-*.ps1                     脚本测试各档；run-all.ps1 是只跑脚本测试的汇总
├─ tests/                        模型任务书（每套 t25.md / t3.md）+ 标准答案 expected.json
├─ scenarios/                    场景文件格式说明 + 每套一个示例场景
├─ demo-site/                    演示站（零依赖 Node 服务器 + 五套页面）
├─ tools/                        执行器、像素比对、布局树、MCP 自检、hook 计数、信任标记等
├─ .claude/skills/               手动体检命令 /probe-img /probe-t25 <套> /probe-t3 <套>
├─ node_modules/ + offline/node  随包携带，内网不用联网也不用装 Node
└─ results/                      每次运行一个目录；全自动的在 auto-<时间戳>
```

## 第一步：外网准备（一次）

在能上网、装了 Node 18+ 的机器上双击"外网准备"。它会 `npm install`（跳过浏览器下载）、下载便携版 node.exe、生成看图素材、自测第二档和第二点五档。加参数 `-Zip` 会在上级目录打一个 zip（约 40 MB）。然后把整个目录或 zip 拷进内网。

## 第二步：内网双击"全自动体检"

```
要测试几轮？直接回车 = 3
```

输入数字回车，之后不用管。流程：

1. 环境检查，按本机路径重新生成 `.mcp.json` 和 `.claude\settings.json`
2. 把本目录写进 `~/.claude.json` 的信任列表（`claude -p` 不会弹信任框，不信任会忽略项目里的权限放行和 hook；只改这一个布尔值，原文件备份为 `.claude.json.bak-browser-probe`）
3. 起演示站，跑脚本测试：第一档、第二档、五套示例场景、MCP 服务器自检
4. 逐轮跑模型测试：看图 + 六套 × 2 = 13 项，每项一个独立的 `claude -p` 进程，超时 25 分钟自动终止
5. 自动评分，写 `results\auto-<时间戳>\report.md`，并复制一份到桌面 `浏览器体检报告-<时间戳>.md`

每项模型测试通常 1 到 5 分钟，3 轮全套大约 1 到 2 小时，放着跑就行。命令行参数可以缩小范围，例如只跑两套一轮：

```bat
powershell -ExecutionPolicy Bypass -File probe-auto.ps1 -Rounds 1 -Sets a,c
```

## 报告怎么看

报告分六段：脚本测试结果、模型测试矩阵（每项 × 每轮，写场景标重试次数，MCP 直驱标调用次数）、统计（通过率、平均耗时、平均调用次数）、按阈值自动给出的结论、失败明细（差在哪个字段、模型的备注、claude 的结束原因、文件位置）、说明。

自动结论的阈值：

| 项 | 阈值 |
|---|---|
| 看图 | 全对 = 能看图；全错或报错 = 走零图模式 |
| 第二点五档 | 通过率 ≥ 90% 稳定，可作默认验证通道；60%~90% 基本可用；< 60% 不稳定 |
| 第三档 | 通过率 ≥ 80% 且平均 ≤ 25 次调用 = 可用于探索性验证；60%~80% 只做辅助；< 60% 不适合 |

失败的项去 `results\auto-<时间戳>\model\round-N\` 看：`<套>-<测试>.json` 是模型写的答案，`.claude.json` 是 claude 的完整输出，`.claude.err.txt` 是错误输出，`-out` 目录是场景执行器的截图和布局树。

## 已在内网验证过的事实（2026-09-05，Win10 + Edge 92 + 私有模型）

- Edge 92 这么老的版本，Playwright 1.62、Playwright MCP、Element Plus 2.14 全部跑通，浏览器版本不是障碍。唯一踩到的是 Playwright 截图的 mask 选项在它上面报 "object is not extensible"，执行器已改为自己画遮罩。
- 六套页面写场景 18/18 零重试；MCP 直驱 a 到 e 三轮调用次数几乎一致。
- MCP 直驱在 Element Plus 页面上明显更费劲：瞬时 ElMessage 快照抓不到，模型会为了读提示反复提交业务操作。任务书已改成"只提交一次，错过就读表格第一行拼出来"，判分也放宽到只看关键字段；真实项目里同样要给"读提示"留一条不产生副作用的路。

## 手动方式（可选）

在本目录运行 `claude`，输入 `/probe-img`、`/probe-t25 c`、`/probe-t3 e` 之类可以单独跑某一项，结果在 `results\model\`，对照 `tests\<套>\expected.json` 核对；`tools\score-model.ps1` 汇总 MCP 调用次数。

## 常见问题

- **模型测试全部"模型没有写结果文件（claude 报错：…）"**：看 `.claude.err.txt`。常见是 `claude` 没登录或 API 地址不通，先在终端手动跑一次 `claude -p 你好` 看是否正常。
- **提示 workspace has not been trusted**：第 2 步的信任标记没写成功（多半是没有 Node）。交互式打开一次 `claude` 接受信任即可。
- **MCP 工具不出现 / 第三档基础自检失败**：`.mcp.json` 必须由 `1-check-env.ps1` 按本机路径生成；Claude Code 里输入 `/mcp` 看 playwright 状态。
- **第一档截图空白**：脚本会自动换 `--headless=new` 再试；仍不行设 `PROBE_BROWSER_PATH` 指向 Chrome。
- **第二档报"无法启动任何浏览器"**：设 `PROBE_BROWSER_PATH=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`。
- **端口被占**：设环境变量 `PROBE_PORT=4300` 再跑。
- **想看着模型操作浏览器**：把 `.mcp.json` 里的 `"--headless"` 删掉（每次环境检查会重新生成，改完直接手动跑 probe-auto.ps1 加 `-SkipScripts`）。
- **ps1 中文乱码**：脚本都是 UTF-8 带 BOM，被别的编辑器另存过才会乱码，重新拷一份。

## 拿到结论之后

`tools/scenario-run.js`、`pixel-diff.js`、`layout-tree.js` 就是轻量工作流里 UI 验证通道的雏形：模型写场景、脚本执行、比对结果回给模型。哪一档过了，就沿哪一档往真实项目上接。
