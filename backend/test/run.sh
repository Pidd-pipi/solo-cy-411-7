#!/usr/bin/env bash
# Repeatable carbon-accounting regression runner.
#
# Requirements: a running InnoDB server (MySQL 8 or MariaDB 10.11) with the
# production schema applied, and a compiled backend (npm run build).
#
# Override the target via env vars; defaults point at the throwaway local
# instance the tests were authored against:
#   TEST_DB_HOST TEST_DB_PORT TEST_DB_USER TEST_DB_PASSWORD TEST_DB_NAME
#
# Concurrency tests open genuinely independent pool connections and observe a
# real LOCK WAIT / Updating contender in processlist, so they MUST run against a
# real server (an in-memory fake would not exercise the row-lock ordering).
set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> Building backend (tests load real entities/services from dist/)"
npm run build

echo "==> Checking test database connectivity"
node -e "
const mysql = require('mysql2/promise');
(async () => {
  const c = await mysql.createConnection({
    host: process.env.TEST_DB_HOST || '127.0.0.1',
    port: Number(process.env.TEST_DB_PORT || 3307),
    user: process.env.TEST_DB_USER || 'ct',
    password: process.env.TEST_DB_PASSWORD || 'ctpw',
    database: process.env.TEST_DB_NAME || 'carbontrack_test'
  });
  const [rows] = await c.query(\"SELECT VERSION() v, @@tx_isolation iso\");
  console.log('    connected to', rows[0].v, rows[0].iso);
  await c.end();
})().catch((e) => { console.error('Cannot reach test DB:', e.message); process.exit(1); });
"

RUNS="${TEST_RUNS:-3}"
for ((i=1; i<=RUNS; i++)); do
  echo "==> Iteration $i/$RUNS: concurrency suite"
  node test/concurrency.test.js | grep -vE '^20[0-9]{2}-'
  echo "==> Iteration $i/$RUNS: e2e suite"
  node test/e2e.test.js | grep -vE '^20[0-9]{2}-'
done

echo "==> ALL REGRESSION SUITES PASSED ($RUNS repeatable run(s))"
