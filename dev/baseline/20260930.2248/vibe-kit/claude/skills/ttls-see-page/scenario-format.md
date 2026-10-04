# 场景文件格式

一个场景 = 一个 JSON 文件：`name` + `steps` 数组。每个步骤是一个对象，**只放一个动作键**，可选 `note` 说明、`as` 命名读取结果。
断言（`expect` 开头的）可以和动作写在同一步里：先做动作，再查，没过这一步就算失败。同一步里写了两个动作的只做第一个，结果里会有一条 ★ 提醒。
运行命令见 SKILL.md。`goto` 写相对路径，站点地址由命令里的 `--base` 给（也可以写在场景里：`"base": "http://127.0.0.1:5173"`）；用了相对路径却两处都没给，执行器直接报错退出（退出码 2），不去猜端口。

## 步骤一览

| 动作 | 写法 | 说明 |
|---|---|---|
| 打开页面 | `{"goto": "/login.html"}` | 相对路径或完整 URL；本地的 HTML 原型写 `file:///D:/…/x.html`（这种场景不用带 `--base`）；会退出 iframe 作用域 |
| 进入 iframe | `{"frame": "#main"}` | 之后的选择器都在这个 iframe 里找；`{"frame": ""}` 回到主页面 |
| 填写输入框 | `{"fill": "#username", "value": "admin"}` | 选择器 + 值 |
| 点击 | `{"click": "text=登录"}` | 选择器见下。控件被别的元素盖住、点不到的，加 `"force": true`（`dblclick`、`check`、`hover` 也能加） |
| 上传文件 | `{"upload": "input[type=file]", "files": ["data/a.xlsx"]}` | 直接把文件交给文件输入框，藏起来的输入框也行，不用点开系统的文件选择框。路径相对场景文件所在的目录 |
| 应答文件选择框 | `{"onFileChooser": ["data/a.xlsx"]}` | 页面是点了按钮才弹文件选择框的：放在那一步点击**之前**，弹出来时自动选上这几个文件 |
| 悬停 | `{"hover": ".card"}` | |
| 勾选 / 取消 | `{"check": "#region3"}` / `{"uncheck": "#enabled"}` | 单选框、复选框 |
| 按键 | `{"press": "Enter"}` | 可加 `"selector"` 指定焦点元素 |
| 下拉选择 | `{"select": "#type", "value": "代理商"}` | 按 value 或显示文字 |
| 处理弹出的确认框 | `{"onDialog": "accept"}` | 放在会触发 confirm/alert 的点击**之前**；`dismiss` = 取消。对话框文字会存到 `as`（默认 dialog） |
| 等元素出现 | `{"wait": "#userTable tbody tr"}` | 等到可见 |
| 等元素消失 | `{"waitHidden": "#loading"}` | |
| 等固定时间 | `{"wait": 500}` | 毫秒，最多等 60 秒 |
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
| 像素比对 | `{"diff": "users", "ref": "../design/users.png", "max": 2}` | 先 screenshot 同名，想知道差异落在哪个元素上就再先 layout 同名；`ref` 相对场景文件所在目录；`max` 为允许的最大差异百分比，超过即失败 |

## 接口

改了后端的，直接调接口、查返回。和页面步骤可以混着用：`request` 带着页面的登录状态（同一份 cookie）。场景里全是这几种步骤时不开浏览器。

| 动作 | 写法 | 说明 |
|---|---|---|
| 调接口 | `{"request": "POST /api/orders", "json": {"name": "张三"}}` | 方法 + 地址（相对 `--base`）；`json` 发 JSON，`form` 发表单，`params` 查询参数，`headers` 请求头，`timeout` 毫秒。也可以写 `{"request": {"method": "PUT", "url": "/api/x"}}` |
| 等页面发出的请求返回 | `{"waitResponse": "/api/orders", "method": "POST", "click": {"role": "button", "name": "保存"}}` | 先开始等，再做同一步里写的动作（`click` / `dblclick` / `press` / `goto` / `fill`+`value` / `type`+`value` / `select`+`value` / `check`），免得请求在开始等之前就回来了。地址按包含匹配，带 `*` 按通配，写成 `"/…/"` 按正则 |
| 查状态码 | `{"expectStatus": 200}` / `{"expectStatus": [200, 201]}` | 查的是最近一次 `request` / `waitResponse` 的响应。可以直接写在 `request` / `waitResponse` 那一步里 |
| 查返回的字段 | `{"expectJson": "data.list[0].status", "equals": "已发货"}` | 路径用点和 `[下标]`，`length` 取长度，空串是整个返回。比较：`equals`（相等，按 JSON 比，`0` 和 `"0"` 不相等）、`contains`（字符串包含 / 数组里有）、`exists: false`（不该有这个字段）、`gte` / `lte`（数字大小）；都不写 = 有这个字段 |
| 读返回的字段 | `{"readJson": "data.id", "as": "orderId"}` | 存到 values；后面的步骤里写 `{{orderId}}` 引用（地址、`json`、`form`、`fill` 的值、`equals` 里都行） |

**登录要查返回的内容，不能只等它返回**。很多系统登录失败也是 200，错在返回的字段里。在等响应的那一步里直接查：

```json
{ "waitResponse": "AccessToken.do", "click": {"role": "button", "name": "登录"}, "expectJson": "iserror", "equals": false }
```

这一步没过，后面的步骤不会执行，不会带着"没登录上"的状态去调接口。

例子（下单再查回来）：

```json
{
  "name": "下单并查回",
  "steps": [
    { "request": "POST /api/orders", "json": { "customer": "张三", "items": [{ "sku": "A", "qty": 2 }] } },
    { "expectStatus": 201 },
    { "expectJson": "code", "equals": 0 },
    { "readJson": "data.id", "as": "orderId" },
    { "request": "GET /api/orders/{{orderId}}" },
    { "expectJson": "data.status", "equals": "待支付" },
    { "expectJson": "data.items.length", "equals": 1 }
  ]
}
```

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
- `"consoleIgnore": ["[Vue warn]", "[HMR]"]`：忽略的 console 错误，用于开发态噪音。**默认按字面匹配**（错误文字里包含这几个字就忽略）；要用正则就前后加斜杠：`"/Failed to load resource.*favicon/"`。单步也可 `{"expectNoConsoleErrors": true, "ignore": ["…"]}`，写法一样。正则写错了执行器直接报错退出（退出码 2）
- `"viewport": {"width": 1440, "height": 900}`、`"timeout": 10000`（每一步最多等多久，毫秒，最多 120 秒）
- 整个场景默认最多跑 5 分钟，到点把已有的结果写出来退出；确实要跑更久，命令里加 `--max 秒数`
- 截图可加遮罩：`{"screenshot": "report", "mask": [{"text": "更新时间"}]}`，动态区域涂成品红不参与比对。遮罩由执行器自己画，不用 Playwright 的 mask 选项，因为后者在 Chromium 92 这类老浏览器上会报错
- `{"waitIdle": true}` 等网络空闲；`{"type": sel, "value": "…"}` 逐字输入（触发按键事件）；`{"readAttr": sel, "name": "href", "as": "x"}` 读属性

## 组件归因

布局树里每个节点带一列"组件"：Vue 3 开发版页面会自动标出组件链，如 `UsersView>UserTable>StatusTag[ElTag]`；生产构建没有这个引用，约定组件根元素加 `data-comp="组件名"` 属性即可。像素比对的结果里会带上它：差异落在哪个节点、哪个组件上，就去改哪个组件。

## 完整例子

```json
{
  "name": "登录并检查用户列表",
  "steps": [
    { "goto": "/login.html" },
    { "fill": "#username", "value": "<账号>" },
    { "fill": "#password", "value": "<密码>" },
    { "waitResponse": "/api/login", "click": "text=登录", "expectStatus": 200, "expectJson": "code", "equals": 0 },
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

- 控制台每步一行：`√`/`×` + 步骤 + 耗时 + 说明；最后一行 `RESULT {...}` 是紧凑 JSON：`values`（read/readCount 读到的值；超过 200 字的截断，全文在 `result.json`）、失败步骤、`warnings`（写了没做的动作，有就要改场景）、console 错误、失败请求、产物路径
- 输出目录（`--out` 指定；不写就是当前目录下的 `.vibe/out/<场景文件名>/`）里有 `result.md`（人看）和 `result.json`（程序读），以及截图、布局树、比对结果；某步失败时自动多一张 `failed-step-N.png`
- 退出码 0 = 全部通过；1 = 有步骤失败（步骤名或选择器写错也算，报错里写着"不认识的步骤"）；2 = 参数或场景文件有错：不是合法 JSON、没有 steps、用了相对路径却没给 `--base`、忽略规则里的正则写错、要打开模型路由自己的地址（配置页不是被测的项目）
