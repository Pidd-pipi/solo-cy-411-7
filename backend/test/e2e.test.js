'use strict';
/*
 * End-to-end regression over HTTP: boots the REAL Nest application (real RequireAuth
 * / RoleGuard / ValidationPipe) against the same real InnoDB test database, so
 * status codes and RBAC denials are asserted exactly as a client sees them.
 *
 * Covers:
 *   normal close; frozen-month write rejected (409); reopen -> result agrees
 *   with dashboard (GET /activities/summary) and is immediately live; re-close
 *   generates a NEW version with history retained; duplicate close (409);
 *   missing reopen reason (400); unauthorized cross-role read (403) and
 *   unauthenticated read (401); illegal month format (400).
 */
process.env.NODE_ENV = 'test';
process.env.TYPEORM_SYNC = 'false';
process.env.MYSQL_HOST = process.env.TEST_DB_HOST || '127.0.0.1';
process.env.MYSQL_PORT = process.env.TEST_DB_PORT || '3307';
process.env.DB_USER = process.env.TEST_DB_USER || 'ct';
process.env.DB_PASSWORD = process.env.TEST_DB_PASSWORD || 'ctpw';
process.env.DB_NAME = process.env.TEST_DB_NAME || 'carbontrack_test';

const path = require('path');
const dayjs = require('dayjs');
const { NestFactory } = require('@nestjs/core');
const H = require('./harness');
const { equal, ok } = require('./assert');

let app;
let baseUrl;
let adminToken;
let memberToken;

async function req(token, method, urlPath, body) {
  const res = await fetch(baseUrl + urlPath, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let json = null;
  const text = await res.text();
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json };
}

async function expectConflict(stage, p) {
  const r = await p;
  equal(stage, r.status, 409, 'HTTP status');
  ok(stage, r.body && typeof r.body.code === 'string', `expected error code, got ${JSON.stringify(r.body)}`);
  return r;
}

async function run() {
  const { AppModule } = require(path.join(H_DIST(), 'app.module'));
  app = await NestFactory.create(AppModule, { logger: false });
  const h = await H.init();
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();

  const loginAdmin = await req(null, 'POST', '/users/login', { email: 'demo@carbontrack.local', password: 'password123' });
  const loginMember = await req(null, 'POST', '/users/login', { email: 'river@carbontrack.local', password: 'password123' });
  ok('login', loginAdmin.status >= 200 && loginAdmin.status < 300 && loginAdmin.body.token, `admin login failed: ${loginAdmin.status}`);
  ok('login', loginMember.status >= 200 && loginMember.status < 300 && loginMember.body.token, `member login failed: ${loginMember.status}`);
  adminToken = loginAdmin.body.token;
  memberToken = loginMember.body.token;

  await H.resetDb();
  const log = [];
  const period = '2026-07';

  // Seed one activity for the admin in the target month (uses a seeded factor).
  const created = await req(adminToken, 'POST', '/activities', H.activityInput(period, 5));
  equal('seed/normal-close', created.status, 201, 'create activity HTTP status');
  const seededId = Number(created.body.activity.id);
  const monthStart = `${period}-01`;
  const monthEnd = dayjs(monthStart).endOf('month').format('YYYY-MM-DD');

  // 1. Normal close.
  const closed = await req(adminToken, 'POST', `/accounting/periods/${period}/close`);
  equal('normal-close', closed.status, 201, 'close HTTP status');
  equal('normal-close', closed.body.version, 1, 'first close version');
  equal('normal-close', closed.body.status, 'closed', 'close status');

  // Snapshot read-back: one per seeded user (3), admin total matches the seeded row.
  equal('normal-close', await H.snapshotCount(period, 1), 3, 'snapshot rows read-back');
  const adminSnap = await H.snapshotForUser(period, H.USERS.ADMIN, 1);
  equal('normal-close', adminSnap.activityCount, 1, 'admin snapshot activity_count read-back');

  // 2. Frozen-month create/update/remove rejected with 409.
  const frCreate = await expectConflict('frozen/create', req(adminToken, 'POST', '/activities', H.activityInput(period, 6)));
  ok('frozen/create', String(frCreate.body.code).startsWith('PERIOD_CLOSED'), `code ${frCreate.body.code}`);
  const frUpdate = await expectConflict('frozen/update', req(adminToken, 'PATCH', `/activities/${seededId}`, { amount: 99 }));
  ok('frozen/update', String(frUpdate.body.code).startsWith('PERIOD_CLOSED'), `code ${frUpdate.body.code}`);
  const frRemove = await expectConflict('frozen/remove', req(adminToken, 'DELETE', `/activities/${seededId}`));
  ok('frozen/remove', String(frRemove.body.code).startsWith('PERIOD_CLOSED'), `code ${frRemove.body.code}`);
  equal('frozen/no-activity-change', await H.activityCount(H.USERS.ADMIN, monthStart, monthEnd), 1, 'activity table unchanged read-back');

  // 2b. Closed-month list still routes to the frozen snapshot and category filter works.
  const closedList = await req(adminToken, 'GET', `/activities?start=${monthStart}&end=${monthEnd}`);
  equal('frozen/list-status', closedList.status, 200, 'closed-month list HTTP status');
  equal('frozen/list-count', Array.isArray(closedList.body) ? closedList.body.length : -1, 1, 'closed-month list served from snapshot (1 row)');
  const closedListTransport = await req(adminToken, 'GET', `/activities?start=${monthStart}&end=${monthEnd}&category=transport`);
  equal('frozen/filter-transport', closedListTransport.body.length, 1, 'transport filter keeps the seeded row');
  const closedListEnergy = await req(adminToken, 'GET', `/activities?start=${monthStart}&end=${monthEnd}&category=energy`);
  equal('frozen/filter-energy', closedListEnergy.body.length, 0, 'energy filter excludes the transport row');
  // Unranged Activities-page query still returns the frozen month row (shape identical).
  const unranged = await req(adminToken, 'GET', '/activities');
  equal('frozen/unranged-contains-row', Array.isArray(unranged.body) && unranged.body.some((a) => Number(a.id) === seededId), true, 'unranged list includes frozen row for client pagination/filter');

  // 2c. Region ranking for the closed month reads the same frozen total (0.52 = 10km * 0.052).
  const ranking = await req(adminToken, 'GET', `/ranking?start=${monthStart}&end=${monthEnd}`);
  const adminRankRow = ranking.body.find((item) => item.userId === H.USERS.ADMIN);
  equal('frozen/ranking-status', ranking.status, 200, 'ranking HTTP status');
  equal('frozen/ranking-total', Number(adminRankRow.totalCarbon).toFixed(2), '0.52', 'ranking reads frozen snapshot total');

  // 3. Member self result is the frozen v1 and readable; cross-role endpoints deny.
  const memberResult = await req(memberToken, 'GET', `/accounting/periods/${period}/result`);
  equal('member/self-result', memberResult.status, 200, 'member self result HTTP status');
  equal('member/self-result', memberResult.body.closed, true, 'member result frozen flag');
  equal('member/self-result', memberResult.body.version, 1, 'member result version');
  const memberSummaries = await req(memberToken, 'GET', `/accounting/periods/${period}/summaries`);
  equal('rbac/member-summaries', memberSummaries.status, 403, 'member summaries must be 403');
  const memberVersions = await req(memberToken, 'GET', `/accounting/periods/${period}/versions`);
  equal('rbac/member-versions', memberVersions.status, 403, 'member versions must be 403');
  const memberClose = await req(memberToken, 'POST', `/accounting/periods/${period}/close`);
  equal('rbac/member-close', memberClose.status, 403, 'member close must be 403');
  const anonResult = await req(null, 'GET', `/accounting/periods/${period}/result`);
  equal('rbac/anonymous', anonResult.status, 401, 'anonymous must be 401');

  // 4. Reopen without a reason -> 400.
  const noReason = await req(adminToken, 'PATCH', `/accounting/periods/${period}/reopen`, {});
  equal('reopen/no-reason', noReason.status, 400, 'missing reopen reason HTTP status');
  equal('reopen/no-reason', noReason.body.code, 'PERIOD_REOPEN_REASON_REQUIRED', 'missing reason error code');

  // 5. Reopen with a reason -> open, v1 snapshots retained, result immediately live
  // and equal to the dashboard summary (GET /activities/summary).
  const reopened = await req(adminToken, 'PATCH', `/accounting/periods/${period}/reopen`, { reason: 'backfill commute' });
  equal('reopen/ok', reopened.status, 200, 'reopen HTTP status');
  equal('reopen/ok', reopened.body.status, 'open', 'reopen status');
  const periodRowAfterReopen = await H.getPeriod(period);
  equal('reopen/version-kept', Number(periodRowAfterReopen.currentVersion), 1, 'version retained after reopen read-back');
  equal('reopen/snapshots-kept', await H.snapshotCount(period), 3, 'historical snapshots retained read-back');

  const liveResult = await req(adminToken, 'GET', `/accounting/periods/${period}/result`);
  const dashSummary = await req(adminToken, 'GET', `/activities/summary?start=${monthStart}&end=${monthEnd}`);
  equal('reopen/live-flag', liveResult.body.closed, false, 'reopened result closed flag');
  equal('reopen/result-eq-dashboard', Number(liveResult.body.totalCarbon), Number(dashSummary.body.total), 'result total equals dashboard summary');

  // Add a new activity now the month is live: both result and dashboard move together.
  const added = await req(adminToken, 'POST', '/activities', H.activityInput(period, 7, { amount: 20 }));
  equal('reopen/live-write', added.status, 201, 'write after reopen HTTP status');
  const liveResult2 = await req(adminToken, 'GET', `/accounting/periods/${period}/result`);
  const dashSummary2 = await req(adminToken, 'GET', `/activities/summary?start=${monthStart}&end=${monthEnd}`);
  equal('reopen/result-eq-dashboard-after-write', Number(liveResult2.body.totalCarbon), Number(dashSummary2.body.total), 'result total tracks dashboard after write');
  equal('reopen/live-count', liveResult2.body.activityCount, 2, 'live result activity count');

  // 6. Duplicate close while already closed is impossible here (it is open); close
  // again -> new version 2, history (v1+v2) retained.
  const closed2 = await req(adminToken, 'POST', `/accounting/periods/${period}/close`);
  equal('reclose/status', closed2.status, 201, 're-close HTTP status');
  equal('reclose/version', closed2.body.version, 2, 're-close version');
  equal('reclose/v1-retained', await H.snapshotCount(period, 1), 3, 'v1 snapshots retained read-back');
  equal('reclose/v2-created', await H.snapshotCount(period, 2), 3, 'v2 snapshots created read-back');
  const versions = await req(adminToken, 'GET', `/accounting/periods/${period}/versions`);
  equal('reclose/versions-status', versions.status, 200, 'versions HTTP status');
  equal('reclose/versions-count', versions.body.versions.length, 2, 'two historical versions');
  const v2Admin = await H.snapshotForUser(period, H.USERS.ADMIN, 2);
  equal('reclose/v2-includes-new-write', v2Admin.activityCount, 2, 'v2 snapshot includes the post-reopen write read-back');

  // 7. Duplicate close on the now-closed month -> 409 ALREADY_CLOSED, no new version.
  const dup = await req(adminToken, 'POST', `/accounting/periods/${period}/close`);
  equal('duplicate-close/status', dup.status, 409, 'duplicate close HTTP status');
  equal('duplicate-close/code', dup.body.code, 'PERIOD_ALREADY_CLOSED', 'duplicate close error code');
  equal('duplicate-close/no-new-version', (await H.getPeriod(period)).currentVersion, 2, 'version unchanged read-back');

  // 8. Illegal month format -> 400 (close, and member result).
  const badClose = await req(adminToken, 'POST', '/accounting/periods/2026-13/close');
  equal('invalid-month/close', badClose.status, 400, 'invalid month close HTTP status');
  equal('invalid-month/close-code', badClose.body.code, 'PERIOD_FORMAT_INVALID', 'invalid month error code');
  const badResult = await req(adminToken, 'GET', '/accounting/periods/2026/result');
  equal('invalid-month/result', badResult.status, 400, 'invalid month result HTTP status');

  log.push('normal close + frozen writes 409 + RBAC 403/401 + reopen-live + reclose v2 + validation all verified over HTTP');

  await app.close();
  await H.closeDb();
  return log;
}

function H_DIST() {
  return path.join(__dirname, '..', 'dist');
}

if (require.main === module) {
  run()
    .then((log) => {
      console.log('E2E REGRESSION PASS');
      log.forEach((line) => console.log('  - ' + line));
      process.exit(0);
    })
    .catch(async (error) => {
      console.error('E2E REGRESSION FAIL');
      console.error(error.stack || error.message || error);
      try { if (app) await app.close(); } catch {}
      try { await H.closeDb(); } catch {}
      process.exit(1);
    });
}

module.exports = { run };
