'use strict';
/*
 * Shared bootstrap for the carbon-accounting concurrency regression suite.
 *
 * These tests run against a REAL InnoDB server (MySQL 8 / MariaDB 10.11) with
 * the production TypeORM entities and services. Concurrency is produced with
 * genuinely independent connections (each runWithPeriodLocks call creates its
 * own QueryRunner/pool connection) and an in-transaction synchronization gate;
 * there are no in-memory fakes, fake repositories, or single-connection stubs.
 *
 * Env (defaults match the local throwaway instance used in CI/sandbox):
 *   TEST_DB_HOST TEST_DB_PORT TEST_DB_USER TEST_DB_PASSWORD TEST_DB_NAME
 */
const path = require('path');
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.TYPEORM_SYNC = 'false';

const { DataSource } = require('typeorm');
const dayjs = require('dayjs');

const DIST = path.join(__dirname, '..', 'dist');
const { User } = require(path.join(DIST, 'models/user'));
const { Role } = require(path.join(DIST, 'models/role'));
const { Activity } = require(path.join(DIST, 'models/activity'));
const { Goal } = require(path.join(DIST, 'models/goal'));
const { CarbonFactor } = require(path.join(DIST, 'models/carbonFactor'));
const { AuditLog } = require(path.join(DIST, 'models/auditLog'));
const { AccountingPeriod } = require(path.join(DIST, 'models/accountingPeriod'));
const { AccountingSnapshot } = require(path.join(DIST, 'models/accountingSnapshot'));
const { AccountingService } = require(path.join(DIST, 'services/accountingService'));
const { ActivityService } = require(path.join(DIST, 'services/activityService'));
const { GoalService } = require(path.join(DIST, 'services/goalService'));
const { FactorService } = require(path.join(DIST, 'services/factorService'));
const { RankingService } = require(path.join(DIST, 'services/rankingService'));
const { UserService } = require(path.join(DIST, 'services/userService'));
const { AppError } = require(path.join(DIST, 'utils/AppError'));
const { ActivityCategory } = require(path.join(DIST, 'constants/activity'));

const dbConfig = {
  type: 'mysql',
  host: process.env.TEST_DB_HOST || '127.0.0.1',
  port: Number(process.env.TEST_DB_PORT || 3307),
  username: process.env.TEST_DB_USER || 'ct',
  password: process.env.TEST_DB_PASSWORD || 'ctpw',
  database: process.env.TEST_DB_NAME || 'carbontrack_test',
  entities: [User, Role, Activity, Goal, CarbonFactor, AuditLog, AccountingPeriod, AccountingSnapshot],
  synchronize: false,
  logging: false,
  extra: { connectionLimit: 25 }
};

const dataSource = new DataSource(dbConfig);

let services;
const FACTORS = [
  { category: 'transport', subType: 'metro', factorValue: '0.0520', unit: 'km', region: 'Shanghai' },
  { category: 'energy', subType: 'electricity', factorValue: '0.5300', unit: 'kWh', region: 'Hangzhou' },
  { category: 'transport', subType: 'bus', factorValue: '0.0890', unit: 'km', region: 'Beijing' }
];

async function init() {
  if (!dataSource.isInitialized) await dataSource.initialize();
  if (services) return services;
  const factorService = new FactorService(dataSource.getRepository(CarbonFactor));
  const userService = new UserService(dataSource.getRepository(User), dataSource.getRepository(Role));
  const accountingService = new AccountingService(
    dataSource,
    dataSource.getRepository(AccountingPeriod),
    dataSource.getRepository(AccountingSnapshot),
    dataSource.getRepository(Activity)
  );
  const activityService = new ActivityService(
    dataSource.getRepository(Activity),
    factorService,
    userService,
    accountingService
  );
  const goalService = new GoalService(dataSource.getRepository(Goal), activityService);
  const rankingService = new RankingService(dataSource.getRepository(User), accountingService);
  services = {
    dataSource,
    userService,
    factorService,
    accountingService,
    activityService,
    goalService,
    rankingService
  };
  return services;
}

// Wipe all feature data and restore a known factor set. Users/roles from
// init.sql (id 1 admin/Shanghai, id 2 member/Hangzhou, id 3 member/Beijing)
// are kept.
async function resetDb() {
  await dataSource.query('SET FOREIGN_KEY_CHECKS=0');
  await dataSource.query('TRUNCATE TABLE accounting_snapshots');
  await dataSource.query('DELETE FROM accounting_periods');
  await dataSource.query('TRUNCATE TABLE activities');
  await dataSource.query('TRUNCATE TABLE goals');
  await dataSource.query('TRUNCATE TABLE audit_logs');
  await dataSource.query('DELETE FROM carbon_factors');
  await dataSource.query('SET FOREIGN_KEY_CHECKS=1');
  for (const factor of FACTORS) {
    await dataSource.getRepository(CarbonFactor).save(dataSource.getRepository(CarbonFactor).create(factor));
  }
}

async function closeDb() {
  if (dataSource.isInitialized) await dataSource.destroy();
}

// ---- read-back helpers (independent queries, never the contender's conn) ----
async function getPeriod(period) {
  return dataSource.getRepository(AccountingPeriod).findOne({ where: { period } });
}
async function snapshotCount(period, version) {
  const row = await getPeriod(period);
  if (!row) return 0;
  const where = { periodId: Number(row.id) };
  if (version !== undefined) where.version = version;
  return dataSource.getRepository(AccountingSnapshot).count({ where });
}
async function snapshotForUser(period, userId, version) {
  const row = await getPeriod(period);
  if (!row) return null;
  const v = version !== undefined ? version : Number(row.currentVersion);
  return dataSource.getRepository(AccountingSnapshot).findOne({
    where: { periodId: Number(row.id), userId, version: v }
  });
}
async function activityCount(userId, start, end) {
  return dataSource.getRepository(Activity).count({
    where: { userId, recordDate: require('typeorm').Between(start, end) }
  });
}
async function activitiesForMonth(userId, period) {
  const { Between } = require('typeorm');
  return dataSource.getRepository(Activity).find({
    where: { userId, recordDate: Between(`${period}-01`, dayjs(`${period}-01`).endOf('month').format('YYYY-MM-DD')) }
  });
}
async function activeTransactions() {
  const rows = await dataSource.query('SELECT COUNT(*) AS c FROM information_schema.innodb_trx');
  return Number(rows[0].c);
}

// Block until NO InnoDB transaction remains. This still asserts a clean release
// of every lock/connection: a genuine leak that keeps holding the period lock can
// never reach zero and fails after the hard window. The window only absorbs the
// bounded time a just-settled winner spends in COMMITTING or a loser's server-side
// ROLLBACK undo under heavy CI scheduling — those finish in milliseconds normally.
async function waitForNoTransactions(timeoutMs = 30000) {
  const start = Date.now();
  let n = await activeTransactions();
  let last = n;
  while (n !== 0 && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 50));
    last = n;
    n = await activeTransactions();
  }
  if (n !== 0 && process.env.TEST_DEBUG_TX) {
    try {
      const rows = await dataSource.query(
        "SELECT trx_state, TIMESTAMPDIFF(SECOND,trx_started,NOW(6)) age, trx_rows_modified modified, LEFT(trx_query,80) q FROM information_schema.innodb_trx"
      );
      console.error('waitForNoTransactions timeout detail:', JSON.stringify(rows));
    } catch {}
  }
  return { remaining: n, last, elapsed: Date.now() - start };
}

// Wait until at least `count` transactions are active (holder + blocked contender).
async function waitForActiveTx(count, timeoutMs = 6000) {
  const start = Date.now();
  let n = 0;
  while (Date.now() - start < timeoutMs) {
    n = await activeTransactions();
    if (n >= count) return n;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error(`expected >=${count} active InnoDB transactions, saw ${n} after ${timeoutMs}ms`);
}

// Wait until the contender is provably blocked on the holder's real row lock.
//
// The contender's FIRST statement is `INSERT IGNORE INTO accounting_periods`;
// on InnoDB it waits on the holder's insert-intention/gap lock. Because that
// statement has not yet acquired/modified anything, MariaDB may not surface it
// in information_schema.innodb_trx yet, so we prove contention via processlist:
// a DIFFERENT connection (not our polling query) whose current statement is the
// INSERT IGNORE and is in an 'Updating' state, observed on the SAME thread id on
// two polls ~150ms apart with a non-decreasing thread Time. That can only happen
// if it is stuck behind the holder's lock — a passing statement would not stay
// in Updating across both samples.
async function waitForContenderBlocked(timeoutMs = 8000) {
  const start = Date.now();
  let seen = null; // { id, time }
  while (Date.now() - start < timeoutMs) {
    const rows = await dataSource.query(
      "SELECT Id AS id, Time AS t, State AS state, Info AS info FROM information_schema.processlist " +
      "WHERE Info LIKE 'INSERT IGNORE INTO accounting_periods%'"
    );
    const blocked = rows
      .filter((r) => r.info && !r.info.includes('information_schema.processlist'))
      .map((r) => ({ id: String(r.id), time: Number(r.t), state: String(r.state || '').toLowerCase() }))
      .filter((r) => r.state.includes('updat'));
    if (blocked.length) {
      const current = blocked[0];
      if (seen && seen.id === current.id) {
        return { threadId: current.id, waitedMs: Date.now() - start };
      }
      seen = current;
      await new Promise((r) => setTimeout(r, 150));
      continue;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`contender never blocked on the holder's row lock after ${timeoutMs}ms`);
}

// Back-compat alias used by some diagnostics.
async function waitForLockWait(timeoutMs = 8000) {
  return waitForContenderBlocked(timeoutMs);
}

// A gate that blocks the holder until release() is invoked. `entered` resolves
// once the gated transaction has reached the gate, i.e. it already holds the
// period row lock — that is the point after which the contender is started.
function blockGate() {
  let release;
  const holdPromise = new Promise((resolve) => { release = resolve; });
  let markEntered;
  const entered = new Promise((resolve) => { markEntered = resolve; });
  return {
    entered,
    wait: async () => { markEntered(); return holdPromise; },
    release: () => release()
  };
}

function appErrorProps(error) {
  return {
    name: error && error.name,
    code: error && error.code,
    status: error && error.status,
    message: error && error.message
  };
}

// Build an activity input for a given month/day.
function activityInput(period, day, overrides = {}) {
  return {
    category: ActivityCategory.TRANSPORT,
    subType: 'metro',
    amount: 10,
    unit: 'km',
    recordDate: `${period}-${String(day).padStart(2, '0')}`,
    note: 'regression',
    ...overrides
  };
}

module.exports = {
  init,
  resetDb,
  closeDb,
  getPeriod,
  snapshotCount,
  snapshotForUser,
  activityCount,
  activitiesForMonth,
  activeTransactions,
  waitForNoTransactions,
  waitForActiveTx,
  waitForContenderBlocked,
  waitForLockWait,
  blockGate,
  appErrorProps,
  activityInput,
  AppError,
  ActivityCategory,
  USERS: { ADMIN: 1, MEMBER: 2, OTHER: 3 }
};
