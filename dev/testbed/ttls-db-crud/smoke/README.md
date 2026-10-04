# ttls-db-crud 冒烟靶场

2026-09-30 从 skytech-skills 的 `testbed/urai-db-crud/smoke` 搬过来。技能改名、并进 vibe-kit 之后在这里维护。

这里只有一份**假连接配置**，指向 198.51.100.1（文档用保留地址，永远连不上），和一个放着各种写法的配置文件的假项目。

测的是**不连库就能定的那一半**：

- SQL 分类与风险分级（`scripts/sqlguard_selftest.py`）
- 扫项目的配置文件：Spring Boot 多数据源、老项目的 properties、XML；注释掉的旧地址不能当成配置
- 配置读取、口令占位符
- 连库之前就该拦下的：删库、只读连接上的写、命中禁止名单、一次发多条语句

## 怎么跑

`dev/test-dbcrud.js` 最后一节照 `expected.json` 逐条跑，和连库的用例一起：

```bash
node dev/test-dbcrud.js <运行环境的目录>
```

运行环境的目录里要有 `python/python.exe`、`jdk/bin/java.exe`、`h2.jar`。

`expected.json` 的写法：`cmd` 里的 `python` 换成运行环境里的解释器，`skills/ttls-db-crud/…` 指装进假用户目录的技能，
`testbed/ttls-db-crud/…` 指这个靶场的一份拷贝。`expect_contains` 每一段都要出现在输出里；`expect_exit` 默认 0；
`stream` 指定断言看 stdout、stderr 还是两个都看（默认两个都看）。

驱动不随包带了。用例是按"驱动都有"写的，测试里先给假连接用到的两种数据库各登记一个 jar，不会真去连。

## 连库的验证

H2（MySQL 兼容模式）走完整的读写循环，在 `dev/test-dbcrud.js` 前面几节。
达梦、神通、Oracle、人大金仓、MySQL 的真库在这台电脑上测不了，记录在 `dev/docs/ttls-db-crud/验证记录.md`，每支持一种新数据库、每改一次执行器补一次。
