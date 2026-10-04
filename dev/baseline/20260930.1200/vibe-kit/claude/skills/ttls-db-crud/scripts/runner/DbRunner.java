import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileDescriptor;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.io.PrintStream;
import java.io.Writer;
import java.math.BigDecimal;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.nio.charset.Charset;
import java.security.SecureRandom;
import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.Driver;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.sql.Statement;
import java.sql.Timestamp;
import java.sql.Types;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.Enumeration;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Properties;

/**
 * DbRunner —— ttls-db-crud 技能的数据库执行器。
 *
 * <p>只用 JDK 自带的 java.sql，不依赖任何第三方库。用 javac --release 8 编译一次，
 * 在 JDK 8 / 11 / 17 上都能跑。JDBC 驱动由调用方用 -cp 挂进来。
 *
 * <p>默认一次调用干一件事，干完就退。进程不常驻，也不跨调用保持连接或事务。
 * 只有 {@code --mode serve}（后台执行器，开关默认关）会留着：连接留着不断，几分钟没人用自己退出。
 * 留着的时候每个请求照样自己开事务、自己结束，不跨请求保持事务。
 *
 * <p>约定：
 * <ul>
 *   <li>口令走环境变量 DBCRUD_PASSWORD，<b>绝不走命令行</b>（命令行会进进程列表和对话记录）。</li>
 *   <li>SQL 和别的可能带中文、引号的内容走标准输入。老的几种模式多段之间用一行 {@code --@@DBCRUD-SEP@@} 分隔；
 *       新的几种模式每段带标签：{@code --@@DBCRUD-SEP@@ 标签}。</li>
 *   <li>标准输入以一行 {@code --@@DBCRUD-END@@} 收尾。<b>没看到这一行就什么都不做</b>：
 *       那头写到一半被结束（超时、用户按了 Esc）时，这边收到的可能是半截 SQL，少了 WHERE 的那种。</li>
 *   <li>结果是一行 JSON 打到标准输出，成功失败都是 JSON，异常栈不会直接吐出来。</li>
 *   <li>写操作在一个事务里完成：先核对影响行数、取改前快照，再执行，成功才提交；任何失败都显式回滚。</li>
 *   <li>只读的模式最后一律回滚，不提交：万一传进来的不是查询（有的驱动用 executeQuery 也能执行写语句），也落不了库。</li>
 * </ul>
 */
public final class DbRunner {

    /** stdin 里分隔多段内容的标记，必须在行首。 */
    private static final String SEP = "--@@DBCRUD-SEP@@";
    /** 后台执行器：一个请求到这一行为止。 */
    private static final String END = "--@@DBCRUD-END@@";

    /** 单元格超过这个长度就截断，避免把上下文撑爆。可用 --max-cell 覆盖。 */
    private static final int DEFAULT_MAX_CELL = 2000;

    private static final Charset UTF8 = Charset.forName("UTF-8");

    /** 这一次调用的输出和输入。平时是标准输出、标准输入；后台执行器里是这个请求的那条连接。 */
    private final PrintStream out;
    private final String input;
    private final String password;

    private DbRunner(PrintStream out, String input, String password) {
        this.out = out;
        this.input = input;
        this.password = password;
    }

    public static void main(String[] args) {
        // stdout 显式按 UTF-8 输出：Windows 上 JVM 默认跟随系统代码页（GBK），
        // 不这么做中文会变成问号，而且各 JDK 版本行为还不一致。
        PrintStream stdout;
        try {
            stdout = new PrintStream(new FileOutputStream(FileDescriptor.out), true, "UTF-8");
        } catch (Exception e) {
            stdout = System.out;
        }

        Map<String, String> opt;
        try {
            opt = parseArgs(args);
        } catch (Exception e) {
            failTo(stdout, "BAD_ARGS", e.getMessage(), null);
            return;
        }

        String mode = opt.get("mode");
        if (mode == null) {
            failTo(stdout, "BAD_ARGS", "缺少 --mode", null);
            return;
        }
        if ("serve".equals(mode)) {
            serve(opt, stdout);
            return;
        }

        String body = stripEnd(readAllUtf8(System.in));
        if (body == null) {
            failTo(stdout, "INCOMPLETE", "交过来的内容没有收全（没看到结束标记），什么都没有执行。", null);
            return;
        }
        DbRunner r = new DbRunner(stdout, body, System.getenv("DBCRUD_PASSWORD"));
        Connection conn = null;
        try {
            conn = r.connect(opt);
            r.run(mode, conn, opt);
        } catch (IllegalArgumentException e) {
            r.fail("BAD_ARGS", e.getMessage(), null);
        } catch (SQLException e) {
            r.fail("SQL_ERROR", e.getMessage(), e);
        } catch (Throwable t) {
            r.fail("RUNNER_ERROR", String.valueOf(t.getMessage()), null);
        } finally {
            closeQuietly(conn);
        }
    }

    /**
     * 交过来的内容必须以结束标记那一行收尾。返回去掉标记之后的内容；没有标记（没收全）返回 null。
     */
    private static String stripEnd(String s) {
        int end = s.length();
        while (end > 0 && Character.isWhitespace(s.charAt(end - 1))) {
            end--;
        }
        int at = end - END.length();
        if (at < 0 || !s.startsWith(END, at)) {
            return null;
        }
        if (at > 0 && s.charAt(at - 1) != '\n') {
            return null;                    // 标记必须自己占一行
        }
        int cut = at;
        if (cut > 0 && s.charAt(cut - 1) == '\n') {
            cut--;
        }
        if (cut > 0 && s.charAt(cut - 1) == '\r') {
            cut--;
        }
        return s.substring(0, cut);
    }

    /** 按模式分派。连接由调用方给、由调用方关。 */
    private void run(String mode, Connection conn, Map<String, String> opt) throws SQLException {
        if ("ping".equals(mode)) {
            doPing(conn);
        } else if ("meta".equals(mode)) {
            doMeta(conn, opt);
        } else if ("query".equals(mode)) {
            doQuery(conn, opt, firstSegment());
        } else if ("count".equals(mode)) {
            doCount(conn, opt, firstSegment());
        } else if ("batch".equals(mode)) {
            doBatch(conn, opt, readLabeled());
        } else if ("describe".equals(mode)) {
            doDescribe(conn, opt);
        } else if ("peek".equals(mode)) {
            doPeek(conn, opt, readLabeled());
        } else if ("multi".equals(mode)) {
            doMulti(conn, opt, readSegments());
        } else if ("find".equals(mode)) {
            doFind(conn, opt, readLabeled());
        } else if ("apply".equals(mode)) {
            doApply(conn, opt, readLabeled());
        } else {
            fail("BAD_ARGS", "不认识的 --mode: " + mode, null);
        }
    }

    // ==================================================================== 连接

    private Connection connect(Map<String, String> opt) throws SQLException {
        String url = required(opt, "url");
        String user = opt.get("user");

        // 老驱动（ojdbc14、mysql-connector 5.1 等）没有 META-INF/services 声明，
        // DriverManager 发现不了，需要显式点名。新驱动不用传这个参数。
        String driverClass = opt.get("driver-class");
        if (driverClass != null && driverClass.length() > 0) {
            try {
                Class.forName(driverClass);
            } catch (ClassNotFoundException e) {
                throw new SQLException("驱动类不在 classpath 上：" + driverClass);
            }
        }

        DriverManager.setLoginTimeout(intOpt(opt, "login-timeout", 10));

        Properties props = new Properties();
        if (user != null) {
            props.setProperty("user", user);
        }
        if (password != null) {
            props.setProperty("password", password);
        }
        // 额外的连接属性，形如 --prop k=v，可以重复
        String extra = opt.get("prop");
        if (extra != null) {
            for (String pair : extra.split("\u0001")) {
                int eq = pair.indexOf('=');
                if (eq > 0) {
                    props.setProperty(pair.substring(0, eq), pair.substring(eq + 1));
                }
            }
        }

        Connection c;
        try {
            c = DriverManager.getConnection(url, props);
        } catch (SQLException e) {
            throw new SQLException(describeConnectFailure(url, e), e.getSQLState(), e.getErrorCode());
        }
        // 显式关掉自动提交：写操作要自己掌握提交和回滚的时机。
        c.setAutoCommit(false);
        return c;
    }

    /** 连接串里带的账号口令遮掉（//用户:口令@、Oracle 的 用户/口令@、password=）：报错里不能把口令带出去。 */
    private static String maskUrl(String url) {
        if (url == null) {
            return "";
        }
        return url.replaceFirst("(//[^:/\\s@]+:)[^@\\s/]+@", "$1***@")
                .replaceFirst("(?i)(jdbc:oracle:[a-z]+:[^/@\\s]+/)[^@\\s]+@", "$1***@")
                .replaceAll("(?i)([?&;](?:password|passwd|pwd)=)[^&;]*", "$1***");
    }

    /** 连不上时给一句人话，而不是让使用者去猜驱动为什么没加载。 */
    private static String describeConnectFailure(String url, SQLException e) {
        String msg = e.getMessage() == null ? "" : e.getMessage();
        if (msg.indexOf("No suitable driver") >= 0) {
            List<String> loaded = new ArrayList<String>();
            Enumeration<Driver> drivers = DriverManager.getDrivers();
            while (drivers.hasMoreElements()) {
                loaded.add(drivers.nextElement().getClass().getName());
            }
            return "没有驱动认得这个 URL：" + maskUrl(url)
                    + "。当前 classpath 上已加载的驱动：" + (loaded.isEmpty() ? "一个都没有" : loaded)
                    + "。检查 -cp 里的驱动 jar 是否正确；老驱动可能还需要 --driver-class。";
        }
        return msg;
    }

    // ==================================================================== 老的几种模式

    private void doPing(Connection conn) throws SQLException {
        DatabaseMetaData md = conn.getMetaData();
        StringBuilder sb = new StringBuilder();
        sb.append("{\"ok\":true,\"mode\":\"ping\"");
        kv(sb, "product", md.getDatabaseProductName());
        kv(sb, "product_version", md.getDatabaseProductVersion());
        kv(sb, "driver", md.getDriverName());
        kv(sb, "driver_version", md.getDriverVersion());
        kv(sb, "user", md.getUserName());
        kv(sb, "schema", currentSchema(conn));
        kv(sb, "catalog", currentCatalog(conn));
        sb.append("}");
        out.println(sb);
        rollbackQuietly(conn);
    }

    private static String currentSchema(Connection conn) {
        try {
            return conn.getSchema();          // JDBC 4.1；部分老驱动会抛
        } catch (Throwable t) {
            return null;
        }
    }

    private static String currentCatalog(Connection conn) {
        try {
            return conn.getCatalog();
        } catch (Throwable t) {
            return null;
        }
    }

    /**
     * 元数据一律走 DatabaseMetaData，不拼各家方言的系统表 SQL。
     * 好处是五种数据库共用一套代码，达梦、神通这类库也不用维护它们的系统视图名。
     */
    private void doMeta(Connection conn, Map<String, String> opt) throws SQLException {
        DatabaseMetaData md = conn.getMetaData();
        String what = required(opt, "meta");
        String catalog = opt.get("catalog");
        String schema = opt.get("schema");
        String table = opt.get("table");
        // 列表的时候什么范围都没给：只列当前登录的 schema / 库的。不然列出来的是整台服务器上所有库的表
        if ("tables".equals(what) && empty(catalog) && empty(schema)) {
            schema = currentSchema(conn);
            if (empty(schema)) {
                schema = null;
                catalog = currentCatalog(conn);
            }
        }

        ResultSet rs;
        if ("schemas".equals(what)) {
            rs = md.getSchemas();
        } else if ("catalogs".equals(what)) {
            rs = md.getCatalogs();
        } else if ("tables".equals(what)) {
            rs = md.getTables(catalog, schema, opt.get("pattern") == null ? "%" : opt.get("pattern"),
                    new String[]{"TABLE", "VIEW"});
        } else if ("columns".equals(what)) {
            rs = md.getColumns(catalog, schema, requireTable(table), "%");
        } else if ("primary-keys".equals(what)) {
            rs = md.getPrimaryKeys(catalog, schema, requireTable(table));
        } else if ("indexes".equals(what)) {
            rs = md.getIndexInfo(catalog, schema, requireTable(table), false, true);
        } else if ("imported-keys".equals(what)) {
            rs = md.getImportedKeys(catalog, schema, requireTable(table));
        } else {
            fail("BAD_ARGS", "不认识的 --meta: " + what, null);
            return;
        }

        try {
            StringBuilder sb = new StringBuilder();
            sb.append("{\"ok\":true,\"mode\":\"meta\",\"meta\":").append(json(what)).append(",");
            appendResultSet(sb, rs, intOpt(opt, "max-rows", 5000), intOpt(opt, "max-cell", DEFAULT_MAX_CELL));
            sb.append("}");
            out.println(sb);
        } finally {
            closeQuietly(rs);
            rollbackQuietly(conn);
        }
    }

    private void doQuery(Connection conn, Map<String, String> opt, String sql) throws SQLException {
        int maxRows = intOpt(opt, "max-rows", 1000);
        readOnlyHint(conn);
        Statement st = conn.createStatement();
        ResultSet rs = null;
        long t0 = System.currentTimeMillis();
        try {
            applyTimeout(st, opt);
            // maxRows 交给驱动做硬限制：比读回来再丢弃省流量，大表上差别很大。
            // 多取一行是为了判断"是不是还有更多"。
            try {
                st.setMaxRows(maxRows + 1);
            } catch (Throwable ignore) {
                // 个别驱动不支持，下面按行数自己截断
            }
            try {
                st.setFetchSize(intOpt(opt, "fetch-size", 200));
            } catch (Throwable ignore) {
                // 同上，纯性能选项
            }
            rs = st.executeQuery(sql);
            StringBuilder sb = new StringBuilder();
            sb.append("{\"ok\":true,\"mode\":\"query\",");
            appendResultSet(sb, rs, maxRows, intOpt(opt, "max-cell", DEFAULT_MAX_CELL));
            sb.append(",\"elapsed_ms\":").append(System.currentTimeMillis() - t0);
            sb.append("}");
            out.println(sb);
        } finally {
            closeQuietly(rs);
            closeQuietly(st);
            // 只读的一律回滚：事务要结束（Oracle、达梦会因为悬着的事务持有快照），但不能提交
            rollbackQuietly(conn);
        }
    }

    /** 预扫：算一条写操作会碰多少行，用来定风险等级。只跑 COUNT，不改任何东西。 */
    private void doCount(Connection conn, Map<String, String> opt, String sql) throws SQLException {
        readOnlyHint(conn);
        Statement st = conn.createStatement();
        ResultSet rs = null;
        long t0 = System.currentTimeMillis();
        try {
            applyTimeout(st, opt);
            rs = st.executeQuery(sql);
            long n = -1;
            if (rs.next()) {
                n = rs.getLong(1);
            }
            out.println("{\"ok\":true,\"mode\":\"count\",\"count\":" + n
                    + ",\"elapsed_ms\":" + (System.currentTimeMillis() - t0) + "}");
        } finally {
            closeQuietly(rs);
            closeQuietly(st);
            rollbackQuietly(conn);
        }
    }

    /**
     * 改前快照：写进文件，结果里记下取了多少行、取全了没有。
     *
     * <p>写操作里显式 rollback 是必须的：不像连接池会在归还连接时替你回滚，
     * 直连模式下"没提交就关闭"的行为由驱动自己决定，Oracle 系的驱动关闭时可能隐式提交。
     */
    private void snapshot(Connection conn, Map<String, String> opt, String beforeSql, String writeSql, StringBuilder sb)
            throws SQLException, IOException {
        String snapshotPath = opt.get("snapshot-out");
        int snapshotMaxRows = intOpt(opt, "snapshot-max-rows", 10000);
        if (beforeSql == null || beforeSql.trim().length() == 0 || snapshotPath == null) {
            sb.append(",\"snapshot_rows\":0,\"snapshot_complete\":false");
            return;
        }
        Statement st = conn.createStatement();
        ResultSet rs = null;
        try {
            applyTimeout(st, opt);
            // 只留 snapshotMaxRows 行：交给驱动去限。不限的话 MySQL、金仓的驱动会把整个结果集读进内存，
            // 影响几十万行的改动光取快照就能把内存撑爆
            try {
                st.setMaxRows(snapshotMaxRows + 1);
            } catch (Throwable ignore) {
                // 个别驱动不支持，下面按行数自己截断
            }
            try {
                st.setFetchSize(intOpt(opt, "fetch-size", 200));
            } catch (Throwable ignore) {
                // 纯性能选项
            }
            rs = st.executeQuery(beforeSql);
            StringBuilder snap = new StringBuilder();
            snap.append("{\"captured_for\":").append(json(writeSql)).append(",");
            // 快照不截断单元格：它要用来还原数据，截断了就还原不回去。
            boolean[] more = new boolean[1];
            int rows = appendResultSet(snap, rs, snapshotMaxRows, Integer.MAX_VALUE, more);
            // 取全了没有：取到上限之后后面还有行，就是没取全（正好等于上限、后面没有了，算取全了）
            boolean complete = !more[0];
            // 这一行必须写进快照文件本身，不能只放在返回值里：
            // 生成反向 SQL 的时候只看得到文件，看不到当时的返回值。
            // 快照没取全却当成取全了，就会生成一份「只还原一部分」的反向 SQL。
            snap.append(",\"snapshot_complete\":").append(complete);
            snap.append(",\"snapshot_max_rows\":").append(snapshotMaxRows);
            snap.append("}");
            writeFileUtf8(snapshotPath, snap.toString());
            kv(sb, "snapshot_path", snapshotPath);
            sb.append(",\"snapshot_rows\":").append(rows);
            // 快照没取全就等于还原不了，必须让上层知道
            sb.append(",\"snapshot_complete\":").append(complete);
        } finally {
            closeQuietly(rs);
            closeQuietly(st);
        }
    }

    private int update(Connection conn, Map<String, String> opt, String writeSql) throws SQLException {
        Statement st = conn.createStatement();
        try {
            applyTimeout(st, opt);
            return st.executeUpdate(writeSql);
        } finally {
            closeQuietly(st);
        }
    }

    // ==================================================================== 新的几种模式：一次调用把几件事做完

    /**
     * 表在库里的范围。catalog 是配置里写死的，不试大小写；schema 会跟着表名一起试大小写。
     * MySQL 把库名放在 catalog 上：那时 schema 的值放到 catalog 的位置（schemaAsCatalog）。
     */
    private static final class Scope {
        final String catalog;
        final String schema;
        final boolean schemaAsCatalog;

        Scope(String catalog, String schema, boolean schemaAsCatalog) {
            this.catalog = empty(catalog) ? null : catalog;
            this.schema = empty(schema) ? null : schema;
            this.schemaAsCatalog = schemaAsCatalog;
        }

        static Scope of(Map<String, String> opt) {
            return new Scope(opt.get("catalog"), opt.get("schema"), "true".equals(opt.get("schema-as-catalog")));
        }

        Scope withSchema(String s) {
            return new Scope(catalog, s, schemaAsCatalog);
        }

        String catalogArg(String schemaVariant) {
            return schemaAsCatalog && schemaVariant != null ? schemaVariant : catalog;
        }

        String schemaArg(String schemaVariant) {
            return schemaAsCatalog ? null : schemaVariant;
        }
    }

    /** 一张表在库里实际的样子。 */
    private static final class Found {
        String asked;
        String schema;              // 表在哪：一般是 schema，MySQL 是库名。拼 SQL、查主键都用它（可能是 null）
        boolean ownerIsCatalog;     // schema 里放的其实是库名（catalog）
        String catalog;             // 配置里写死的 catalog（可能是 null）
        String table;               // 实际的表名
        int how;                    // 表名的大小写：0 原样，1 全大写，2 全小写
        String columnsJson;         // 列的结果集（和 meta columns 的输出同一个格式）
        int columnCount;
        List<String> names = new ArrayList<String>();
        Map<String, Integer> types = new HashMap<String, Integer>();   // 列名（小写）→ java.sql.Types
        List<String> tried = new ArrayList<String>();
        /** 没指定范围、当前的 schema 里又没有，别处却有好几张同名的：都列在这里，让人指定 */
        List<String> ambiguous = new ArrayList<String>();
    }

    private static String vary(String s, int how) {
        if (s == null) {
            return null;
        }
        return how == 1 ? s.toUpperCase(Locale.ROOT) : how == 2 ? s.toLowerCase(Locale.ROOT) : s;
    }

    /**
     * 表名和 schema 的大小写各有三种写法：原样、全大写、全小写。
     * 先试两个一起变的（最常见），再试只变一个的（sysdba.T_ORDER：表名不用变，schema 要变成大写）。
     * varySchema 为 false 时 schema 不变（它是从连接上取的，本来就是库里的写法）。
     * 返回的每一项是 { schema 的写法（可能是 null）, 表名的写法, 表名变没变（0 / 1 / 2） }。
     */
    private static List<String[]> variants(String schema, String table, boolean varySchema) {
        int[][] order = {{0, 0}, {1, 1}, {2, 2}, {1, 0}, {2, 0}, {0, 1}, {0, 2}, {1, 2}, {2, 1}};
        List<String[]> out = new ArrayList<String[]>();
        List<String> seen = new ArrayList<String>();
        for (int[] o : order) {
            String s = varySchema ? vary(schema, o[0]) : schema;
            String t = vary(table, o[1]);
            String key = s + "\u0001" + t;
            if (seen.contains(key)) {
                continue;
            }
            seen.add(key);
            out.add(new String[]{s, t, t.equals(table) ? "0" : String.valueOf(o[1])});
        }
        return out;
    }

    /**
     * 把 getColumns 的结果按"表在哪"分开收：键是所在的 schema（MySQL 是库名），值是那张表的列。
     *
     * <p>getColumns 的表名、schema 都是模式，下划线是通配符：T_ORDER 会把 TXORDER 的列也带出来，
     * MY_APP 会把 MYXAPP 里的同名表也带出来。所以表名按原样再比一遍；owner 给了的，所在的 schema / 库也按原样比。
     * 不这么分的话，几个库里的同名表的列会混成一张表。
     */
    private static Map<String, Found> collect(ResultSet rs, String table, String owner, boolean ownerIsCatalog,
                                              int maxCell) throws SQLException {
        ResultSetMetaData md = rs.getMetaData();
        int cols = md.getColumnCount();
        int tAt = labelIndex(md, "TABLE_NAME");
        int sAt = labelIndex(md, "TABLE_SCHEM");
        int cAt = labelIndex(md, "TABLE_CAT");
        int nameAt = labelIndex(md, "COLUMN_NAME");
        int typeAt = labelIndex(md, "DATA_TYPE");
        Map<String, Found> out = new LinkedHashMap<String, Found>();
        Map<String, StringBuilder> rows = new HashMap<String, StringBuilder>();
        Map<String, RowFlags> flags = new HashMap<String, RowFlags>();
        int seen = 0;
        while (rs.next()) {
            if (++seen > 50000) {
                break;
            }
            String t = tAt > 0 ? rs.getString(tAt) : null;
            if (t == null || !t.equals(table)) {
                continue;
            }
            String sch = sAt > 0 ? rs.getString(sAt) : null;
            String cat = cAt > 0 ? rs.getString(cAt) : null;
            // 范围是按库名（catalog）给的就拿库名比，按 schema 给的就拿 schema 比
            String scoped = ownerIsCatalog ? cat : sch;
            if (owner != null && scoped != null && !scoped.equals(owner)) {
                continue;
            }
            // 表在哪：有 schema 的用 schema；没有的（MySQL）用库名
            String own = sch != null ? sch : cat;
            String key = own == null ? "" : own;
            Found f = out.get(key);
            if (f == null) {
                f = new Found();
                f.schema = own;
                f.ownerIsCatalog = sch == null && cat != null;
                f.table = t;
                out.put(key, f);
                rows.put(key, new StringBuilder());
                flags.put(key, new RowFlags());
            }
            if (f.columnCount >= 5000) {
                continue;
            }
            String name = nameAt > 0 ? rs.getString(nameAt) : null;
            if (name != null) {
                f.names.add(name);
                if (typeAt > 0) {
                    f.types.put(name.toLowerCase(Locale.ROOT), Integer.valueOf(parseIntOr(rs.getString(typeAt), Types.VARCHAR)));
                }
            }
            StringBuilder sb = rows.get(key);
            if (f.columnCount > 0) {
                sb.append(",");
            }
            appendRow(sb, rs, md, cols, maxCell, flags.get(key));
            f.columnCount++;
        }
        for (Map.Entry<String, Found> e : out.entrySet()) {
            StringBuilder sb = new StringBuilder();
            appendHeader(sb, md);
            sb.append(rows.get(e.getKey()));
            appendTail(sb, e.getValue().columnCount, false, flags.get(e.getKey()), maxCell);
            e.getValue().columnsJson = sb.toString();
        }
        return out;
    }

    /**
     * 找到这张表在库里实际在哪、是什么大小写。
     *
     * <p>大小写：达梦、Oracle、金仓的 Oracle 模式把不带引号的标识符折成大写，神通和 PG 模式折成小写；
     * 大小写不对时元数据接口不报错，只是查不到。所以原样、全大写、全小写都试。
     *
     * <p>范围：给了 schema（或者 MySQL 的库名）就只在那里找。什么都没给：先在当前登录的 schema / 库里找；
     * 那里没有才到别处找，别处只有一张就用它，有好几张同名的就都列出来（f.ambiguous），让人指定。
     * 找不到时 f.table 是 null。
     */
    private Found resolve(Connection conn, DatabaseMetaData md, Scope scope, String asked, int maxCell)
            throws SQLException {
        Found none = new Found();
        none.asked = asked;
        String table = asked;
        Scope sc = scope;
        int dot = asked.lastIndexOf('.');
        if (dot > 0 && dot < asked.length() - 1) {
            sc = scope.withSchema(asked.substring(0, dot).trim());
            table = asked.substring(dot + 1).trim();
        }
        table = stripQuotes(table);
        String schema = sc.schema == null ? null : stripQuotes(sc.schema);
        boolean asCatalog = sc.schemaAsCatalog;
        boolean defaulted = false;
        if (schema == null && sc.catalog == null) {
            if (asCatalog) {
                schema = currentCatalog(conn);
            } else {
                schema = currentSchema(conn);
                if (empty(schema)) {
                    schema = currentCatalog(conn);
                    asCatalog = !empty(schema);
                }
                if (empty(schema)) {
                    // 老驱动取不到当前的 schema（ojdbc6）：Oracle、达梦的 schema 就是登录的用户名
                    try {
                        schema = md.getUserName();
                    } catch (Throwable t) {
                        schema = null;
                    }
                    if (schema != null && schema.indexOf('@') >= 0) {
                        schema = null;          // root@localhost 这种不是 schema
                    }
                }
            }
            if (empty(schema)) {
                schema = null;
            }
            defaulted = schema != null;
        }
        Scope use = new Scope(sc.catalog, schema, asCatalog);

        for (String[] v : variants(schema, table, !defaulted)) {
            none.tried.add(v[0] == null ? v[1] : v[0] + "." + v[1]);
            ResultSet rs = md.getColumns(use.catalogArg(v[0]), use.schemaArg(v[0]), v[1], "%");
            try {
                Found f = pick(conn, collect(rs, v[1], v[0], asCatalog, maxCell), none);
                if (f == null && !none.ambiguous.isEmpty()) {
                    return none;
                }
                if (f != null) {
                    f.asked = asked;
                    f.how = parseIntOr(v[2], 0);
                    f.tried = none.tried;
                    f.catalog = sc.catalog;
                    if (f.schema == null && v[0] != null) {
                        f.schema = v[0];
                        f.ownerIsCatalog = asCatalog;
                    }
                    return f;
                }
            } finally {
                closeQuietly(rs);
            }
        }
        if (!defaulted) {
            return none;
        }
        // 当前的 schema / 库里没有：到别处找
        for (String[] v : variants(null, table, false)) {
            none.tried.add("（别的 schema）" + v[1]);
            ResultSet rs = md.getColumns(null, null, v[1], "%");
            try {
                Found f = pick(conn, collect(rs, v[1], null, sc.schemaAsCatalog, maxCell), none);
                if (f == null && !none.ambiguous.isEmpty()) {
                    return none;
                }
                if (f != null) {
                    f.asked = asked;
                    f.how = parseIntOr(v[2], 0);
                    f.tried = none.tried;
                    return f;
                }
            } finally {
                closeQuietly(rs);
            }
        }
        return none;
    }

    /**
     * 找到的几张同名的表里用哪一张：只有一张就是它；有好几张，其中一张在当前登录的 schema 里，用那一张；
     * 不然就是分不清，都记进 none.ambiguous，返回 null。一张都没有也返回 null。
     */
    private static Found pick(Connection conn, Map<String, Found> got, Found none) {
        if (got.isEmpty()) {
            return null;
        }
        if (got.size() == 1) {
            return got.values().iterator().next();
        }
        String cur = currentSchema(conn);
        if (!empty(cur) && got.containsKey(cur)) {
            return got.get(cur);
        }
        for (Found f : got.values()) {
            none.ambiguous.add(f.schema + "." + f.table);
        }
        return null;
    }

    /** 这个库的标识符用什么引（MySQL 是反引号，别的多半是双引号）。取不到、不支持返回空串：那就不引。 */
    private static String quoteOf(DatabaseMetaData md) {
        try {
            String q = md.getIdentifierQuoteString();
            return q == null || q.trim().length() == 0 ? "" : q.trim();
        } catch (Throwable t) {
            return "";
        }
    }

    /**
     * 从元数据里拿到的名字放进 SQL：加上引号。名字是库里存的那个写法，加了引号正好对得上；
     * 不加的话保留字（desc、rank、user）、大小写混写的名字拼出来的 SQL 是错的。
     */
    private static String quoted(String name, String q) {
        if (name == null || q.length() == 0) {
            return name;
        }
        StringBuilder sb = new StringBuilder(q);
        int i = 0;
        while (i < name.length()) {
            if (name.startsWith(q, i)) {
                sb.append(q).append(q);
                i += q.length();
            } else {
                sb.append(name.charAt(i++));
            }
        }
        return sb.append(q).toString();
    }


    /** 主键列，按 KEY_SEQ 排好（联合主键里列的先后是有意义的）。 */
    private static List<String> primaryKeys(DatabaseMetaData md, Scope scope, Found f) {
        List<String[]> items = new ArrayList<String[]>();
        ResultSet rs = null;
        try {
            rs = md.getPrimaryKeys(f.ownerIsCatalog ? f.schema : f.catalog, f.ownerIsCatalog ? null : f.schema, f.table);
            ResultSetMetaData m = rs.getMetaData();
            int ci = labelIndex(m, "COLUMN_NAME");
            int si = labelIndex(m, "KEY_SEQ");
            while (rs.next()) {
                String name = ci > 0 ? rs.getString(ci) : null;
                if (name == null) {
                    continue;
                }
                String seq = si > 0 ? rs.getString(si) : null;
                items.add(new String[]{seq == null ? "0" : seq.trim(), name});
            }
        } catch (Throwable t) {
            // 取不到主键不算失败：上层按"没有主键"处理，并且会说出来
        } finally {
            closeQuietly(rs);
        }
        Collections.sort(items, new Comparator<String[]>() {
            public int compare(String[] a, String[] b) {
                int x = parseIntOr(a[0], 0);
                int y = parseIntOr(b[0], 0);
                return x != y ? (x < y ? -1 : 1) : a[1].compareTo(b[1]);
            }
        });
        List<String> names = new ArrayList<String>();
        for (String[] it : items) {
            names.add(it[1]);
        }
        return names;
    }

    /** 一次看几张表：列、主键。表名大小写自己试。 */
    private void doDescribe(Connection conn, Map<String, String> opt) throws SQLException {
        String tables = required(opt, "tables");
        Scope scope = Scope.of(opt);
        DatabaseMetaData md = conn.getMetaData();
        int maxCell = intOpt(opt, "max-cell", DEFAULT_MAX_CELL);
        long t0 = System.currentTimeMillis();
        StringBuilder sb = new StringBuilder();
        sb.append("{\"ok\":true,\"mode\":\"describe\",\"tables\":[");
        int n = 0;
        try {
            for (String asked : tables.split(",")) {
                asked = asked.trim();
                if (asked.length() == 0) {
                    continue;
                }
                if (n++ > 0) {
                    sb.append(",");
                }
                appendTable(sb, md, scope, resolve(conn, md, scope, asked, maxCell));
            }
        } finally {
            rollbackQuietly(conn);
        }
        sb.append("],\"elapsed_ms\":").append(System.currentTimeMillis() - t0).append("}");
        out.println(sb);
    }

    private static void appendTable(StringBuilder sb, DatabaseMetaData md, Scope scope, Found f) {
        sb.append("{\"asked\":").append(json(f.asked));
        sb.append(",\"found\":").append(f.table != null);
        sb.append(",\"tried\":").append(jsonList(f.tried));
        if (!f.ambiguous.isEmpty()) {
            sb.append(",\"ambiguous\":").append(jsonList(f.ambiguous));
        }
        if (f.table != null) {
            kv(sb, "schema", f.schema);
            kv(sb, "table", f.table);
            sb.append(",\"variant\":").append(json(f.how == 1 ? "upper" : f.how == 2 ? "lower" : "same"));
            sb.append(",\"columns\":{").append(f.columnsJson).append("}");
            sb.append(",\"primary_keys\":").append(jsonList(primaryKeys(md, scope, f)));
        }
        sb.append("}");
    }

    /**
     * 看一张表里有什么，不用写 SQL。表名大小写自己试；等值条件（eq:列名）用参数绑定，
     * 值里的引号、中文不用转义，数字和日期按列的类型绑。
     *
     * <p>表名、列名都是从元数据里拿的真名，加着引号拼进 SQL。
     * where 是调用方给的一段条件，原样拼（调用方查过：没有分号、注释、写操作的关键字）；这里再查一遍分号。
     * order 只认"列名 [ASC|DESC] [NULLS FIRST|LAST]"，列名要是这张表里有的。
     */
    private void doPeek(Connection conn, Map<String, String> opt, List<String[]> segs) throws SQLException {
        String asked = required(opt, "table");
        Scope scope = Scope.of(opt);
        int maxRows = intOpt(opt, "max-rows", 20);
        DatabaseMetaData md = conn.getMetaData();
        long t0 = System.currentTimeMillis();
        try {
            Found f = resolve(conn, md, scope, asked, intOpt(opt, "max-cell", DEFAULT_MAX_CELL));
            if (f.table == null) {
                out.println("{\"ok\":true,\"mode\":\"peek\",\"found\":false,\"asked\":" + json(asked)
                        + ",\"tried\":" + jsonList(f.tried)
                        + (f.ambiguous.isEmpty() ? "" : ",\"ambiguous\":" + jsonList(f.ambiguous)) + "}");
                return;
            }
            String q = quoteOf(md);
            // 要看哪几列。只数行数的（count-only）不看列
            boolean countOnly = "true".equals(opt.get("count-only"));
            String cols = seg(segs, "cols");
            StringBuilder select = new StringBuilder();
            if (countOnly) {
                select.append("COUNT(*) AS N");
            } else if (empty(cols)) {
                select.append("*");
            } else {
                for (String c : cols.split(",")) {
                    String real = realColumn(f, c.trim());
                    if (real == null) {
                        fail("BAD_ARGS", "表 " + f.table + " 里没有 " + c.trim() + " 这一列。有的列：" + f.names, null);
                        return;
                    }
                    if (select.length() > 0) {
                        select.append(", ");
                    }
                    select.append(quoted(real, q));
                }
            }
            String qualified = f.schema == null ? quoted(f.table, q) : quoted(f.schema, q) + "." + quoted(f.table, q);
            StringBuilder sql = new StringBuilder("SELECT ").append(select).append(" FROM ").append(qualified);
            List<String[]> binds = new ArrayList<String[]>();
            StringBuilder cond = new StringBuilder();
            for (String[] s : segs) {
                if (!s[0].startsWith("eq:")) {
                    continue;
                }
                String real = realColumn(f, s[0].substring(3).trim());
                if (real == null) {
                    fail("BAD_ARGS", "表 " + f.table + " 里没有 " + s[0].substring(3).trim() + " 这一列。有的列：" + f.names, null);
                    return;
                }
                if (cond.length() > 0) {
                    cond.append(" AND ");
                }
                cond.append(quoted(real, q)).append(" = ?");
                binds.add(new String[]{real, s[1]});
            }
            String where = seg(segs, "where");
            if (!empty(where)) {
                if (hasSemicolon(where)) {
                    fail("BAD_ARGS", "条件里不能有分号", null);
                    return;
                }
                if (cond.length() > 0) {
                    cond.append(" AND ");
                }
                cond.append("(").append(where.trim()).append(")");
            }
            if (cond.length() > 0) {
                sql.append(" WHERE ").append(cond);
            }
            String order = seg(segs, "order");
            if (!empty(order) && !countOnly) {
                StringBuilder ob = new StringBuilder();
                for (String item : order.split(",")) {
                    java.util.regex.Matcher m = ORDER_ITEM.matcher(item.trim());
                    String real = m.matches() ? realColumn(f, m.group(1)) : null;
                    if (real == null) {
                        fail("BAD_ARGS", "排序只写这张表里的列名，后面可以跟 ASC / DESC。这一项不对：" + item.trim()
                                + "。有的列：" + f.names, null);
                        return;
                    }
                    if (ob.length() > 0) {
                        ob.append(", ");
                    }
                    ob.append(quoted(real, q));
                    if (m.group(2) != null) {
                        ob.append(" ").append(m.group(2).toUpperCase(Locale.ROOT));
                    }
                    if (m.group(3) != null) {
                        ob.append(" NULLS ").append(m.group(3).toUpperCase(Locale.ROOT));
                    }
                }
                sql.append(" ORDER BY ").append(ob);
            }

            readOnlyHint(conn);
            PreparedStatement ps = conn.prepareStatement(sql.toString());
            ResultSet rs = null;
            try {
                applyTimeout(ps, opt);
                try {
                    ps.setMaxRows(maxRows + 1);
                } catch (Throwable ignore) {
                    // 个别驱动不支持，下面按行数自己截断
                }
                for (int i = 0; i < binds.size(); i++) {
                    bind(ps, i + 1, binds.get(i)[1], f.types.get(binds.get(i)[0].toLowerCase(Locale.ROOT)));
                }
                rs = ps.executeQuery();
                StringBuilder sb = new StringBuilder();
                sb.append("{\"ok\":true,\"mode\":\"peek\",\"found\":true,\"asked\":").append(json(asked));
                kv(sb, "schema", f.schema);
                kv(sb, "table", f.table);
                sb.append(",\"variant\":").append(json(f.how == 1 ? "upper" : f.how == 2 ? "lower" : "same"));
                kv(sb, "sql", sql.toString());
                List<String> shown = new ArrayList<String>();
                for (String[] b : binds) {
                    shown.add(b[0] + " = " + b[1]);
                }
                sb.append(",\"binds\":").append(jsonList(shown)).append(",");
                appendResultSet(sb, rs, maxRows, intOpt(opt, "max-cell", DEFAULT_MAX_CELL));
                sb.append(",\"elapsed_ms\":").append(System.currentTimeMillis() - t0);
                sb.append("}");
                out.println(sb);
            } finally {
                closeQuietly(rs);
                closeQuietly(ps);
            }
        } finally {
            rollbackQuietly(conn);
        }
    }

    /** 排序的一项：[别名.]列名 [ASC|DESC] [NULLS FIRST|LAST]。列名可以带引号 */
    private static final java.util.regex.Pattern ORDER_ITEM = java.util.regex.Pattern.compile(
            "^(?:[A-Za-z_][\\w$#]*\\s*\\.\\s*)?([\"`]?[A-Za-z_\\u4e00-\\u9fa5][\\w$#\\u4e00-\\u9fa5]*[\"`]?)"
                    + "(?:\\s+(ASC|DESC))?(?:\\s+NULLS\\s+(FIRST|LAST))?$",
            java.util.regex.Pattern.CASE_INSENSITIVE);

    /** 单引号的字符串之外有没有分号。 */
    private static boolean hasSemicolon(String s) {
        boolean in = false;
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '\'') {
                in = !in;
            } else if (c == ';' && !in) {
                return true;
            }
        }
        return false;
    }

    /** 表里实际的列名（大小写不敏感地找）。找不到返回 null。 */
    private static String realColumn(Found f, String name) {
        String want = stripQuotes(name);
        for (String n : f.names) {
            if (n.equalsIgnoreCase(want)) {
                return n;
            }
        }
        return null;
    }

    /** 按列的类型绑参数。类型对不上的库（金仓的 PG 模式）拿字符串和数字列比会报错。 */
    private static void bind(PreparedStatement ps, int i, String value, Integer type) throws SQLException {
        int t = type == null ? Types.VARCHAR : type.intValue();
        String v = value == null ? "" : value;
        try {
            switch (t) {
                case Types.TINYINT:
                case Types.SMALLINT:
                case Types.INTEGER:
                case Types.BIGINT:
                case Types.NUMERIC:
                case Types.DECIMAL:
                case Types.FLOAT:
                case Types.REAL:
                case Types.DOUBLE:
                    ps.setBigDecimal(i, new BigDecimal(v.trim()));
                    return;
                case Types.BIT:
                case Types.BOOLEAN:
                    String b = v.trim().toLowerCase(Locale.ROOT);
                    if ("true".equals(b) || "false".equals(b)) {
                        ps.setBoolean(i, "true".equals(b));
                    } else {
                        ps.setBigDecimal(i, new BigDecimal(b));
                    }
                    return;
                case Types.DATE:
                    if (v.trim().length() <= 10) {
                        ps.setDate(i, java.sql.Date.valueOf(v.trim()));
                    } else {
                        ps.setTimestamp(i, Timestamp.valueOf(v.trim()));
                    }
                    return;
                case Types.TIMESTAMP:
                    ps.setTimestamp(i, Timestamp.valueOf(v.trim().length() <= 10 ? v.trim() + " 00:00:00" : v.trim()));
                    return;
                default:
                    ps.setString(i, v);
            }
        } catch (IllegalArgumentException e) {
            // 值的写法不像这个类型（数字列给了 abc）：按字符串交给数据库，由它来报错或者转换
            ps.setString(i, v);
        }
    }

    /** 一次跑几条查询。哪条错了只记在那一条上，不影响别的。 */
    private void doMulti(Connection conn, Map<String, String> opt, List<String> sqls) throws SQLException {
        int maxRows = intOpt(opt, "max-rows", 200);
        int maxCell = intOpt(opt, "max-cell", DEFAULT_MAX_CELL);
        readOnlyHint(conn);
        StringBuilder sb = new StringBuilder();
        sb.append("{\"ok\":true,\"mode\":\"multi\",\"results\":[");
        int n = 0;
        long all0 = System.currentTimeMillis();
        try {
            for (String sql : sqls) {
                if (sql == null || sql.trim().length() == 0) {
                    continue;
                }
                if (n++ > 0) {
                    sb.append(",");
                }
                long t0 = System.currentTimeMillis();
                Statement st = null;
                ResultSet rs = null;
                int mark = sb.length();
                try {
                    st = conn.createStatement();
                    applyTimeout(st, opt);
                    try {
                        st.setMaxRows(maxRows + 1);
                    } catch (Throwable ignore) {
                        // 个别驱动不支持
                    }
                    rs = st.executeQuery(sql);
                    sb.append("{\"ok\":true,");
                    appendResultSet(sb, rs, maxRows, maxCell);
                    sb.append(",\"elapsed_ms\":").append(System.currentTimeMillis() - t0).append("}");
                } catch (SQLException e) {
                    sb.setLength(mark);
                    sb.append(failJson("SQL_ERROR", e.getMessage(), e));
                    // 出过错的事务在 PG 系的库上不能接着用，回滚了再跑下一条
                    rollbackQuietly(conn);
                } finally {
                    closeQuietly(rs);
                    closeQuietly(st);
                }
            }
        } finally {
            rollbackQuietly(conn);
        }
        sb.append("],\"elapsed_ms\":").append(System.currentTimeMillis() - all0).append("}");
        out.println(sb);
    }

    /**
     * 按关键字找表和字段：表名、表的注释、列名、列的注释里带这个词的。不用记系统表。
     * 库大的时候列很多：到了时间或者行数上限就停，结果里说明没看完。
     */
    private void doFind(Connection conn, Map<String, String> opt, List<String[]> segs) throws SQLException {
        String kw = seg(segs, "keyword");
        if (empty(kw)) {
            fail("BAD_ARGS", "要给关键字", null);
            return;
        }
        String needle = kw.trim().toLowerCase(Locale.ROOT);
        Scope scope = Scope.of(opt);
        DatabaseMetaData md = conn.getMetaData();
        String schema = scope.schema;
        String catalog = scope.catalog;
        // 没指定范围就只看当前登录的 schema / 库：不然会把系统表全扫一遍
        if (schema == null && catalog == null) {
            if (scope.schemaAsCatalog) {
                catalog = currentCatalog(conn);
            } else {
                schema = currentSchema(conn);
                if (schema == null) {
                    catalog = currentCatalog(conn);
                }
            }
        }
        String catArg = scope.schemaAsCatalog && schema != null ? schema : catalog;
        String schArg = scope.schemaAsCatalog ? null : schema;
        int maxHits = intOpt(opt, "max-hits", 200);
        int maxScan = intOpt(opt, "max-scan", 200000);
        long budget = intOpt(opt, "max-seconds", 20) * 1000L;
        boolean tablesOnly = "true".equals(opt.get("tables-only"));
        long t0 = System.currentTimeMillis();

        StringBuilder tb = new StringBuilder();
        StringBuilder cl = new StringBuilder();
        int tHits = 0;
        int cHits = 0;
        int tScan = 0;
        int cScan = 0;
        boolean cut = false;
        ResultSet rs = null;
        try {
            rs = md.getTables(catArg, schArg, "%", new String[]{"TABLE", "VIEW"});
            ResultSetMetaData m = rs.getMetaData();
            int ns = labelIndex(m, "TABLE_SCHEM");
            int nc = labelIndex(m, "TABLE_CAT");
            int nn = labelIndex(m, "TABLE_NAME");
            int nt = labelIndex(m, "TABLE_TYPE");
            int nr = labelIndex(m, "REMARKS");
            while (rs.next()) {
                tScan++;
                String name = nn > 0 ? rs.getString(nn) : null;
                String remarks = nr > 0 ? rs.getString(nr) : null;
                if (!has(name, needle) && !has(remarks, needle)) {
                    continue;
                }
                if (tHits >= maxHits) {
                    cut = true;
                    break;
                }
                if (tHits++ > 0) {
                    tb.append(",");
                }
                String owner = ns > 0 ? rs.getString(ns) : null;
                if (owner == null && nc > 0) {
                    owner = rs.getString(nc);
                }
                tb.append("[").append(json(owner)).append(",").append(json(name)).append(",")
                        .append(json(nt > 0 ? rs.getString(nt) : null)).append(",").append(json(remarks)).append("]");
            }
            closeQuietly(rs);
            rs = null;

            if (!tablesOnly) {
                rs = md.getColumns(catArg, schArg, "%", "%");
                m = rs.getMetaData();
                ns = labelIndex(m, "TABLE_SCHEM");
                nc = labelIndex(m, "TABLE_CAT");
                nn = labelIndex(m, "TABLE_NAME");
                int cn = labelIndex(m, "COLUMN_NAME");
                int ct = labelIndex(m, "TYPE_NAME");
                int cs = labelIndex(m, "COLUMN_SIZE");
                nr = labelIndex(m, "REMARKS");
                while (rs.next()) {
                    cScan++;
                    if (cScan > maxScan || ((cScan & 1023) == 0 && System.currentTimeMillis() - t0 > budget)) {
                        cut = true;
                        break;
                    }
                    String col = cn > 0 ? rs.getString(cn) : null;
                    String remarks = nr > 0 ? rs.getString(nr) : null;
                    if (!has(col, needle) && !has(remarks, needle)) {
                        continue;
                    }
                    if (cHits >= maxHits) {
                        cut = true;
                        break;
                    }
                    if (cHits++ > 0) {
                        cl.append(",");
                    }
                    String owner = ns > 0 ? rs.getString(ns) : null;
                    if (owner == null && nc > 0) {
                        owner = rs.getString(nc);
                    }
                    cl.append("[").append(json(owner)).append(",").append(json(nn > 0 ? rs.getString(nn) : null)).append(",")
                            .append(json(col)).append(",").append(json(ct > 0 ? rs.getString(ct) : null)).append(",")
                            .append(json(cs > 0 ? rs.getString(cs) : null)).append(",").append(json(remarks)).append("]");
                }
            }
        } finally {
            closeQuietly(rs);
            rollbackQuietly(conn);
        }
        StringBuilder sb = new StringBuilder();
        sb.append("{\"ok\":true,\"mode\":\"find\",\"keyword\":").append(json(kw.trim()));
        kv(sb, "scope", catArg != null && schArg != null ? catArg + "." + schArg : (schArg != null ? schArg : catArg));
        sb.append(",\"tables\":[").append(tb).append("]");
        sb.append(",\"columns\":[").append(cl).append("]");
        sb.append(",\"tables_scanned\":").append(tScan);
        sb.append(",\"columns_scanned\":").append(cScan);
        sb.append(",\"truncated\":").append(cut);
        sb.append(",\"elapsed_ms\":").append(System.currentTimeMillis() - t0).append("}");
        out.println(sb);
    }

    private static boolean has(String s, String needleLower) {
        return s != null && s.toLowerCase(Locale.ROOT).indexOf(needleLower) >= 0;
    }

    /**
     * 写操作，一次调用做完：核对影响行数 → 改前快照 → 执行 → 提交 → 顺手把主键查出来（生成反向 SQL 要用）。
     *
     * <p>核对行数在事务里做：确认的时候说的是 N 行，真要执行时已经不是 N 行了（别人改过、条件变了），
     * 就不执行，回滚，把现在的行数报上去，让人重新看一遍。
     */
    private void doApply(Connection conn, Map<String, String> opt, List<String[]> segs) throws SQLException {
        String writeSql = seg(segs, "write");
        if (empty(writeSql)) {
            fail("BAD_ARGS", "标准输入里没有要执行的 SQL（write 那一段）", null);
            return;
        }
        String countSql = seg(segs, "count");
        String beforeSql = seg(segs, "before");
        long expect = longOpt(opt, "expect-count", -1);
        long t0 = System.currentTimeMillis();
        StringBuilder sb = new StringBuilder();
        sb.append("{\"ok\":true,\"mode\":\"apply\"");
        try {
            if (!empty(countSql)) {
                long n = -1;
                Statement st = conn.createStatement();
                ResultSet rs = null;
                try {
                    applyTimeout(st, opt);
                    rs = st.executeQuery(countSql);
                    if (rs.next()) {
                        n = rs.getLong(1);
                    }
                } finally {
                    closeQuietly(rs);
                    closeQuietly(st);
                }
                if (expect >= 0 && n != expect) {
                    rollbackQuietly(conn);
                    out.println("{\"ok\":false,\"code\":\"COUNT_CHANGED\",\"count\":" + n + ",\"expected\":" + expect
                            + ",\"error\":" + json("确认的时候是 " + expect + " 行，现在是 " + n + " 行。没有执行。") + "}");
                    return;
                }
                sb.append(",\"count\":").append(n);
            }
            snapshot(conn, opt, beforeSql, writeSql, sb);
            int affected = update(conn, opt, writeSql);
            // 提交之前再对一遍实际动了多少行。数的时候是 N 行、真动的时候多了
            // （数完之后别人插进来一行符合条件的）：多出来的那一行不在快照里，还原不了，不能提交。
            // 少了不拦：有的驱动只算"值真的变了"的行（MySQL 的 useAffectedRows）。
            if (expect >= 0 && !empty(countSql) && affected > expect) {
                rollbackQuietly(conn);
                out.println("{\"ok\":false,\"code\":\"AFFECTED_MORE\",\"affected\":" + affected + ",\"expected\":" + expect
                        + ",\"error\":" + json("确认的是 " + expect + " 行，真执行的时候动了 " + affected + " 行。已经回滚。") + "}");
                return;
            }
            long maxAffected = longOpt(opt, "max-affected", -1);
            if (maxAffected >= 0 && affected >= maxAffected) {
                rollbackQuietly(conn);
                out.println("{\"ok\":false,\"code\":\"OVER_LIMIT\",\"affected\":" + affected + ",\"limit\":" + maxAffected
                        + ",\"error\":" + json("动了 " + affected + " 行，到了硬上限 " + maxAffected + "。已经回滚。") + "}");
                return;
            }
            sb.append(",\"affected_rows\":").append(affected);
            conn.commit();
            sb.append(",\"committed\":true");
        } catch (SQLException e) {
            rollbackQuietly(conn);
            fail("SQL_ERROR", e.getMessage(), e);
            return;
        } catch (IOException e) {
            rollbackQuietly(conn);
            fail("IO_ERROR", "快照写不出去：" + e.getMessage(), null);
            return;
        } catch (Throwable t) {
            rollbackQuietly(conn);
            fail("RUNNER_ERROR", String.valueOf(t.getMessage()), null);
            return;
        }
        // 已经提交了。下面查主键出了错不能算这次写操作失败
        String pkTable = opt.get("pk-table");
        if (!empty(pkTable)) {
            try {
                DatabaseMetaData md = conn.getMetaData();
                Scope scope = Scope.of(opt);
                Found f = resolve(conn, md, scope, pkTable, DEFAULT_MAX_CELL);
                if (f.table != null) {
                    sb.append(",\"primary_keys\":").append(jsonList(primaryKeys(md, scope, f)));
                    kv(sb, "pk_table", f.table);
                }
            } catch (Throwable t) {
                kv(sb, "pk_error", String.valueOf(t.getMessage()));
            } finally {
                rollbackQuietly(conn);
            }
        }
        sb.append(",\"elapsed_ms\":").append(System.currentTimeMillis() - t0).append("}");
        out.println(sb);
    }

    /**
     * 一个事务里跑几条写语句（照 undo.sql 还原用）：每一段 stmt 是一条。
     * --expect-each N：每一条都得正好动 N 行。有一条不是、有一条出错，就全部回滚，一条都不留。
     */
    private void doBatch(Connection conn, Map<String, String> opt, List<String[]> segs) throws SQLException {
        List<String> sqls = new ArrayList<String>();
        for (String[] s : segs) {
            if ("stmt".equals(s[0]) && !empty(s[1])) {
                sqls.add(s[1]);
            }
        }
        if (sqls.isEmpty()) {
            fail("BAD_ARGS", "标准输入里没有要执行的 SQL（stmt 那几段）", null);
            return;
        }
        long expectEach = longOpt(opt, "expect-each", -1);
        long t0 = System.currentTimeMillis();
        long total = 0;
        int i = 0;
        try {
            for (String sql : sqls) {
                i++;
                int n = update(conn, opt, sql);
                if (expectEach >= 0 && n != expectEach) {
                    rollbackQuietly(conn);
                    out.println("{\"ok\":false,\"code\":\"EACH_MISMATCH\",\"index\":" + i + ",\"affected\":" + n
                            + ",\"expected\":" + expectEach
                            + ",\"error\":" + json("第 " + i + " 条动了 " + n + " 行，应该是 " + expectEach + " 行。全部回滚了。") + "}");
                    return;
                }
                total += n;
            }
            conn.commit();
        } catch (SQLException e) {
            rollbackQuietly(conn);
            fail("SQL_ERROR", "第 " + i + " 条：" + e.getMessage(), e);
            return;
        } catch (Throwable t) {
            rollbackQuietly(conn);
            fail("RUNNER_ERROR", String.valueOf(t.getMessage()), null);
            return;
        }
        out.println("{\"ok\":true,\"mode\":\"batch\",\"statements\":" + sqls.size() + ",\"affected_rows\":" + total
                + ",\"committed\":true,\"elapsed_ms\":" + (System.currentTimeMillis() - t0) + "}");
    }

    // ==================================================================== 后台执行器

    /** 留着的连接：同一个地址、同一个账号、同一个口令用同一条。 */
    private static final Map<String, Connection> POOL = new LinkedHashMap<String, Connection>();
    private static volatile long lastUsed = System.currentTimeMillis();

    /**
     * 后台执行器：只听本机（127.0.0.1），端口由系统分配，连同一个随机的口令牌写进 --state-file。
     * 每个请求一条连接：
     * <pre>
     *   HELLO 随机数            （可以没有。有的话这边先回一行 "HI 回答"，那头核对过再往下发）
     *   TOKEN 口令牌
     *   ARG 名字 值            （可以有很多行；值到行尾为止）
     *   PASSWORD 数据库口令     （可以没有）
     *   INPUT                   （后面到 END 之前都是原来走标准输入的内容）
     *   ...
     *   --@@DBCRUD-END@@
     * </pre>
     * 回一行 JSON，然后关掉这条连接。--idle-seconds 这么久没有请求就自己退出。
     */
    private static void serve(Map<String, String> opt, PrintStream stdout) {
        final long idleMs = Math.max(30, intOpt(opt, "idle-seconds", 300)) * 1000L;
        String stateFile = opt.get("state-file");
        if (empty(stateFile)) {
            failTo(stdout, "BAD_ARGS", "缺少 --state-file", null);
            return;
        }
        ServerSocket server = null;
        try {
            server = new ServerSocket(0, 16, InetAddress.getByName("127.0.0.1"));
            server.setSoTimeout(5000);
            byte[] rnd = new byte[24];
            new SecureRandom().nextBytes(rnd);
            StringBuilder tok = new StringBuilder();
            for (byte b : rnd) {
                tok.append(String.format("%02x", b & 0xff));
            }
            String token = tok.toString();
            lastToken = token;
            // hello：这个执行器认得握手（见 handle）。那头看到它，就先握手、后交口令
            writeFileUtf8(stateFile, "{\"port\":" + server.getLocalPort() + ",\"token\":" + json(token)
                    + ",\"pid\":" + pid() + ",\"started\":" + System.currentTimeMillis() + ",\"hello\":1}");
            stdout.println("{\"ok\":true,\"mode\":\"serve\",\"port\":" + server.getLocalPort() + "}");
            for (;;) {
                // 状态文件没了（被停掉了）、已经是别的执行器的了（那头另起了一个）、或者太久没人用：退出
                if (!ownsState(stateFile, token) || System.currentTimeMillis() - lastUsed > idleMs) {
                    break;
                }
                Socket s;
                try {
                    s = server.accept();
                } catch (SocketTimeoutException e) {
                    continue;
                }
                try {
                    if (!handle(s, token)) {
                        break;
                    }
                } catch (Throwable t) {
                    // 一个请求出错不能把执行器带倒
                } finally {
                    try {
                        s.close();
                    } catch (IOException ignore) {
                        // 关不上不管
                    }
                }
            }
        } catch (Throwable t) {
            failTo(stdout, "RUNNER_ERROR", "后台执行器没起来：" + t.getMessage(), null);
        } finally {
            for (Connection c : POOL.values()) {
                rollbackQuietly(c);
                closeQuietly(c);
            }
            POOL.clear();
            if (server != null) {
                try {
                    server.close();
                } catch (IOException ignore) {
                    // 关不上不管
                }
            }
            try {
                File f = new File(stateFile);
                // 只删自己的：已经是别的执行器的状态文件了，删了它那一个就没人找得到了
                if (f.isFile() && ownsState(stateFile, server == null ? null : lastToken)) {
                    f.delete();
                }
            } catch (Throwable ignore) {
                // 删不掉不管：下次启动会发现端口连不上、重新起
            }
        }
    }

    private static volatile String lastToken;

    /** 状态文件还在，而且里面记的口令牌是自己的。 */
    private static boolean ownsState(String stateFile, String token) {
        if (token == null) {
            return false;
        }
        try {
            File f = new File(stateFile);
            if (!f.isFile() || f.length() > 4096) {
                return false;
            }
            java.io.FileInputStream in = new java.io.FileInputStream(f);
            try {
                return readAllUtf8(in).indexOf("\"token\":" + json(token)) >= 0;
            } finally {
                in.close();
            }
        } catch (Throwable t) {
            return false;
        }
    }

    private static String pid() {
        try {
            String name = java.lang.management.ManagementFactory.getRuntimeMXBean().getName();
            int at = name.indexOf('@');
            return at > 0 ? name.substring(0, at) : "0";
        } catch (Throwable t) {
            return "0";
        }
    }

    /** 处理一个请求。返回 false 表示要退出（收到了 stop）。 */
    private static boolean handle(Socket s, String token) throws IOException {
        s.setSoTimeout(15000);
        BufferedReader in = new BufferedReader(new InputStreamReader(s.getInputStream(), UTF8));
        PrintStream reply = new PrintStream(s.getOutputStream(), true, "UTF-8");
        List<String> args = new ArrayList<String>();
        String password = null;
        String given = null;
        StringBuilder input = null;
        boolean ended = false;
        String line;
        while ((line = in.readLine()) != null) {
            if (input != null) {
                if (line.equals(END)) {
                    ended = true;
                    break;
                }
                if (input.length() > 0) {
                    input.append("\n");
                }
                input.append(line);
                continue;
            }
            if (line.equals(END)) {
                ended = true;
                break;
            }
            if (line.startsWith("HELLO ")) {
                // 握手：那头发来一个随机数，这边用口令牌算出回答。回答对了，那头才把请求（里面有数据库口令）发过来。
                // 状态文件是残留的、端口被别的程序占了的时候，那个程序答不上来，口令就不会交到它手上
                reply.print("HI " + sha256Hex(token + "\n" + line.substring(6).trim()) + "\n");
                reply.flush();
            } else if (line.startsWith("TOKEN ")) {
                given = line.substring(6).trim();
            } else if (line.startsWith("PASSWORD ")) {
                password = line.substring(9);
            } else if (line.startsWith("ARG ")) {
                String rest = line.substring(4);
                int sp = rest.indexOf(' ');
                args.add("--" + (sp < 0 ? rest : rest.substring(0, sp)));
                args.add(sp < 0 ? "" : rest.substring(sp + 1));
            } else if (line.equals("INPUT")) {
                input = new StringBuilder();
            }
        }
        if (given == null || !constantEquals(given, token)) {
            failTo(reply, "BAD_TOKEN", "口令牌不对", null);
            return true;
        }
        if (!ended) {
            // 那头写到一半断了：收到的可能是半截 SQL。不执行
            failTo(reply, "INCOMPLETE", "请求没有收全（没看到结束标记），什么都没有执行。", null);
            return true;
        }
        lastUsed = System.currentTimeMillis();
        Map<String, String> opt;
        try {
            opt = parseArgs(args.toArray(new String[0]));
        } catch (Exception e) {
            failTo(reply, "BAD_ARGS", e.getMessage(), null);
            return true;
        }
        String mode = opt.get("mode");
        if ("stop".equals(mode)) {
            reply.println("{\"ok\":true,\"mode\":\"stop\"}");
            return false;
        }
        if ("status".equals(mode)) {
            reply.println("{\"ok\":true,\"mode\":\"status\",\"connections\":" + POOL.size() + ",\"pid\":" + pid() + "}");
            return true;
        }
        if (mode == null || "serve".equals(mode)) {
            failTo(reply, "BAD_ARGS", "缺少 --mode", null);
            return true;
        }
        // 这个请求可能要跑很久（大查询）：读完请求之后不再限时
        s.setSoTimeout(0);
        DbRunner r = new DbRunner(reply, input == null ? "" : input.toString(), password);
        String key = String.valueOf(opt.get("url")) + "\n" + opt.get("user") + "\n" + String.valueOf(password).hashCode()
                + "\n" + opt.get("driver-class");
        Connection conn = POOL.get(key);
        boolean fresh = false;
        try {
            if (conn != null && !alive(conn)) {
                closeQuietly(conn);
                POOL.remove(key);
                conn = null;
            }
            if (conn == null) {
                conn = r.connect(opt);
                POOL.put(key, conn);
                fresh = true;
            }
            r.run(mode, conn, opt);
        } catch (IllegalArgumentException e) {
            r.fail("BAD_ARGS", e.getMessage(), null);
        } catch (SQLException e) {
            // 留着的连接断了（库重启、网络闪断）才会在这里出错：扔掉，下次重新连
            if (!fresh) {
                closeQuietly(conn);
                POOL.remove(key);
            }
            r.fail("SQL_ERROR", e.getMessage(), e);
        } catch (Throwable t) {
            r.fail("RUNNER_ERROR", String.valueOf(t.getMessage()), null);
        } finally {
            if (conn != null) {
                rollbackQuietly(conn);
                try {
                    conn.setReadOnly(false);
                } catch (Throwable ignore) {
                    // 个别驱动不支持
                }
            }
            lastUsed = System.currentTimeMillis();
        }
        return true;
    }

    private static boolean alive(Connection c) {
        try {
            return !c.isClosed() && c.isValid(3);
        } catch (Throwable t) {
            return false;
        }
    }

    private static String sha256Hex(String s) {
        try {
            byte[] d = java.security.MessageDigest.getInstance("SHA-256").digest(s.getBytes(UTF8));
            StringBuilder sb = new StringBuilder();
            for (byte b : d) {
                sb.append(String.format("%02x", b & 0xff));
            }
            return sb.toString();
        } catch (Exception e) {
            return "";
        }
    }

    /** 比口令牌：不管对不对都比完，不因为前几个字符对不上就提前返回。 */
    private static boolean constantEquals(String a, String b) {
        byte[] x = a.getBytes(UTF8);
        byte[] y = b.getBytes(UTF8);
        int diff = x.length ^ y.length;
        for (int i = 0; i < x.length && i < y.length; i++) {
            diff |= x[i] ^ y[i];
        }
        return diff == 0;
    }

    // ==================================================================== 结果集

    private static int appendResultSet(StringBuilder sb, ResultSet rs, int maxRows, int maxCell) throws SQLException {
        return appendResultSet(sb, rs, maxRows, maxCell, null);
    }

    /** 取一行的时候顺手记下的：有没有内容被截、有没有二进制。 */
    private static final class RowFlags {
        boolean truncatedCell;
        boolean binary;
    }

    /**
     * 把结果集序列化进 JSON，返回实际取到的行数。
     *
     * <p>所有值都输出成字符串或 null，另外单给一份列类型。
     * 这样不会丢精度（BigDecimal 不会被 JSON 的浮点数吃掉），
     * 也能区分 NULL 和空串 —— 后者正是还原数据时最容易出错的地方。
     *
     * <p>more 给了：more[0] 记下"取到 maxRows 行之后后面还有没有"。
     */
    private static int appendResultSet(StringBuilder sb, ResultSet rs, int maxRows, int maxCell, boolean[] more)
            throws SQLException {
        ResultSetMetaData md = rs.getMetaData();
        int cols = md.getColumnCount();
        appendHeader(sb, md);
        int n = 0;
        boolean truncatedRows = false;
        RowFlags flags = new RowFlags();
        while (rs.next()) {
            if (n >= maxRows) {
                truncatedRows = true;
                break;
            }
            if (n > 0) {
                sb.append(",");
            }
            appendRow(sb, rs, md, cols, maxCell, flags);
            n++;
        }
        appendTail(sb, n, truncatedRows, flags, maxCell);
        if (more != null && more.length > 0) {
            more[0] = truncatedRows;
        }
        return n;
    }

    /** 结果集的开头：列的名字和类型，接着是 "rows":[ */
    private static void appendHeader(StringBuilder sb, ResultSetMetaData md) throws SQLException {
        int cols = md.getColumnCount();
        sb.append("\"columns\":[");
        for (int i = 1; i <= cols; i++) {
            if (i > 1) {
                sb.append(",");
            }
            sb.append("{\"name\":").append(json(md.getColumnLabel(i)));
            sb.append(",\"type\":").append(json(md.getColumnTypeName(i)));
            sb.append(",\"jdbc_type\":").append(md.getColumnType(i));
            sb.append("}");
        }
        sb.append("],\"rows\":[");
    }

    /** 当前这一行。各列按顺序取（有的驱动的大字段列只能按顺序取一次）。 */
    private static void appendRow(StringBuilder sb, ResultSet rs, ResultSetMetaData md, int cols, int maxCell,
                                  RowFlags flags) throws SQLException {
        sb.append("[");
        for (int i = 1; i <= cols; i++) {
            if (i > 1) {
                sb.append(",");
            }
            int jdbcType = md.getColumnType(i);
            if (isBinary(jdbcType)) {
                // 二进制原样搬不进 JSON。标出来，让上层知道这行还原不了。
                Object raw = rs.getObject(i);
                if (rs.wasNull() || raw == null) {
                    sb.append("null");
                } else {
                    flags.binary = true;
                    sb.append(json("<binary:" + md.getColumnTypeName(i) + ">"));
                }
                continue;
            }
            String v = rs.getString(i);
            if (rs.wasNull() || v == null) {
                sb.append("null");
            } else if (v.length() > maxCell) {
                flags.truncatedCell = true;
                sb.append(json(v.substring(0, maxCell) + "…<已截断，原长 " + v.length() + ">"));
            } else {
                sb.append(json(v));
            }
        }
        sb.append("]");
    }

    /** 结果集的结尾：行数，取全了没有，有没有内容被截。 */
    private static void appendTail(StringBuilder sb, int rows, boolean truncatedRows, RowFlags flags, int maxCell) {
        sb.append("],\"row_count\":").append(rows);
        sb.append(",\"truncated_rows\":").append(truncatedRows);
        sb.append(",\"truncated_cell\":").append(flags.truncatedCell);
        if (flags.truncatedCell) {
            sb.append(",\"max_cell\":").append(maxCell);
        }
        sb.append(",\"has_binary\":").append(flags.binary);
    }

    private static boolean isBinary(int jdbcType) {
        return jdbcType == Types.BINARY || jdbcType == Types.VARBINARY
                || jdbcType == Types.LONGVARBINARY || jdbcType == Types.BLOB;
    }

    /** 按列标签找下标（从 1 开始），大小写不敏感：金仓这类 PG 系的驱动返回的是小写。找不到返回 0。 */
    private static int labelIndex(ResultSetMetaData md, String label) throws SQLException {
        for (int i = 1; i <= md.getColumnCount(); i++) {
            if (label.equalsIgnoreCase(md.getColumnLabel(i))) {
                return i;
            }
        }
        return 0;
    }

    // ==================================================================== 小工具

    private static void applyTimeout(Statement st, Map<String, String> opt) {
        int qt = intOpt(opt, "query-timeout", 60);
        if (qt > 0) {
            try {
                st.setQueryTimeout(qt);
            } catch (Throwable ignore) {
                // 个别国产驱动不实现这个方法；外层还有 Python 的超时兜底
            }
        }
    }

    /** 告诉驱动这次只读。只是个提示，有的驱动不认；真正保证不落库的是最后的回滚。 */
    private static void readOnlyHint(Connection c) {
        try {
            c.setReadOnly(true);
        } catch (Throwable ignore) {
            // 个别驱动不支持
        }
    }

    private static void rollbackQuietly(Connection c) {
        if (c == null) {
            return;
        }
        try {
            c.rollback();
        } catch (Throwable ignore) {
            // 回滚都失败了就只能让连接断开，由数据库那边处理未提交事务
        }
    }

    private static void closeQuietly(AutoCloseable c) {
        if (c != null) {
            try {
                c.close();
            } catch (Throwable ignore) {
                // 关不上不影响已经拿到的结果
            }
        }
    }

    private static void writeFileUtf8(String path, String content) throws IOException {
        Writer w = new OutputStreamWriter(new FileOutputStream(path), UTF8);
        try {
            w.write(content);
        } finally {
            w.close();
        }
    }

    /** 按分隔行切成若干段（老的几种模式）。 */
    private List<String> readSegments() {
        List<String> segs = new ArrayList<String>();
        StringBuilder cur = new StringBuilder();
        String[] lines = input.split("\r?\n", -1);
        for (int i = 0; i < lines.length; i++) {
            if (lines[i].trim().equals(SEP)) {
                segs.add(cur.toString());
                cur.setLength(0);
            } else {
                if (cur.length() > 0) {
                    cur.append("\n");
                }
                cur.append(lines[i]);
            }
        }
        segs.add(cur.toString());
        return segs;
    }

    private String firstSegment() {
        List<String> segs = readSegments();
        return segs.isEmpty() ? "" : segs.get(0);
    }

    /** 带标签的段：一行"分隔标记 空格 标签"开头，到下一个分隔行之前都是它的内容。返回 [标签, 内容] 的列表。 */
    private List<String[]> readLabeled() {
        List<String[]> segs = new ArrayList<String[]>();
        String label = null;
        StringBuilder cur = new StringBuilder();
        String[] lines = input.split("\r?\n", -1);
        for (int i = 0; i < lines.length; i++) {
            String t = lines[i].trim();
            if (t.startsWith(SEP)) {
                if (label != null) {
                    segs.add(new String[]{label, cur.toString()});
                }
                label = t.substring(SEP.length()).trim();
                cur.setLength(0);
            } else if (label != null) {
                if (cur.length() > 0) {
                    cur.append("\n");
                }
                cur.append(lines[i]);
            }
        }
        if (label != null) {
            segs.add(new String[]{label, cur.toString()});
        }
        return segs;
    }

    private static String seg(List<String[]> segs, String label) {
        for (String[] s : segs) {
            if (s[0].equals(label)) {
                return s[1];
            }
        }
        return null;
    }

    private static String readAllUtf8(InputStream in) {
        try {
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            byte[] chunk = new byte[8192];
            int n;
            while ((n = in.read(chunk)) > 0) {
                buf.write(chunk, 0, n);
            }
            return new String(buf.toByteArray(), UTF8);
        } catch (IOException e) {
            return "";
        }
    }

    private static Map<String, String> parseArgs(String[] args) {
        Map<String, String> m = new HashMap<String, String>();
        for (int i = 0; i < args.length; i++) {
            String a = args[i];
            if (!a.startsWith("--")) {
                throw new IllegalArgumentException("不认识的参数：" + a);
            }
            String key = a.substring(2);
            String val;
            int eq = key.indexOf('=');
            if (eq >= 0) {
                val = key.substring(eq + 1);
                key = key.substring(0, eq);
            } else {
                if (i + 1 >= args.length) {
                    throw new IllegalArgumentException("参数 --" + key + " 后面没有值");
                }
                val = args[++i];
            }
            if ("prop".equals(key) && m.containsKey("prop")) {
                m.put("prop", m.get("prop") + "\u0001" + val);   // --prop 可以重复
            } else {
                m.put(key, val);
            }
        }
        return m;
    }

    private static boolean empty(String s) {
        return s == null || s.trim().length() == 0;
    }

    private static String stripQuotes(String s) {
        String t = s.trim();
        if (t.length() >= 2) {
            char a = t.charAt(0);
            char b = t.charAt(t.length() - 1);
            if ((a == '"' && b == '"') || (a == '`' && b == '`') || (a == '[' && b == ']')) {
                return t.substring(1, t.length() - 1);
            }
        }
        return t;
    }

    private static String required(Map<String, String> opt, String key) {
        String v = opt.get(key);
        if (v == null || v.length() == 0) {
            throw new IllegalArgumentException("缺少 --" + key);
        }
        return v;
    }

    private static String requireTable(String table) {
        if (table == null || table.length() == 0) {
            throw new IllegalArgumentException("这个 --meta 需要 --table");
        }
        return table;
    }

    private static int parseIntOr(String v, int def) {
        if (v == null) {
            return def;
        }
        try {
            return Integer.parseInt(v.trim());
        } catch (NumberFormatException e) {
            return def;
        }
    }

    private static int intOpt(Map<String, String> opt, String key, int def) {
        String v = opt.get(key);
        if (v == null || v.length() == 0) {
            return def;
        }
        return parseIntOr(v, def);
    }

    private static long longOpt(Map<String, String> opt, String key, long def) {
        String v = opt.get(key);
        if (v == null || v.length() == 0) {
            return def;
        }
        try {
            return Long.parseLong(v.trim());
        } catch (NumberFormatException e) {
            return def;
        }
    }

    private static void kv(StringBuilder sb, String k, String v) {
        sb.append(",").append(json(k)).append(":").append(json(v));
    }

    private static String jsonList(List<String> list) {
        StringBuilder sb = new StringBuilder("[");
        for (int i = 0; i < list.size(); i++) {
            if (i > 0) {
                sb.append(",");
            }
            sb.append(json(list.get(i)));
        }
        return sb.append("]").toString();
    }

    private static String failJson(String code, String message, SQLException e) {
        StringBuilder sb = new StringBuilder();
        sb.append("{\"ok\":false,\"code\":").append(json(code));
        sb.append(",\"error\":").append(json(message == null ? "(无错误信息)" : message));
        if (e != null) {
            if (e.getSQLState() != null) {
                sb.append(",\"sql_state\":").append(json(e.getSQLState()));
            }
            sb.append(",\"vendor_code\":").append(e.getErrorCode());
        }
        sb.append("}");
        return sb.toString();
    }

    /** 失败也输出 JSON：上层只需要解析一种格式，不用去分辨异常栈。退出码统一为 0，上层按 ok 字段判断。 */
    private void fail(String code, String message, SQLException e) {
        out.println(failJson(code, message, e));
    }

    private static void failTo(PrintStream to, String code, String message, SQLException e) {
        to.println(failJson(code, message, e));
    }

    /** 最小的 JSON 字符串转义。够用就行，不引第三方库。 */
    private static String json(String s) {
        if (s == null) {
            return "null";
        }
        StringBuilder sb = new StringBuilder(s.length() + 16);
        sb.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"':
                    sb.append('\\').append('"');
                    break;
                case '\\':
                    sb.append('\\').append('\\');
                    break;
                case '\n':
                    sb.append('\\').append('n');
                    break;
                case '\r':
                    sb.append('\\').append('r');
                    break;
                case '\t':
                    sb.append('\\').append('t');
                    break;
                case '\b':
                    sb.append('\\').append('b');
                    break;
                case '\f':
                    sb.append('\\').append('f');
                    break;
                default:
                    if (c < 0x20) {
                        sb.append(String.format("\\u%04x", (int) c));
                    } else {
                        sb.append(c);
                    }
            }
        }
        sb.append('"');
        return sb.toString();
    }
}
