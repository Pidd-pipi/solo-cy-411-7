'use strict';
/*
 * Concurrency regression: same-month CLOSE vs ACTIVITY CREATE/UPDATE/REMOVE.
 *
 * For each operation both orderings are exercised with two genuinely
 * independent connections:
 *   write-first: writer grabs the period row lock and is gated while holding it,
 *                close starts on another connection and blocks in LOCK WAIT,
 *                then the writer commits and close must be REJECTED (409) with no
 *                snapshot created; the writer's change must be persisted.
 *   close-first: close grabs the lock and is gated while holding it, the write
 *                starts on another connection and blocks in LOCK WAIT, close
 *                commits, and the write must be REJECTED (409); the activity
 *                table must be unchanged and no extra snapshot produced.
 *
 * Every failure assertion names the stage, the expected status/code and the
 * database read-back result.
 */
const dayjs = require('dayjs');
const { Between } = require('typeorm');
const {
  init, resetDb, closeDb, getPeriod, snapshotCount, activitiesForMonth,
  activeTransactions, waitForLockWait, blockGate, appErrorProps,
  activityInput, ActivityCategory, USERS
} = require('./harness');
const { equal, ok } = require('./assert');

const STAGE_LABEL = { create: 'Activity create', update: 'Activity update', remove: 'Activity remove' };

async function monthActivities(h, period, userId) {
  return h.dataSource.getRepository(require('../dist/models/activity').Activity).find({
    where: { userId, recordDate: Between(`${period}-01`, dayjs(`${period}-01`).endOf('month').format('YYYY-MM-DD')) },
    order: { id: 'ASC' }
  });
}

async function noOpenTransactions(stage) {
  // Allow the loser transaction's rollback to become visible; still fail on a
  // genuine lock/connection leak that outlasts the grace window.
  const deadline = Date.now() + 3000;
  let n = await activeTransactions();
  while (n !== 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 40));
    n = await activeTransactions();
  }
  equal(stage, n, 0, 'leftover open InnoDB transactions (locks not released)');
}

async function runWriteFirstCreate(h, ctx, period) {
  const stage = `write-first/create/${period}`;
  const before = await monthActivities(h, period, USERS.ADMIN);
  const writerGate = blockGate();
  const writePromise = h.activityService.create(
    USERS.ADMIN,
    activityInput(period, 10, { category: ActivityCategory.TRANSPORT, subType: 'metro' }),
    { afterPeriodLocked: () => writerGate.wait() }
  );
  await writerGate.entered;
  const closePromise = h.accountingService.close(period, USERS.ADMIN);
  await waitForLockWait();
  writerGate.release();

  const [writeResult, closeErr] = await Promise.all([
    writePromise.then((v) => ({ ok: true, value: v })).catch((e) => ({ ok: false, error: e })),
    closePromise.then((v) => ({ ok: true, value: v })).catch((e) => ({ ok: false, error: e }))
  ]);

  ok(stage, writeResult.ok, `writer should succeed but got: ${appErrorProps(writeResult.error).message}`);
  ok(stage, !closeErr.ok, 'close should be REJECTED when the write commits first');
  equal(stage, closeErr.error.status, 409, 'close conflict HTTP status');
  equal(stage, closeErr.error.code, 'PERIOD_CLOSE_CONFLICT', 'close conflict code');

  // DB read-back: period stays OPEN, no snapshot, new activity is present.
  const row = await getPeriod(period);
  equal(stage, row ? row.status : null, 'open', 'period status read-back');
  equal(stage, await snapshotCount(period), 0, 'snapshot count read-back (must be 0)');
  const after = await monthActivities(h, period, USERS.ADMIN);
  equal(stage, after.length, before.length + 1, 'activity row count read-back (writer committed)');
  await noOpenTransactions(stage);
  ctx.log.push(`${stage}: writer committed, close rejected 409, 0 snapshots`);
}

async function runWriteFirstUpdate(h, ctx, period) {
  const stage = `write-first/update/${period}`;
  const created = await h.activityService.create(USERS.ADMIN, activityInput(period, 11, { amount: 10 }));
  const activityId = Number(created.activity.id);
  const gate = blockGate();
  const updatePromise = h.activityService.update(
    USERS.ADMIN, activityId, { amount: 33 },
    { afterPeriodLocked: () => gate.wait() }
  );
  await gate.entered;
  const closePromise = h.accountingService.close(period, USERS.ADMIN);
  await waitForLockWait();
  gate.release();

  const [upd, closeErr] = await Promise.all([
    updatePromise.then((v) => ({ ok: true, value: v })).catch((e) => ({ ok: false, error: e })),
    closePromise.then((v) => ({ ok: true, value: v })).catch((e) => ({ ok: false, error: e }))
  ]);

  ok(stage, upd.ok, `update should succeed but got: ${appErrorProps(upd.error).message}`);
  ok(stage, !closeErr.ok, 'close should be rejected');
  equal(stage, closeErr.error.status, 409, 'close conflict HTTP status');
  equal(stage, closeErr.error.code, 'PERIOD_CLOSE_CONFLICT', 'close conflict code');

  const row = await getPeriod(period);
  equal(stage, row.status, 'open', 'period status read-back');
  equal(stage, await snapshotCount(period), 0, 'snapshot count read-back');
  const changed = await h.dataSource.getRepository(require('../dist/models/activity').Activity).findOne({ where: { id: activityId } });
  equal(stage, Number(changed.amount), 33, 'updated amount read-back (writer committed)');
  await noOpenTransactions(stage);
  ctx.log.push(`${stage}: update committed, close rejected 409, 0 snapshots`);
}

async function runWriteFirstRemove(h, ctx, period) {
  const stage = `write-first/remove/${period}`;
  const created = await h.activityService.create(USERS.ADMIN, activityInput(period, 12, {}));
  const activityId = Number(created.activity.id);
  const gate = blockGate();
  const removePromise = h.activityService.remove(
    USERS.ADMIN, activityId,
    { afterPeriodLocked: () => gate.wait() }
  );
  await gate.entered;
  const closePromise = h.accountingService.close(period, USERS.ADMIN);
  await waitForLockWait();
  gate.release();

  const [rem, closeErr] = await Promise.all([
    removePromise.then((v) => ({ ok: true, value: v })).catch((e) => ({ ok: false, error: e })),
    closePromise.then((v) => ({ ok: true, value: v })).catch((e) => ({ ok: false, error: e }))
  ]);

  ok(stage, rem.ok, `remove should succeed but got: ${appErrorProps(rem.error).message}`);
  ok(stage, !closeErr.ok, 'close should be rejected');
  equal(stage, closeErr.error.status, 409, 'close conflict HTTP status');
  equal(stage, closeErr.error.code, 'PERIOD_CLOSE_CONFLICT', 'close conflict code');

  const row = await getPeriod(period);
  equal(stage, row.status, 'open', 'period status read-back');
  equal(stage, await snapshotCount(period), 0, 'snapshot count read-back');
  const gone = await h.dataSource.getRepository(require('../dist/models/activity').Activity).findOne({ where: { id: activityId } });
  equal(stage, gone, null, 'deleted row read-back (writer committed removal)');
  await noOpenTransactions(stage);
  ctx.log.push(`${stage}: remove committed, close rejected 409, 0 snapshots`);
}

async function runCloseFirst(h, ctx, op, period) {
  const stage = `close-first/${op}/${period}`;
  // Seed a row in the month so close has a snapshot; update/remove target it.
  const seeded = await h.activityService.create(USERS.ADMIN, activityInput(period, 15, { amount: 10 }));
  const seededId = Number(seeded.activity.id);
  const seededCarbon = seeded.activity.carbonValue;

  const closeGate = blockGate();
  const closePromise = h.accountingService.close(period, USERS.ADMIN, { afterPeriodLocked: () => closeGate.wait() });
  await closeGate.entered;

  let writePromise;
  if (op === 'create') {
    writePromise = h.activityService.create(USERS.ADMIN, activityInput(period, 16, {}));
  } else if (op === 'update') {
    writePromise = h.activityService.update(USERS.ADMIN, seededId, { amount: 77 });
  } else {
    writePromise = h.activityService.remove(USERS.ADMIN, seededId);
  }

  // The write now blocks behind close's lock; then close commits.
  await waitForLockWait();
  closeGate.release();
  const [closeResult, writeErr] = await Promise.all([
    closePromise.then((v) => ({ ok: true, value: v })).catch((e) => ({ ok: false, error: e })),
    writePromise.then((v) => ({ ok: true, value: v })).catch((e) => ({ ok: false, error: e }))
  ]);

  ok(stage, closeResult.ok, `close should succeed but got: ${appErrorProps(closeResult.error).message}`);
  ok(stage, !writeErr.ok, `${STAGE_LABEL[op]} should be REJECTED when close committed first`);
  equal(stage, writeErr.error.status, 409, `${op} blocked HTTP status`);
  ok(stage, String(writeErr.error.code).startsWith('PERIOD_CLOSED'), `${op} blocked code (got ${writeErr.error.code})`);

  // DB read-back: period CLOSED at v1, exactly one snapshot per user (3 seed users),
  // and the activity table shows the writer's change did NOT land.
  const row = await getPeriod(period);
  equal(stage, row.status, 'closed', 'period status read-back');
  equal(stage, Number(row.currentVersion), 1, 'current version read-back');
  equal(stage, await snapshotCount(period, 1), 3, 'snapshot rows read-back (one per seeded user)');

  const rows = await monthActivities(h, period, USERS.ADMIN);
  if (op === 'create') {
    equal(stage, rows.length, 1, 'activity count read-back (create rolled back)');
  } else if (op === 'update') {
    equal(stage, rows.length, 1, 'activity count read-back (no extra row)');
    equal(stage, Number(rows[0].amount), 10, 'amount read-back unchanged (update rolled back)');
  } else {
    equal(stage, rows.length, 1, 'activity still present read-back (remove rolled back)');
    equal(stage, Number(rows[0].id), seededId, 'seeded row id read-back');
  }
  // Snapshot must reflect the pre-write carbon, not the rejected update/removal.
  const snap = await h.dataSource.getRepository(require('../dist/models/accountingSnapshot').AccountingSnapshot)
    .findOne({ where: { periodId: Number(row.id), userId: USERS.ADMIN, version: 1 } });
  equal(stage, snap.activityCount, 1, 'snapshot activity_count read-back');
  equal(stage, Number(snap.totalCarbon).toFixed(2), Number(seededCarbon).toFixed(2), 'snapshot total read-back (writer excluded)');
  await noOpenTransactions(stage);
  ctx.log.push(`${stage}: close committed v1, ${op} rejected 409, activities/snapshot unchanged`);
}

async function run() {
  const h = await init();
  const ctx = { log: [] };
  await resetDb();

  // Deterministic months (2026), one per scenario; DB reset wipes accounting state.
  await runWriteFirstCreate(h, ctx, '2026-01');
  await resetDbAfterScenario(h);

  await runWriteFirstUpdate(h, ctx, '2026-02');
  await resetDbAfterScenario(h);

  await runWriteFirstRemove(h, ctx, '2026-03');
  await resetDbAfterScenario(h);

  await runCloseFirst(h, ctx, 'create', '2026-04');
  await resetDbAfterScenario(h);

  await runCloseFirst(h, ctx, 'update', '2026-05');
  await resetDbAfterScenario(h);

  await runCloseFirst(h, ctx, 'remove', '2026-06');

  await closeDb();
  return ctx.log;
}

async function resetDbAfterScenario(h) {
  await resetDb();
  const n = await activeTransactions();
  if (n !== 0) throw new Error(`inter-scenario leak: ${n} open transactions`);
}

if (require.main === module) {
  run()
    .then((log) => {
      console.log('CONCURRENCY REGRESSION PASS');
      log.forEach((line) => console.log('  - ' + line));
      process.exit(0);
    })
    .catch((error) => {
      console.error('CONCURRENCY REGRESSION FAIL');
      console.error(`stage=${error.stage || 'n/a'}`);
      console.error(error.stack || error.message || error);
      process.exit(1);
    });
}

module.exports = { run };
