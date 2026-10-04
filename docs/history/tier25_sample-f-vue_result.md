# 场景：F Vue 单页应用：动态路由菜单 + Element 表格分页 + 深链到异步组件 + 组件归因

- 场景文件：C:\Users\ttls\Desktop\browser-probe-20260903\browser-probe\scenarios\sample-f-vue.json
- 浏览器：系统 Edge（channel=msedge）
- 结论：有失败

| # | 步骤 | 结果 | 耗时 | 说明 |
|---|---|---|---|---|
| 1 | goto "/f/login" | 通过 | 227 | 打开 http://127.0.0.1:4173/f/login |
| 2 | fill {"label":"用户名"} = "admin" | 通过 | 37 |  |
| 3 | fill {"label":"密码"} = "admin123" | 通过 | 13 |  |
| 4 | click {"role":"button","name":"登录"} | 通过 | 43 |  |
| 5 | waitUrl "**/f/users" | 通过 | 326 | http://127.0.0.1:4173/f/users |
| 6 | wait ".user-table .el-table__row" | 通过 | 328 |  |
| 7 | readCount ".el-menu-item" → menuItems | 通过 | 4 | menuItems = 3 |
| 8 | read ".el-pagination__total" → total | 通过 | 3 | total = "共 23 条" |
| 9 | readCount ".user-table .el-table__body .el-tag--danger" → stoppedOnPage1 | 通过 | 2 | stoppedOnPage1 = 2 |
| 10 | click ".el-pagination .btn-next" | 通过 | 51 |  |
| 11 | click ".el-pagination .btn-next" | 通过 | 42 |  |
| 12 | wait 400 | 通过 | 406 | 等待 400ms |
| 13 | readCount ".user-table .el-table__row" → page3Rows | 通过 | 4 | page3Rows = 3 |
| 14 | layout "users" | 通过 | 37 | 节点数 94，其中 94 个能归因到组件，见 C:\Users\ttls\Desktop\browser-probe-20260903\browser-probe\results\auto-20260905-194254\tier25\sample-f-vue\users-layout.txt |
| 15 | goto "/f/report" | 通过 | 125 | 打开 http://127.0.0.1:4173/f/report |
| 16 | wait "#reportOrders" | 通过 | 2354 |  |
| 17 | read "#reportOrders" → reportOrders | 通过 | 5 | reportOrders = "128" |
| 18 | read {"text":"统计周期"} → periodLabel | 通过 | 4 | periodLabel = "统计周期" |
| 19 | screenshot "report" | 失败 | 10 | page.screenshot: TypeError: Cannot add property 0, object is not extensible
    at Array.push (<anonymous>)
    at new Highlight (<anonymous>:4683:48)
    at InjectedScript._ensureHighlight (<anonymous>:7799:25)
    at InjectedScript.addMaskedElements (<anonymous>:7794:28)
    at eval (eval at eval … |
| 20 | expectNoConsoleErrors true | 跳过 |  |  |

- 读取到的值：
  - menuItems = 3
  - total = "共 23 条"
  - stoppedOnPage1 = 2
  - page3Rows = 3
  - reportOrders = "128"
  - periodLabel = "统计周期"
- console 错误：无
- 页面未捕获异常：无
- 失败请求：无
- 产物：
  - C:\Users\ttls\Desktop\browser-probe-20260903\browser-probe\results\auto-20260905-194254\tier25\sample-f-vue\users-layout.json
  - C:\Users\ttls\Desktop\browser-probe-20260903\browser-probe\results\auto-20260905-194254\tier25\sample-f-vue\users-layout.txt
  - C:\Users\ttls\Desktop\browser-probe-20260903\browser-probe\results\auto-20260905-194254\tier25\sample-f-vue\failed-step-19.png