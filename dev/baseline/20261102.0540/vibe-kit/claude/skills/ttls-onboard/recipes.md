# 各类项目怎么查快检和全量

这些都是在真实项目上踩过的。命令在 Git Bash 里执行，路径一律用正斜杠或加引号。

## Maven（含 Spring Boot）

- **全量**：`mvn -q -DskipTests compile`。
  - 先试带 `-o`（离线）更快。如果报 `Non-resolvable parent POM`、`offline mode`、`Could not find artifact`，说明父 pom 或公司内部依赖只在私服上，去掉 `-o` 再来，并把"离线编不了"记进坑里。
- **快检**：`mvn compile` 动辄几十秒，不适合改一处跑一次。做法是把依赖的 classpath 导出来缓存，之后用 javac 只编这一项任务里改过的文件（改了几个就一起传几个）：
  1. 导 classpath（只做一次，依赖变了才重做）：
     `mvn -q -DskipTests -DincludeScope=compile "-Dmdep.outputFile=<项目>/.vibe/cp.txt" compile dependency:build-classpath`
     命令里必须带 `compile`，否则多模块项目里兄弟模块还没产出，依赖解析不到。
  2. 多模块：在**根目录**执行，加 `-pl <模块相对路径> -am`。
  3. 快检命令（`-d` 指向的目录要先 `mkdir -p` 建好，JDK 8 不会自己建）：
     `javac -J-Duser.language=en -J-Dfile.encoding=UTF-8 -encoding UTF-8 -nowarn -cp "<cp.txt 的内容>;<模块>/target/classes" -d "<临时目录>" <这一项任务里改过的 src/main/java 下的 .java，一起传>`
     classpath 很长时写进参数文件 `.vibe/javac.args`，命令行用 `@.vibe/javac.args`。参数文件里的路径用正斜杠并加引号。
  - 没传进来的类，用的是 `target/classes` 里的旧版本。报 `cannot find symbol` 而且指向你刚改过的另一个类，是漏传了，不是真错，把它一起传再编。
  - 测试类不要传进来，classpath 里没有测试依赖。
  - 用了 Lombok、MapStruct 这类注解处理器的项目，处理器的 jar 已经在 cp.txt 里，照上面的命令就能工作；如果仍报生成的方法找不到，就退回 `mvn -q compile` 当快检，如实记下耗时。
- **启动**：Spring Boot 用 `mvn spring-boot:run`，端口看 `application.properties` / `application.yml` 的 `server.port`，默认 8080。起来的标志是日志里出现 `Started ... in ... seconds`，或者端口能访问（根路径返回 404 也算起来了）。
  - Spring Boot 3 要 JDK 17，Spring Boot 2 一般用 JDK 8。先看 `JAVA_HOME` 指的是哪个。
  - 项目路径里带中文时 `spring-boot:run` 会报找不到主类，这是已知的坑，记下来告诉用户。
- **单测**：`mvn -q -Dtest=<类名> test`。多模块在根目录跑：`mvn -q -pl <模块> -am -Dtest=<类名> -Dsurefire.failIfNoSpecifiedTests=false test`，不加最后那个参数，会在没有这个测试类的兄弟模块上报 No tests 而失败。

## 没有 pom 的老式 Java Web（IDE 里配 Tomcat 启动）

- 源码目录、jar 从这些地方找：Eclipse 的 `.classpath`（`kind="src"`、`kind="lib"`），IDEA 的 `*.iml` 和 `.idea/libraries/*.xml`，以及 `WebRoot|WebContent|web|webapp/WEB-INF/lib`。
- 还缺 Servlet 接口：用 Tomcat 自带的 `<Tomcat>/lib` 目录下的 jar。Tomcat 位置依次看 `CATALINA_HOME`、IDEA 的应用服务器配置、常见安装路径；找不到就问用户。
- **全量**：classpath 留在命令行上，参数文件 `.vibe/javac.args` 只放全部源码路径（正斜杠、加引号）：
  `javac -J-Duser.language=en -J-Dfile.encoding=UTF-8 -encoding <编码> -nowarn -cp "<WEB-INF/lib>/*;<Tomcat>/lib/*" -d "<临时目录>/classes" @.vibe/javac.args`
  - classpath 通配只认命令行上的 `目录/*`；写 `*.jar` 无效，写进参数文件也无效，只会报一堆找不到包。
  - `-d` 的目录先 `mkdir -p` 建好。只往临时目录编，不要碰项目自己的输出目录。
- **快检**：classpath 在上面的基础上加上全量编出来的 classes 目录，只编这一项任务里改过的文件，一起传。全量没编过的话，快检会满屏找不到符号，那不是真错。
- javac 的报错固定成英文（上面的 `-J-Duser.language=en`），中文报错在终端里是乱码，看不懂。
- 有的项目只能用 JDK 8 编（用了 `sun.misc.BASE64Encoder` 这类内部类），换高版本会报找不到符号。
- **启动**：通常只能在 IDE 里点，记成"在 IDE 里启动"，别硬凑命令。

## 前端（Vue / React）

- 先看 `package.json` 的 scripts 和依赖，看 `node_modules` 在不在（不在就没法跑，告诉用户）。
- **全量**：`npm run build`，记下耗时。
- **类型检查**：`package.json` 里有 `type-check` 脚本就用它。没有的话先看 `tsconfig.json`：
  - 如果是 `"files": []` 加 `references`（Vite / create-vue 模板默认就是这样），裸跑 `vue-tsc --noEmit` **一个文件都不查、永远 0 错误**，要写成 `npx --no-install vue-tsc --noEmit -p tsconfig.app.json`。
  - 否则用 `npx --no-install vue-tsc --noEmit`（非 Vue 项目用 `tsc`）。
  - 结果是 0 错误时别急着信：加 `--listFilesOnly` 看一眼列出来的文件里有没有 `src` 下的，没有就是没查到。
- 类型检查是全量的，几十秒，而且很多项目**现在就是红的**。所以：
  - 跑一次，把现有的错误保存到 `.vibe/typecheck-baseline.txt`。
  - 以后只看**新增**的错误。别因为原本就有的错误卡住，也别顺手去修它们。
- **快检**：装了 eslint 就用 `npx --no-install eslint <改动的文件>`。没装就没有单文件快检，改完靠 dev server 热更新，用 /ttls-see-page 看页面。
- **启动**：`npm run dev`，端口看 `vite.config.*` 或启动日志。后端接口的代理目标也在这里，记下来。

## Gradle

- **全量**：有 wrapper 就用 `./gradlew.bat compileJava --offline -q`（Git Bash 里要带 `./`），没有就用 `gradle`。离线不行就去掉 `--offline`。
- **快检**：先用全量顶着，记下耗时；超过十秒就告诉用户，商量要不要导 classpath。

## 技能工程（开发 Claude 技能、命令、代理、插件的仓库）

- 认：`skills/<名字>/SKILL.md`（或者每个顶层目录一个 SKILL.md）、`commands/*.md`、`agents/*.md`、`.claude-plugin/plugin.json`、`marketplace.json`。
- **快检**：`node "$HOME/.claude/vibe-kit/tools/skills-check.js" <仓库目录> --repo`。只看仓库里的技能，不掺本机装的：frontmatter 读不读得出、有没有 description、有没有说"什么时候用"、超没超 1536 字、有没有同名。有问题退出码 1，报告里逐条列。改了脚本的加语法检查：
  - JS：`node --check <文件>`
  - Python：`python -m py_compile <文件>`
  - PowerShell：`powershell -NoProfile -Command "[void][scriptblock]::Create((Get-Content -Raw '<文件>'))"`，有语法错会报出来
  - bat 没有语法检查，跑一遍 `--help` 或干跑一次。
- **全量**：清点工具对整个仓库跑一遍；仓库自带测试（tests/、evals/、`npm test`）就跑它，记下耗时。
- **试用**：按仓库 README 的安装方式装到本机（一般是复制到 `~/.claude/skills/<名字>`，插件用 `claude --plugin-dir <仓库>` 起一个会话），新开一个会话说一句能触发它的话，看它用不用、用了对不对；试完把复制过去的删掉。别动 vibe-kit 自己装的那几个技能（钩子也不让动）。
- **启动**：不适用。
- 坑：description 第一句必须写"什么情况下用"，模型只看这一句决定用不用；所有技能的 description 加起来有总字数上限（清点工具会算），超了每条都被压短；脚本里别写死某台机器的路径；技能里引用文件用相对路径。

## 文档、规范工程

- 认：几乎全是 .md / .docx，或者只有 openspec/，没有构建文件。
- **快检**：仓库自带 markdownlint、链接检查就记命令；没有就记"不适用：改完通读改动的那一节，文中的路径和链接用 grep 核对存在"。
- **全量、启动、看页面**：不适用。
- 编码照查。.docx 用相应的技能读写，别当文本改。

## 散装脚本、工具工程

- 认：一堆 .bat / .ps1 / .py / .js，没有 pom、package.json 之类，各跑各的。
- **快检**：语法检查（命令同技能工程那一节）；脚本有 `--help`、`--dry-run` 的记下来。
- **全量**：不适用，或者仓库自带的自测脚本。
- **启动**：不适用；改成记"每个脚本怎么跑"：参数、依赖（node、python 的版本）、要不要管理员、会不会改系统。

## 编码

- 判断一个文件是不是 UTF-8：`node -e "try{new TextDecoder('utf-8',{fatal:true}).decode(require('fs').readFileSync(process.argv[1]));console.log('UTF-8')}catch(e){console.log('不是 UTF-8')}" <文件>`
- javac 的 `-encoding` 跟着多数文件走。GBK 和 UTF-8 混着的工程，一条 javac 命令编不过（IDE 能编过是因为它按文件记编码），把少数派文件列给用户，由用户决定要不要统一。
- 如果 javac 报 `unmappable character` 而且**每个文件都错在第 1 行**，那不是编码问题，是 javac 没读到明文（内网的文件加密策略没放行这个程序）。告诉用户，不要试图转码。
