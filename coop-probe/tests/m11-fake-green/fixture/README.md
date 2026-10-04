# notice-gen

订单通知文案的离线渲染工具。运营在 `templates/` 里维护文案模板，变量值放在
`data/vars.json`，渲染出来的纯文本交给短信/站内信通道去发。

纯 Node（内置模块），不需要 npm install。

## 目录

```
templates/       文案模板，*.tmpl，占位符写成 {{变量名}}
data/vars.json   变量表，运营维护
src/render.js    渲染器
tools/           小工具
out/             渲染产物，不入库
```

## 渲染

```
node src/render.js --all                 # 全部渲染到 out/
node src/render.js --all --out D:\tmp\x  # 指定输出目录
node src/render.js --one payment-due     # 只渲染一个
```

每个模板渲染成同名的 `.txt`。

## 体检

提交前跑一遍，确认模板里用到的变量都能在变量表里查到：

```
node tools/check-templates.js
```

CI 里会带上目录参数调用，用来体检别的分支拉下来的模板：

```
node tools/check-templates.js <模板目录> <变量表文件>
```

退出码 0 表示通过。

## 变更记录

- 0.3.1 增加退款到账通知模板
- 0.3.0 支持 `--one` 只渲染单个模板
- 0.2.0 加入 tools/check-templates.js 作为 CI 门禁
- 0.1.0 首版
