#!/usr/bin/env bash
# Repeatable carbon-accounting regression runner.
#
# Requirements: a running InnoDB server (MySQL 8 or MariaDB 10.11) with the
# production schema applied, and a compiled backend (npm run build).
#
# Override the target via env vars; defaults point at the throwaway local
# instance the tests were authored against:
#   TEST_DB_HOST TEST_DB_PORT TEST_DB_USER TEST_DB_PASSWORD TEST_DB_NAME
#   TEST_DB_CONNECT_TIMEOUT (ms)   TEST_RUNS (default 3)
#   SKIP_BUILD=1                    reuse an existing dist/ build
#   CONCURRENCY_SUITE / E2E_SUITE   override suite paths (used by the acceptance
#                                   harness to run a deliberately failing COPY)
#
# Concurrency tests open genuinely independent pool connections and observe a
# real blocked contender in processlist, so they MUST run against a real server
# (an in-memory fake would not exercise the row-lock ordering).
#
# Exit contract: EVERY check always runs (a connectivity or suite failure does
# not short-circuit later checks); the command exits non-zero if ANY stage fails,
# and each failing suite keeps its stage, expected status and DB read-back output.
set -uo pipefail

cd "$(dirname "$0")/.."

if [ "${SKIP_BUILD:-0}" != "1" ]; then
  echo "==> Building backend (tests load real entities/services from dist/)"
  npm run build || { echo "==> BUILD FAILED: cannot run suites"; exit 1; }
fi

CONNECT_TIMEOUT="${TEST_DB_CONNECT_TIMEOUT:-4000}"
connectivity_failed=0

echo "==> Checking test database connectivity"
# Version-aware isolation probe: MySQL 8.x only exposes @@transaction_isolation while
# MariaDB 10.x (and MySQL 5.7) expose @@tx_isolation. Reading the wrong one raises
# "Unknown system variable" before any suite starts, so use SHOW VARIABLES — it never
# errors on a missing name and simply returns whichever variable the server has.
# A probe failure is RECORDED but does not abort: the suites still run afterwards.
node -e "
const mysql = require('mysql2/promise');
(async () => {
  const c = await mysql.createConnection({
    host: process.env.TEST_DB_HOST || '127.0.0.1',
    port: Number(process.env.TEST_DB_PORT || 3307),
    user: process.env.TEST_DB_USER || 'ct',
    password: process.env.TEST_DB_PASSWORD || 'ctpw',
    database: process.env.TEST_DB_NAME || 'carbontrack_test',
    connectTimeout: Number(process.env.TEST_DB_CONNECT_TIMEOUT || 4000)
  });
  const [verRows] = await c.query('SELECT VERSION() AS v');
  const [isoRows] = await c.query(
    \"SHOW VARIABLES WHERE Variable_name IN ('transaction_isolation','tx_isolation')\"
  );
  const iso = (isoRows[0] && isoRows[0].Value) || 'unknown';
  const via = (isoRows[0] && isoRows[0].Variable_name) || 'n/a';
  console.log('    connected to', verRows[0].v, '| isolation', iso, '(' + via + ')');
  if (!/REPEATABLE-READ/i.test(String(iso))) {
    console.warn('    WARNING: isolation is ' + iso + '; the row-lock concurrency suite assumes REPEATABLE-READ');
  }
  await c.end();
})().catch((e) => { console.error('Cannot reach test DB:', e.message); process.exit(1); });
"
if [ "$?" -ne 0 ]; then
  connectivity_failed=1
fi

RUNS="${TEST_RUNS:-3}"
CONCURRENCY_SUITE="${CONCURRENCY_SUITE:-test/concurrency.test.js}"
E2E_SUITE="${E2E_SUITE:-test/e2e.test.js}"
failures=0

# Run EVERY suite on EVERY iteration (do not short-circuit at the first failure),
# but remember any non-zero exit so the command overall fails. Each failing suite
# prints its stage, expected HTTP status and database read-back before we continue.
run_suite() {
  local label="$1"; shift
  echo "==> $label"
  "$@" 2>&1 | grep -vE '^20[0-9]{2}-'
  local code=${PIPESTATUS[0]}
  if [ "$code" -ne 0 ]; then
    echo "    !! $label FAILED with exit code $code"
    failures=$((failures + 1))
  fi
}

for ((i=1; i<=RUNS; i++)); do
  echo "==> Iteration $i/$RUNS"
  run_suite "Iteration $i/$RUNS: concurrency suite" node "$CONCURRENCY_SUITE"
  run_suite "Iteration $i/$RUNS: e2e suite" node "$E2E_SUITE"
done

if [ "$connectivity_failed" -ne 0 ] || [ "$failures" -ne 0 ]; then
  echo "==> REGRESSION FAILURES: connectivity_failed=$connectivity_failed suite_failures=$failures"
  exit 1
fi

echo "==> ALL REGRESSION SUITES PASSED ($RUNS repeatable run(s))"
