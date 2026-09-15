'use strict';
/* Minimal assertion helpers that always report stage, expected vs actual. */

function fail(stage, message) {
  const err = new Error(`[${stage}] ${message}`);
  err.stage = stage;
  throw err;
}

function equal(stage, actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) fail(stage, `${label || 'value'} expected ${e} but got ${a}`);
}

function ok(stage, condition, message) {
  if (!condition) fail(stage, message || 'expected truthy condition');
}

async function rejects(stage, promise, { code, status } = {}) {
  let error;
  try {
    await promise;
  } catch (e) {
    error = e;
  }
  if (!error) fail(stage, 'expected the operation to be rejected but it SUCCEEDED');
  const actualStatus = error.status ?? error.getStatus?.();
  if (status !== undefined) {
    equal(stage, actualStatus, status, 'HTTP status');
  }
  if (code !== undefined) {
    // PERIOD_CLOSED code carries the enum suffix, so match on prefix too.
    const exact = error.code === code;
    const prefix = typeof code === 'string' && code.startsWith('PERIOD_CLOSED') && String(error.code).startsWith('PERIOD_CLOSED');
    ok(stage, exact || prefix, `error code expected ${code} but got ${error.code} (message: ${error.message})`);
  }
  return error;
}

module.exports = { fail, equal, ok, rejects };
