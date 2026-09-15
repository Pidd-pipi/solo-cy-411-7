# 碳账期回归测试（可重复运行）

针对“同月结账 vs 活动增删改并发”的可重复回归测试。**必须对真实 InnoDB 服务器运行**
（MySQL 8.0 或 MariaDB 10.11+，默认隔离级别 REPEATABLE-READ），不能使用内存替身、假仓储或
单连接串行化——并发用例通过连接池里**彼此独立的连接**制造，并在数据库侧观测到真正的锁等待。

## 文件

| 文件 | 作用 |
| --- | --- |
| `test/harness.js` | 连接真实数据库、构造真实 TypeORM 实体/Service（非 mock）；重置数据；提供跨连接的锁等待观测与并发门闩 |
| `test/assert.js` | 断言助手：失败信息包含阶段、期望值与数据库回读结果 |
| `test/concurrency.test.js` | 6 个并发场景：create/update/remove × {写入先提交、结账先提交} |
| `test/e2e.test.js` | 启动真实 Nest 应用走 HTTP：正常结账、冻结拒绝、重开实时一致、再结账新版本、重复结账、缺重开原因、越权 403/401、非法月份、筛选/排行 |
| `test/run.sh` | 构建后重复运行两套用例（默认 3 次，`TEST_RUNS` 可调） |

## 准备测试数据库

测试会 `TRUNCATE` 活动/目标/快照等业务表（保留 `users/roles`），**请使用独立的测试库**，
不要指向需要保留数据的库。以 docker compose 中的 MySQL 为例：

```bash
docker compose exec db mysql -uroot -p"$DB_ROOT_PASSWORD" <<'SQL'
CREATE DATABASE IF NOT EXISTS carbontrack_test CHARACTER SET utf8mb4;
CREATE USER IF NOT EXISTS 'carbontrack_test'@'%' IDENTIFIED BY 'carbontrack_test_pwd';
GRANT ALL PRIVILEGES ON carbontrack_test.* TO 'carbontrack_test'@'%';
GRANT PROCESS ON *.* TO 'carbontrack_test'@'%';   -- 观测 information_schema 锁等待需要
FLUSH PRIVILEGES;
SQL

# 应用与生产相同的 schema
docker compose exec -T db mysql -ucarbontrack_test -pcarbontrack_test_pwd carbontrack_test < ../database/init.sql
```

## 运行

```bash
cd backend

# 指向上面的测试库
export TEST_DB_HOST=127.0.0.1
export TEST_DB_PORT=3306
export TEST_DB_USER=carbontrack_test
export TEST_DB_PASSWORD=carbontrack_test_pwd
export TEST_DB_NAME=carbontrack_test

npm run test:accounting            # 构建 + 两套用例，默认重复 3 次
# 或单独运行：
npm run test:accounting:concurrency
npm run test:accounting:e2e
```

不设置环境变量时，默认连接本机 `127.0.0.1:3307` 的 `ct/ctpw@carbontrack_test`。

## 并发是如何被真实制造的

- 生产代码里 `runWithPeriodLocks(periods, fn, gates?)` 的 `gates` 是**可选测试门闩**，默认 `{}`，
  对真实请求完全是空操作；只有测试传入 `afterPeriodLocked`，让持锁事务在“已拿到账期行锁、尚未提交”
  处暂停。
- 两个操作分别从连接池获得**不同的连接**。测试在放开门闩前，用 `information_schema.processlist`
  在两次采样中确认竞争方的 `INSERT IGNORE INTO accounting_periods ...` 一直处于 `Updating`
  （被持锁方的行/间隙锁阻塞）——以此证明发生了真实的跨连接锁竞争，而不是串行执行。
- 随后按两种顺序分别放开门闩，并回读数据库断言。

## 断言点（失败信息带阶段 + 状态码 + 回读结果）

- **写入先提交**：写入成功；结账返回 `409 PERIOD_CLOSE_CONFLICT`；回读该月仍 `open`、
  `accounting_snapshots` 行数为 0；活动改动确实落库（create 多一行 / update 值已变 / remove 行已删）。
- **结账先提交**：结账成功生成 v1；create/update/remove 均返回 `409 PERIOD_CLOSED`；回读该月
  `closed@v1`、每用户恰好一条快照（共 3 条）；活动表无新增、值未被改、行未被删；快照 `total_carbon`
  不含被拒写入；无遗留未提交事务。
- E2E：正常结账、冻结写入 409、重开后 `/result` 与 `/activities/summary`（仪表盘口径）实时一致、
  再结账生成 v2 且 v1 保留、重复结账 `409 PERIOD_ALREADY_CLOSED`、缺重开原因 400、成员访问
  summaries/versions/close 返回 403、匿名 401、非法月份 400。
