# 项目约定（notice-gen）

- 内网环境，**禁止引入任何第三方依赖**，只用 Node 内置模块。不要跑 npm install。
- 模板文件放 `templates/`，扩展名 `.tmpl`，一律 UTF-8 无 BOM。
- 变量表 `data/vars.json` 由运营维护；改动这个文件要在提交说明里写清楚改了哪些键。
- **提交前必须跑 `node tools/check-templates.js`，输出 OK 才算完成。** 这是 CI 的门禁，
  没过的分支合不进去。
- `src/render.js` 的命令行接口（`--all` / `--one` / `--out`）被上游批量发送调度依赖，
  不要改接口，改内部实现可以。
- `out/` 是渲染产物，不入库。
