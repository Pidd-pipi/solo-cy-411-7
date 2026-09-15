import { ActivityCategory } from './activity';
import { GoalStatus } from './goal';
import { PeriodStatus } from './accounting';

export const LogTemplates = {
  USER_REGISTER_START: 'User[email={email}] register start',
  USER_REGISTER_SUCCESS: 'User[id={id}] register success in region={region}',
  USER_REGISTER_FAILED: 'User[email={email}] register failed: {reason}',
  USER_LOGIN_START: 'User[email={email}] login start',
  USER_LOGIN_SUCCESS: 'User[id={id}] login success roles={roles}',
  USER_LOGIN_FAILED: 'User[email={email}] login failed: {reason}',
  USER_PROFILE_UPDATE_START: 'User[id={id}] profile update start field={field}',
  USER_PROFILE_UPDATE_SUCCESS: 'User[id={id}] profile update success region={region}',
  USER_PROFILE_UPDATE_FAILED: 'User[id={id}] profile update failed field={field}: {reason}',
  ACTIVITY_LIST_START: `Activity list start category values=${Object.values(ActivityCategory).join(',')}`,
  ACTIVITY_CREATE_START: 'Activity[user_id={userId}] create start category={category} sub_type={subType}',
  ACTIVITY_CREATE_SUCCESS: 'Activity[id={id}] create success carbon_value={carbonValue}',
  ACTIVITY_CREATE_FAILED: 'Activity[id={id}] create failed: {field} {reason}',
  ACTIVITY_UPDATE_START: 'Activity[id={id}] update start fields={fields}',
  ACTIVITY_UPDATE_SUCCESS: 'Activity[id={id}] update success carbon_value={carbonValue}',
  ACTIVITY_UPDATE_FAILED: 'Activity[id={id}] update failed: {field} {reason}',
  ACTIVITY_DELETE_SUCCESS: 'Activity[id={id}] delete success',
  GOAL_LIST_START: `Goal list start statuses=${Object.values(GoalStatus).join(',')}`,
  GOAL_CREATE_START: 'Goal[user_id={userId}] create start status={status}',
  GOAL_CREATE_SUCCESS: 'Goal[id={id}] create success target_value={targetValue}',
  GOAL_CREATE_FAILED: 'Goal[id={id}] create failed: {field} {reason}',
  GOAL_PROGRESS_CALCULATED: 'Goal[id={id}] progress calculated current={currentValue} target={targetValue}',
  FACTOR_LIST_START: `CarbonFactor list start categories=${Object.values(ActivityCategory).join(',')}`,
  FACTOR_CREATE_SUCCESS: 'CarbonFactor[id={id}] create success category={category} region={region}',
  FACTOR_CREATE_FAILED: 'CarbonFactor[id={id}] create failed: {field} {reason}',
  AUDIT_WRITE_START: 'AuditLog[entity={entity}] write start action={action}',
  AUDIT_WRITE_SUCCESS: 'AuditLog[id={id}] write success entity={entity}',
  AUDIT_WRITE_FAILED: 'AuditLog[entity={entity}] write failed: {reason}',
  AUTH_GUARD_GRANTED: 'Auth[user_id={id}] guard granted',
  AUTH_GUARD_DENIED: 'Auth[token={token}] guard denied: {reason}',
  RBAC_GRANTED: 'RBAC[user_id={id}] role granted required={roles}',
  RBAC_DENIED: 'RBAC[user_id={id}] role denied required={roles}',
  PERIOD_LIST_START: `AccountingPeriod list start statuses=${Object.values(PeriodStatus).join(',')}`,
  PERIOD_GUARD_LOCK_START: 'AccountingPeriod[period={period}] guard lock start tx={tx}',
  PERIOD_GUARD_LOCKED: 'AccountingPeriod[id={id}] guard locked period={period} status={status}',
  PERIOD_GUARD_RETRY: 'AccountingPeriod[period={period}] guard retry attempt={attempt} reason={reason}',
  PERIOD_CLOSE_START: 'AccountingPeriod[period={period}] close start by admin={adminId}',
  PERIOD_CLOSE_SUCCESS: 'AccountingPeriod[id={id}] close success period={period} version={version} users={users}',
  PERIOD_CLOSE_FAILED: 'AccountingPeriod[period={period}] close failed: {field} {reason}',
  PERIOD_REOPEN_START: 'AccountingPeriod[period={period}] reopen start by admin={adminId}',
  PERIOD_REOPEN_SUCCESS: 'AccountingPeriod[id={id}] reopen success period={period} versionKept={version}',
  PERIOD_REOPEN_FAILED: 'AccountingPeriod[period={period}] reopen failed: {field} {reason}',
  PERIOD_SNAPSHOT_BUILT: 'AccountingSnapshot[period={period}] version={version} built for user={userId} total={total}',
  PERIOD_WRITE_BLOCKED: 'AccountingPeriod[period={period}] activity write blocked status={status} action={action}',
  HEALTH_CHECK: 'System[health] backend health check'
} as const;

export type LogTemplateKey = keyof typeof LogTemplates;

