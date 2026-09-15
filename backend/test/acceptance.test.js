'use strict';
/*
 * Automated ACCEPTANCE test for the unified regression command (test/run.sh).
 *
 * It launches test/run.sh as a REAL child subprocess (child_process.spawnSync)
 * connected to the REAL persistent InnoDB test database. It never edits a shipped
 * assertion or skips a suite to go green: failure scenarios point run.sh at a
 * deliberately failing COPY of a real suite (CONCURRENCY_SUITE / E2E_SUITE env
 * overrides), executed against the same real database and real row locks.
 *
 * Scenarios:
 *   0. Isolation probe asserted on BOTH variable names (the present name returns
 *      REPEATABLE-READ; the name the server lacks throws Unknown system variable,
 *      i.e. the exact error the version-aware SHOW VARIABLES probe avoids).
 *   1. Happy path: TEST_RUNS=N runs both suites every round, leaves no open
 *      transaction, exits 0.
 *   2. Connectivity check fails: later checks still run, overall exit non-zero.
 *   3. Concurrency check fails (real mutated copy): e2e still runs; failure keeps
 *      stage + DB read-back; exit non-zero.
 *   4. HTTP/e2e check fails (real mutated copy): concurrency still runs; stage +
 *      read-back retained; exit non-zero.
 * Cleanup: drop mutated temp files, reset test data, assert no open transaction
 * and no leftover temp process.
 */
process.env.NODE_ENV = 'test';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const mysql = require('mysql2/promise');
const H = require('./harness');

const ROOT = path.join(__dirname, '..');
const RUN_SH = path.join(__dirname, 'run.sh');
const dbEnv = {
  TEST_DB_HOST: process.env.TEST_DB_HOST || '127.0.0.1',
  TEST_DB_PORT: process.env.TEST_DB_PORT || '3307',
  TEST_DB_USER: process.env.TEST_DB_USER || 'ct',
  TEST_DB_PASSWORD: process.env.TEST_DB_PASSWORD || 'ctpw',
  TEST_DB_NAME: process.env.TEST_DB_NAME || 'carbontrack_test'
};

const tempFiles = [];
let failures = 0;

function check(label, condition, detail) {
  if (condition) {
    console.log('  PASS  ' + label);
  } else {
    failures += 1;
    console.error('  FAIL  ' + label + (detail ? '\n        ' + detail : ''));
  }
}

function runCommand(extraEnv) {
  return spawnSync('bash', [RUN_SH], {
    cwd: ROOT,
    env: { ...process.env, ...dbEnv, SKIP_BUILD: '1', ...extraEnv },
    encoding: 'utf8',
    timeout: 300000
  });
}

function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

function writeMutatedCopy(sourceName, targetName, find, replace) {
  const src = fs.readFileSync(path.join(__dirname, sourceName), 'utf8');
  if (!src.includes(find)) throw new Error(`mutation anchor not found in ${sourceName}`);
  const target = path.join(__dirname, targetName);
  fs.writeFileSync(target, src.replace(find, replace));
  tempFiles.push(target);
  return target;
}

async function probeVariables() {
  const c = await mysql.createConnection({
    host: dbEnv.TEST_DB_HOST, port: Number(dbEnv.TEST_DB_PORT),
    user: dbEnv.TEST_DB_USER, password: dbEnv.TEST_DB_PASSWORD, database: dbEnv.TEST_DB_NAME
  });
  async function showVar(name) {
    const [rows] = await c.query('SHOW VARIABLES WHERE Variable_name = ?', [name]);
    return rows[0] ? rows[0].Value : null;
  }
  const newName = await showVar('transaction_isolation');
  const oldName = await showVar('tx_isolation');

  // Exactly one name is present on any supported server version.
  const presentCount = [newName, oldName].filter((v) => v !== null).length;
  check('probe: exactly one isolation variable name exists', presentCount === 1,
    `transaction_isolation=${newName} tx_isolation=${oldName}`);
  const present = newName !== null ? { name: 'transaction_isolation', value: newName } : { name: 'tx_isolation', value: oldName };
  check('probe: present variable reports REPEATABLE-READ', /REPEATABLE-READ/i.test(present.value),
    `got ${present.value} via ${present.name}`);

  // The ABSENT name must produce the very "Unknown system variable" error that a
  // hardcoded @@<name> probe would hit on the other engine version — asserted for
  // whichever of the two names this server does not expose.
  const absentName = newName !== null ? 'tx_isolation' : 'transaction_isolation';
  let errno = null;
  try {
    await c.query('SELECT @@`' + absentName + '` AS v');
  } catch (e) {
    errno = e.errno;
  }
  check(`probe: absent name @@${absentName} is Unknown system variable (errno 1193)`, errno === 1193,
    `expected 1193, got ${errno}`);

  await c.end();
  return present.name;
}

async function run() {
  console.log('== Acceptance 0: build dist (child runs use SKIP_BUILD=1) ==');
  const build = spawnSync('npm', ['run', 'build'], { cwd: ROOT, encoding: 'utf8' });
  check('backend builds', build.status === 0, build.stderr || build.stdout);

  console.log('== Acceptance 1: isolation probe across both variable names ==');
  const presentVar = await probeVariables();

  console.log('== Acceptance 2: happy path, 2 repeatable rounds ==');
  let r = runCommand({ TEST_RUNS: '2' });
  const happy = r.stdout + r.stderr;
  check('happy path exits 0', r.status === 0, `exit=${r.status}\n` + happy.slice(-1500));
  check('happy path ran concurrency twice', countOccurrences(happy, 'CONCURRENCY REGRESSION PASS') === 2,
    `count=${countOccurrences(happy, 'CONCURRENCY REGRESSION PASS')}`);
  check('happy path ran http/e2e twice', countOccurrences(happy, 'E2E REGRESSION PASS') === 2,
    `count=${countOccurrences(happy, 'E2E REGRESSION PASS')}`);
  check('happy path reports both rounds passed', happy.includes('ALL REGRESSION SUITES PASSED (2 repeatable run(s))'));
  check('probe reported the server-supported variable', happy.includes('isolation REPEATABLE-READ (' + presentVar + ')'),
    'expected probe line naming ' + presentVar);

  // Transaction cleanup read-back after a successful run.
  const h0 = await H.init();
  const openTrx = await h0.dataSource.query('SELECT COUNT(*) c FROM information_schema.innodb_trx');
  check('happy path left no open InnoDB transaction', Number(openTrx[0].c) === 0, `count=${openTrx[0].c}`);
  await H.closeDb();

  console.log('== Acceptance 3: connectivity check fails, later checks still run ==');
  r = runCommand({ TEST_RUNS: '1', TEST_DB_PORT: '3399' }); // 3399 closed -> ECONNREFUSED
  let conn = r.stdout + r.stderr;
  check('connectivity failure exits non-zero', r.status !== 0, `exit=${r.status}`);
  check('connectivity failure message retained', /Cannot reach test DB/i.test(conn), 'missing connectivity error');
  check('concurrency check still attempted after connectivity failure', conn.includes(': concurrency suite'),
    'concurrency suite header missing');
  check('http/e2e check still attempted after connectivity failure', conn.includes(': e2e suite'),
    'e2e suite header missing');
  check('connectivity failure counted in summary', /connectivity_failed=1/.test(conn), 'summary missing');

  console.log('== Acceptance 4: concurrency check fails (real failing copy), e2e still runs ==');
  const badConcurrency = writeMutatedCopy(
    'concurrency.test.js', 'zz-accept-concurrency.test.js',
    "await snapshotCount(period), 0, 'snapshot count read-back (must be 0)'",
    "await snapshotCount(period), 9999, 'snapshot count read-back (must be 0)'"
  );
  r = runCommand({ TEST_RUNS: '1', CONCURRENCY_SUITE: path.relative(ROOT, badConcurrency) });
  let conc = r.stdout + r.stderr;
  check('concurrency failure exits non-zero', r.status !== 0, `exit=${r.status}`);
  check('concurrency suite reported FAIL', conc.includes('CONCURRENCY REGRESSION FAIL'), 'missing FAIL banner');
  check('concurrency failure keeps STAGE', conc.includes('write-first/create/2026-01'), 'stage missing');
  check('concurrency failure keeps DB read-back', conc.includes('snapshot count read-back') && conc.includes('9999'),
    'read-back/expected value missing');
  check('http/e2e check still executed and passed', conc.includes('E2E REGRESSION PASS'), 'e2e did not run/pass');

  console.log('== Acceptance 5: http/e2e check fails (real failing copy), concurrency still runs ==');
  const badE2e = writeMutatedCopy(
    'e2e.test.js', 'zz-accept-e2e.test.js',
    "await H.snapshotCount(period, 2), 3, 'v2 snapshots created read-back'",
    "await H.snapshotCount(period, 2), 9999, 'v2 snapshots created read-back'"
  );
  r = runCommand({ TEST_RUNS: '1', E2E_SUITE: path.relative(ROOT, badE2e) });
  let e2e = r.stdout + r.stderr;
  check('e2e failure exits non-zero', r.status !== 0, `exit=${r.status}`);
  check('e2e suite reported FAIL', e2e.includes('E2E REGRESSION FAIL'), 'missing FAIL banner');
  check('e2e failure keeps STAGE', e2e.includes('reclose/v2-created'), 'stage missing');
  check('e2e failure keeps DB read-back', e2e.includes('v2 snapshots created read-back') && e2e.includes('9999'),
    'read-back/expected value missing');
  check('concurrency check still executed and passed', e2e.includes('CONCURRENCY REGRESSION PASS'), 'concurrency did not run/pass');
}

async function cleanup() {
  // Remove mutated copies.
  for (const file of tempFiles) {
    try { fs.unlinkSync(file); } catch {}
  }
  // Reset test data and read back a clean schema state.
  const h = await H.init();
  await H.resetDb();
  const [[snap], [act], [trx]] = await Promise.all([
    h.dataSource.query('SELECT COUNT(*) c FROM accounting_snapshots'),
    h.dataSource.query('SELECT COUNT(*) c FROM activities'),
    h.dataSource.query('SELECT COUNT(*) c FROM information_schema.innodb_trx')
  ]);
  check('cleanup: no snapshot rows left', Number(snap.c) === 0, `count=${snap.c}`);
  check('cleanup: no activity rows left', Number(act.c) === 0, `count=${act.c}`);
  check('cleanup: no open InnoDB transaction left', Number(trx.c) === 0, `count=${trx.c}`);
  await H.closeDb();

  // No leftover temp acceptance process (mutated copy runner).
  const ps = spawnSync('bash', ['-lc', "pgrep -af 'zz-accept-(concurrency|e2e).test.js' || true"], { encoding: 'utf8' });
  check('cleanup: no leftover acceptance child process', ps.stdout.trim() === '', ps.stdout.trim());
}

(async () => {
  try {
    await run();
  } catch (error) {
    failures += 1;
    console.error('  FAIL  acceptance harness crashed:', error.stack || error.message || error);
  } finally {
    try { await cleanup(); } catch (e) { failures += 1; console.error('  FAIL  cleanup error:', e.message); }
  }
  if (failures) {
    console.error(`\nACCEPTANCE FAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('\nACCEPTANCE PASS: unified command verified (happy + 3 failure modes + both probe names + cleanup)');
  process.exit(0);
})();
