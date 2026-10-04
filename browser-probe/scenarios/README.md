# 场景文件格式（第二点五档）

一个场景 = 一个 JSON 文件：`name` + `steps` 数组。每个步骤是一个对象，**只放一个动作键**，可选 `note` 说明、`as` 命名读取结果。
运行：`node tools/scenario-run.js scenarios/xxx.json --out results/model/xxx`
站点地址默认 `http://127.0.0.1:4173`，`goto` 写相对路径即可。

## 步骤一览

| 动作 | 写法 | 说明 |
|---|---|---|
| 打开页面 | `{"goto": "/login.html"}` | 相对路径或完整 URL；会退出 iframe 作用域 |
| 进入 iframe | `{"frame": "#main"}` | 之后的选择器都在这个 iframe 里找；`{"frame": ""}` 回到主页面 |
| 填写输入框 | `{"fill": "#username", "value": "admin"}` | 选择器 + 值 |
| 点击 | `{"click": "text=登录"}` | 选择器见下 |
| 悬停 | `{"hover": ".card"}` | |
| 勾选 / 取消 | `{"check": "#region3"}` / `{"uncheck": "#enabled"}` | 单选框、复选框 |
| 按键 | `{"press": "Enter"}` | 可加 `"selector"` 指定焦点元素 |
| 下拉选择 | `{"select": "#type", "value": "代理商"}` | 按 value 或显示文字 |
| 处理弹出的确认框 | `{"onDialog": "accept"}` | 放在会触发 confirm/alert 的点击**之前**；`dismiss` = 取消。对话框文字会存到 `as`（默认 dialog） |
| 等元素出现 | `{"wait": "#userTable tbody tr"}` | 等到可见 |
| 等元素消失 | `{"waitHidden": "#loading"}` | |
| 等固定时间 | `{"wait": 500}` | 毫秒 |
| 等文本出现 | `{"waitText": "导出成功"}` | |
| 等地址变化 | `{"waitUrl": "**/dashboard.html*"}` | glob |
| 读取元素文本 | `{"read": "#total", "as": "total"}` | 存到结果的 values 里 |
| 读取输入框的值 | `{"readValue": "#q", "as": "q"}` | |
| 读取元素数量 | `{"readCount": "#productTable tbody tr", "as": "rows"}` | |
| 断言文本存在 | `{"expectText": "当前用户：admin"}` | 找不到即失败 |
| 断言元素数量 | `{"expectCount": "#userTable tbody tr", "count": 5}` | |
| 断言元素可见 | `{"expectVisible": "#toast"}` | |
| 断言地址 | `{"expectUrl": "**/dashboard.html*"}` | |
| 断言无 console 错误 | `{"expectNoConsoleErrors": true}` | 含未捕获异常 |
| 截图 | `{"screenshot": "users"}` | 生成 `users.png`；加 `"fullPage": true` 截整页 |
| 布局树 | `{"layout": "users", "root": "main"}` | 生成 `users-layout.txt`，给模型读；在 iframe 作用域内会取 iframe 里的树 |
| 像素比对 | `{"diff": "users", "ref": "../assets/design-users.png", "max": 2}` | 先 screenshot 同名；`max` 为允许的最大差异百分比 |

## 选择器怎么写

字符串写法（Playwright 原生）：

- CSS：`#id`、`.class`、`button.btn-primary`、`.nav a[href="#users"]`、`#productTable tbody tr:nth-child(3) a`
- 文本：`text=登录`（包含即可）、`text="登录"`（精确）
- 角色：`role=button[name="导出"]`
- 组合：`#userTable tbody tr`

语义对象写法（不依赖 id 和类名，组件化、函数式渲染、配置生成的页面优先用这种）：

| 写法 | 含义 |
|---|---|
| `{"label": "用户名"}` | 按表单标签找输入框（label 的 for 或包裹关系） |
| `{"role": "button", "name": "登录"}` | 按无障碍角色和名字 |
| `{"placeholder": "按姓名搜索"}` | 按占位文字 |
| `{"text": "机械键盘"}` | 按可见文字 |
| `{"testid": "save-btn"}` | 按 data-testid |
| `{"title": "…"}` / `{"alt": "…"}` | 按 title / 图片 alt |
| `{"css": ".el-dialog .el-select"}` | 显式 CSS |

加 `"exact": true` 要求完全匹配。所有接选择器的步骤（fill / click / wait / read / readCount / expectCount / mask 等）都同时接受字符串和对象。

## 场景级选项

- `"disableAnimations": true`：关掉页面所有 CSS 过渡和动画，截图与像素比对不受中间帧影响（组件库弹窗、下拉都有过渡）
- `"consoleIgnore": ["\\[Vue warn\\]", "\\[HMR\\]"]`：按正则忽略的 console 错误，用于开发态噪音；单步也可 `{"expectNoConsoleErrors": true, "ignore": ["…"]}`
- `"viewport": {"width": 1440, "height": 900}`、`"timeout": 10000`
- 截图可加遮罩：`{"screenshot": "report", "mask": [{"text": "更新时间"}]}`，动态区域涂成品红不参与比对。遮罩由执行器自己画，不用 Playwright 的 mask 选项，因为后者在 Chromium 92 这类老浏览器上会报错
- `{"waitIdle": true}` 等网络空闲；`{"type": sel, "value": "…"}` 逐字输入（触发按键事件）；`{"readAttr": sel, "name": "href", "as": "x"}` 读属性

## 组件归因

布局树里每个节点带一列"组件"：Vue 3 开发版页面会自动标出组件链，如 `UsersView>UserTable>StatusTag[ElTag]`；生产构建没有这个引用，约定组件根元素加 `data-comp="组件名"` 属性即可。像素比对和布局比对的结果里都会带上它，告诉你该改哪个组件。

## 完整例子

```json
{
  "name": "登录并检查用户列表",
  "steps": [
    { "goto": "/login.html" },
    { "fill": "#username", "value": "admin" },
    { "fill": "#password", "value": "admin123" },
    { "click": "text=登录" },
    { "waitUrl": "**/dashboard.html*" },
    { "expectText": "当前用户：admin" },
    { "click": ".nav a[href=\"#users\"]" },
    { "wait": "#userTable tbody tr" },
    { "readCount": "#userTable tbody tr", "as": "userRows" },
    { "screenshot": "users" },
    { "layout": "users", "root": "main" },
    { "expectNoConsoleErrors": true }
  ]
}
```

## 输出

- 控制台每步一行：`√`/`×` + 步骤 + 耗时 + 说明；最后一行 `RESULT {...}` 是紧凑 JSON：`values`（read/readCount 读到的值）、失败步骤、console 错误、失败请求、产物路径
- 输出目录里有 `result.md`（人看）和 `result.json`（程序读），以及截图、布局树、比对结果；某步失败时自动多一张 `failed-step-N.png`
- 退出码 0 = 全部通过；1 = 有失败；2 = 场景文件有问题
