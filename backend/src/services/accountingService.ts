import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import dayjs from 'dayjs';
import { DataSource, Between, QueryFailedError, QueryRunner, Repository } from 'typeorm';
import { ActivityCategory } from '../constants/activity';
import { PERIOD_PATTERN, PERIOD_ERROR_FIELDS, PeriodStatus } from '../constants/accounting';
import { ErrorCodes } from '../constants/errorCodes';
import { Messages } from '../constants/messages';
import { Activity } from '../models/activity';
import { AccountingPeriod } from '../models/accountingPeriod';
import { AccountingSnapshot, SnapshotByCategory, SnapshotDetailRow } from '../models/accountingSnapshot';
import { User } from '../models/user';
import { AppError } from '../utils/AppError';
import { logTemplate } from '../utils/logger';

export interface DateSegment {
  start: string;
  end: string;
  closed: boolean;
  period?: string;
  version?: number;
}

export interface PeriodLockContext {
  queryRunner: QueryRunner;
  periods: AccountingPeriod[];
}

const LOCK_RETRY_ATTEMPTS = 3;
const LOCK_RETRY_DELAY_MS = 30;
const LOCK_ERRNOS = [1213, 1205];

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isLockConflict(error: unknown): boolean {
  const driver = (error as QueryFailedError)?.driverError as { errno?: number } | undefined;
  return Boolean(driver && typeof driver.errno === 'number' && LOCK_ERRNOS.includes(driver.errno));
}

export function monthOf(date: string): string {
  return dayjs(date).format('YYYY-MM');
}

export function emptyByCategory(): SnapshotByCategory {
  return {
    [ActivityCategory.TRANSPORT]: 0,
    [ActivityCategory.ENERGY]: 0,
    [ActivityCategory.FOOD]: 0,
    [ActivityCategory.SHOPPING]: 0
  };
}

@Injectable()
export class AccountingService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(AccountingPeriod) private readonly periodRepo: Repository<AccountingPeriod>,
    @InjectRepository(AccountingSnapshot) private readonly snapshotRepo: Repository<AccountingSnapshot>,
    @InjectRepository(Activity) private readonly activityRepo: Repository<Activity>
  ) {}

  validatePeriod(period: string): string {
    if (!period || !PERIOD_PATTERN.test(period)) {
      throw new AppError(ErrorCodes.PERIOD_FORMAT_INVALID, `AccountingPeriod[period=${period}] format invalid: expected YYYY-MM`, HttpStatus.BAD_REQUEST);
    }
    return period;
  }

  // ---------------------------------------------------------------------------
  // Concurrency primitive: every close/reopen and every activity write enters
  // through here on ONE pinned connection. INSERT IGNORE guarantees the guard
  // row exists; FOR UPDATE serializes on the unique period index. The write tx
  // holds the X lock until commit, so a close and a same-month activity write
  // can never both succeed (see runWithPeriodLocks retry for the first-close gap
  // lock race).
  // ---------------------------------------------------------------------------
  async runWithPeriodLocks<T>(periodsInput: string[], fn: (ctx: PeriodLockContext) => Promise<T>): Promise<T> {
    const periods = Array.from(new Set(periodsInput.map((p) => this.validatePeriod(p)))).sort();
    let lastError: unknown;

    for (let attempt = 1; attempt <= LOCK_RETRY_ATTEMPTS; attempt += 1) {
      const queryRunner = this.dataSource.createQueryRunner();
      await queryRunner.connect();
      try {
        await queryRunner.startTransaction('REPEATABLE READ');
        const locked: AccountingPeriod[] = [];
        for (const period of periods) {
          locked.push(await this.lockPeriodOnRunner(queryRunner, period, attempt));
        }
        const result = await fn({ queryRunner, periods: locked });
        await queryRunner.commitTransaction();
        return result;
      } catch (error) {
        await queryRunner.rollbackTransaction().catch(() => undefined);
        if (isLockConflict(error) && attempt < LOCK_RETRY_ATTEMPTS) {
          logTemplate('warn', 'PERIOD_GUARD_RETRY', { period: periods.join(','), attempt, reason: String((error as any)?.driverError?.errno || error) });
          await sleep(LOCK_RETRY_DELAY_MS * attempt);
          lastError = error;
          continue;
        }
        throw error;
      } finally {
        await queryRunner.release();
      }
    }
    throw lastError;
  }

  // Lock a single month on an already-open transaction/runner. Used by the
  // activity write path to (re)lock the row's ACTUAL month after taking the row
  // lock, when the record_date could have shifted from the pre-read value.
  async lockPeriodOnRunner(queryRunner: QueryRunner, periodInput: string, tx = 0): Promise<AccountingPeriod> {
    const period = this.validatePeriod(periodInput);
    logTemplate('info', 'PERIOD_GUARD_LOCK_START', { period, tx });
    await queryRunner.query(
      `INSERT IGNORE INTO accounting_periods (period, status, current_version, created_at) VALUES (?, ?, 0, NOW(3))`,
      [period, PeriodStatus.OPEN]
    );
    const row = await queryRunner.manager.findOne(AccountingPeriod, {
      where: { period },
      lock: { mode: 'pessimistic_write' }
    });
    if (!row) {
      throw new AppError(ErrorCodes.PERIOD_NOT_FOUND, `AccountingPeriod[period=${period}] guard failed: row missing after insert`, HttpStatus.INTERNAL_SERVER_ERROR);
    }
    logTemplate('info', 'PERIOD_GUARD_LOCKED', { id: row.id, period, status: row.status });
    return row;
  }

  // Bump activity_version for each affected month INSIDE the write transaction,
  // after the activity mutation. A concurrent close holding/bidding for the same
  // period row lock observes the bump and aborts with PERIOD_CLOSE_CONFLICT.
  async bumpActivityVersionOnRunner(queryRunner: QueryRunner, periods: AccountingPeriod[]) {
    for (const periodRow of periods) {
      await queryRunner.query(
        `UPDATE accounting_periods SET activity_version = activity_version + 1, updated_at = NOW(3) WHERE id = ?`,
        [Number(periodRow.id)]
      );
      periodRow.activityVersion = Number(periodRow.activityVersion) + 1;
    }
  }

  // Used by the activity write path: reject if any guarded month is closed.
  assertWritable(periods: AccountingPeriod[], action: string) {
    const closed = periods.find((period) => period.status === PeriodStatus.CLOSED);
    if (closed) {
      logTemplate('warn', 'PERIOD_WRITE_BLOCKED', { period: closed.period, status: closed.status, action });
      throw new AppError(
        ErrorCodes.PERIOD_CLOSED,
        `AccountingPeriod[period=${closed.period}] ${action} failed: period closed at version ${closed.currentVersion}`,
        HttpStatus.CONFLICT
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Admin: close / reopen
  // ---------------------------------------------------------------------------
  async close(periodInput: string, adminUserId: number) {
    const period = this.validatePeriod(periodInput);
    const start = `${period}-01`;
    const end = dayjs(start).endOf('month').format('YYYY-MM-DD');

    // Baseline taken BEFORE acquiring the lock. A same-month activity write that
    // commits while we contend for the lock bumps activity_version; after we get
    // the lock the mismatch makes close abort (409) without writing a snapshot or
    // touching activities, so close and the write can never both succeed.
    const baselineRow = await this.periodRepo.findOne({ where: { period } });
    const baselineActivityVersion = baselineRow ? Number(baselineRow.activityVersion) : 0;

    return this.runWithPeriodLocks([period], async ({ queryRunner, periods }) => {
      const periodRow = periods[0];
      if (periodRow.status === PeriodStatus.CLOSED) {
        logTemplate('warn', 'PERIOD_CLOSE_FAILED', { period, field: PERIOD_ERROR_FIELDS.STATUS, reason: 'already closed' });
        throw new AppError(ErrorCodes.PERIOD_ALREADY_CLOSED, `AccountingPeriod[period=${period}] close failed: already closed at version ${periodRow.currentVersion}`, HttpStatus.CONFLICT);
      }
      if (Number(periodRow.activityVersion) !== baselineActivityVersion) {
        logTemplate('warn', 'PERIOD_CLOSE_FAILED', { period, field: PERIOD_ERROR_FIELDS.ACTIVITY_VERSION, reason: 'concurrent activity write committed first' });
        throw new AppError(
          ErrorCodes.PERIOD_CLOSE_CONFLICT,
          `AccountingPeriod[period=${period}] close failed: a concurrent activity write committed first (activity_version ${baselineActivityVersion} -> ${periodRow.activityVersion}); reload and retry`,
          HttpStatus.CONFLICT
        );
      }
      const version = Number(periodRow.currentVersion) + 1;

      // Lock is held and activity_version matched the baseline, so no same-month
      // write committed during contention; it is safe to freeze the month now.
      const users = await queryRunner.manager.find(User, { order: { id: 'ASC' } });
      const activities = await queryRunner.manager.find(Activity, {
        where: { recordDate: Between(start, end) },
        order: { recordDate: 'DESC', id: 'DESC' }
      });
      const byUser = new Map<number, Activity[]>();
      activities.forEach((activity) => {
        const key = Number(activity.userId);
        const bucket = byUser.get(key) || [];
        bucket.push(activity);
        byUser.set(key, bucket);
      });

      for (const user of users) {
        const rows = byUser.get(Number(user.id)) || [];
        const rawByCategory = emptyByCategory();
        let rawTotal = 0;
        const detail: SnapshotDetailRow[] = rows.map((activity) => {
          rawByCategory[activity.category] += Number(activity.carbonValue);
          rawTotal += Number(activity.carbonValue);
          return {
            id: Number(activity.id),
            userId: Number(activity.userId),
            factorId: activity.factorId == null ? null : Number(activity.factorId),
            category: activity.category,
            subType: activity.subType,
            amount: String(activity.amount),
            unit: activity.unit,
            carbonValue: String(activity.carbonValue),
            recordDate: activity.recordDate,
            note: activity.note
          };
        });
        // Round once, mirroring ActivityService.summarize so snapshot and live agree.
        const byCategory = emptyByCategory();
        Object.keys(rawByCategory).forEach((category) => {
          byCategory[category as ActivityCategory] = Number(rawByCategory[category as ActivityCategory].toFixed(2));
        });
        const totalCarbon = Number(rawTotal.toFixed(2));
        const snapshot = queryRunner.manager.create(AccountingSnapshot, {
          periodId: Number(periodRow.id),
          version,
          userId: Number(user.id),
          region: user.region,
          activityCount: detail.length,
          totalCarbon: String(totalCarbon.toFixed(2)),
          byCategory,
          detail
        });
        await queryRunner.manager.save(snapshot);
        logTemplate('info', 'PERIOD_SNAPSHOT_BUILT', { period, version, userId: user.id, total: totalCarbon.toFixed(2) });
      }

      periodRow.status = PeriodStatus.CLOSED;
      periodRow.currentVersion = version;
      periodRow.closedBy = adminUserId;
      periodRow.closedAt = new Date();
      periodRow.reopenReason = null;
      periodRow.reopenedBy = null;
      periodRow.reopenedAt = null;
      await queryRunner.manager.save(periodRow);
      logTemplate('info', 'PERIOD_CLOSE_SUCCESS', { id: periodRow.id, period, version, users: users.length });

      return {
        message: Messages.PERIOD_CLOSED,
        period,
        status: PeriodStatus.CLOSED,
        version,
        start,
        end,
        memberCount: users.length
      };
    });
  }

  async reopen(periodInput: string, reason: string | undefined, adminUserId: number) {
    const period = this.validatePeriod(periodInput);
    if (!reason || !reason.trim()) {
      logTemplate('warn', 'PERIOD_REOPEN_FAILED', { period, field: PERIOD_ERROR_FIELDS.REOPEN_REASON, reason: 'reason required' });
      throw new AppError(ErrorCodes.PERIOD_REOPEN_REASON_REQUIRED, `AccountingPeriod[period=${period}] reopen failed: reopen_reason required`, HttpStatus.BAD_REQUEST);
    }

    return this.runWithPeriodLocks([period], async ({ queryRunner, periods }) => {
      const periodRow = periods[0];
      if (periodRow.status !== PeriodStatus.CLOSED) {
        logTemplate('warn', 'PERIOD_REOPEN_FAILED', { period, field: PERIOD_ERROR_FIELDS.STATUS, reason: 'not closed' });
        throw new AppError(ErrorCodes.PERIOD_NOT_CLOSED, `AccountingPeriod[period=${period}] reopen failed: period is not closed`, HttpStatus.CONFLICT);
      }
      periodRow.status = PeriodStatus.OPEN;
      periodRow.reopenReason = reason.trim();
      periodRow.reopenedBy = adminUserId;
      periodRow.reopenedAt = new Date();
      // current_version and existing snapshot rows are intentionally preserved.
      await queryRunner.manager.save(periodRow);
      logTemplate('info', 'PERIOD_REOPEN_SUCCESS', { id: periodRow.id, period, version: periodRow.currentVersion });

      return {
        message: Messages.PERIOD_REOPENED,
        period,
        status: PeriodStatus.OPEN,
        currentVersion: Number(periodRow.currentVersion),
        reopenReason: periodRow.reopenReason
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Period metadata / read routing
  // ---------------------------------------------------------------------------
  async listPeriods() {
    logTemplate('info', 'PERIOD_LIST_START');
    const rows = await this.periodRepo.find({ order: { period: 'DESC' } });
    return rows.map((row) => this.serializePeriod(row));
  }

  async statusMap(start: string, end: string): Promise<Map<string, AccountingPeriod>> {
    const firstMonth = monthOf(start);
    const lastMonth = monthOf(end);
    const rows = await this.periodRepo
      .createQueryBuilder('period')
      .where('period.period BETWEEN :firstMonth AND :lastMonth', { firstMonth, lastMonth })
      .getMany();
    const map = new Map<string, AccountingPeriod>();
    rows.forEach((row) => map.set(row.period, row));
    return map;
  }

  private async allClosedPeriods(): Promise<AccountingPeriod[]> {
    return this.periodRepo.find({ where: { status: PeriodStatus.CLOSED }, order: { period: 'ASC' } });
  }

  splitRange(start: string, end: string, statusMap: Map<string, AccountingPeriod>): DateSegment[] {
    const segments: DateSegment[] = [];
    let cursor = dayjs(start).startOf('day');
    const last = dayjs(end).startOf('day');

    while (cursor.isBefore(last) || cursor.isSame(last, 'day')) {
      const monthKey = cursor.format('YYYY-MM');
      const monthEnd = cursor.endOf('month').startOf('day');
      const segmentEnd = monthEnd.isAfter(last) ? last : monthEnd;
      const periodRow = statusMap.get(monthKey);
      const closed = Boolean(periodRow && periodRow.status === PeriodStatus.CLOSED && Number(periodRow.currentVersion) > 0);
      segments.push({
        start: cursor.format('YYYY-MM-DD'),
        end: segmentEnd.format('YYYY-MM-DD'),
        closed,
        period: closed ? monthKey : undefined,
        version: closed ? Number(periodRow!.currentVersion) : undefined
      });
      cursor = monthEnd.add(1, 'day').startOf('day');
    }

    // Merge adjacent segments sharing the same state (and closed month/version).
    return segments.reduce<DateSegment[]>((merged, segment) => {
      const previous = merged[merged.length - 1];
      const sameKind = previous && previous.closed === segment.closed && previous.period === segment.period && previous.version === segment.version;
      if (sameKind) {
        previous.end = segment.end;
      } else {
        merged.push({ ...segment });
      }
      return merged;
    }, []);
  }

  // Frozen rows (Activity-shaped) for closed months + live rows for open months,
  // restricted to one user. decimal values stay strings (mirrors live Activity).
  async readUserRows(userId: number, start: string, end: string, category?: ActivityCategory): Promise<Activity[]> {
    const map = await this.statusMap(start, end);
    const segments = this.splitRange(start, end, map);
    const out: Activity[] = [];

    for (const segment of segments) {
      if (segment.closed && segment.period && segment.version) {
        const periodRow = map.get(segment.period)!;
        const snapshot = await this.snapshotRepo.findOne({
          where: { periodId: Number(periodRow.id), userId, version: segment.version }
        });
        if (!snapshot) continue;
        snapshot.detail.forEach((row) => {
          if (row.recordDate >= segment.start && row.recordDate <= segment.end && (!category || row.category === category)) {
            out.push(this.detailToActivity(row));
          }
        });
      } else {
        const rows = await this.activityRepo.find({
          where: {
            userId,
            ...(category ? { category } : {}),
            recordDate: Between(segment.start, segment.end)
          },
          relations: ['factor'],
          order: { recordDate: 'DESC', id: 'DESC' }
        });
        out.push(...rows);
      }
    }

    return out.sort((a, b) => (a.recordDate === b.recordDate ? Number(b.id) - Number(a.id) : b.recordDate.localeCompare(a.recordDate)));
  }

  // GET /activities with no range: frozen closed months + live open months.
  async readAllRowsAcrossClosedMonths(userId: number, category?: ActivityCategory): Promise<Activity[]> {
    const closedPeriods = await this.allClosedPeriods();
    const closedKeys = new Set(closedPeriods.map((period) => period.period));
    const frozen: Activity[] = [];

    for (const periodRow of closedPeriods) {
      const version = Number(periodRow.currentVersion);
      const matched = await this.snapshotRepo.findOne({
        where: { periodId: Number(periodRow.id), userId, version }
      });
      if (!matched) continue;
      matched.detail.forEach((row) => {
        if (!category || row.category === category) frozen.push(this.detailToActivity(row));
      });
    }

    const live = await this.activityRepo.find({
      where: { userId, ...(category ? { category } : {}) },
      relations: ['factor'],
      order: { recordDate: 'DESC', id: 'DESC' }
    });
    const openLive = live.filter((row) => !closedKeys.has(monthOf(row.recordDate)));

    return [...frozen, ...openLive].sort((a, b) =>
      a.recordDate === b.recordDate ? Number(b.id) - Number(a.id) : b.recordDate.localeCompare(a.recordDate)
    );
  }

  // Per-user totals across a range that may span closed and open months.
  async readAllUserTotals(start: string, end: string): Promise<Map<number, number>> {
    const map = await this.statusMap(start, end);
    const segments = this.splitRange(start, end, map);
    const totals = new Map<number, number>();
    const add = (userId: number, value: number) => totals.set(userId, Number(((totals.get(userId) || 0) + value).toFixed(2)));

    for (const segment of segments) {
      if (segment.closed && segment.period && segment.version) {
        const periodRow = map.get(segment.period)!;
        const snapshots = await this.snapshotRepo.find({
          where: { periodId: Number(periodRow.id), version: segment.version }
        });
        snapshots.forEach((snapshot) => {
          const fullMonth = segment.start === `${segment.period}-01` && segment.end === dayjs(segment.start).endOf('month').format('YYYY-MM-DD');
          const value = fullMonth
            ? Number(snapshot.totalCarbon)
            : snapshot.detail
                .filter((row) => row.recordDate >= segment.start && row.recordDate <= segment.end)
                .reduce((sum, row) => sum + Number(row.carbonValue), 0);
          add(Number(snapshot.userId), Number(value.toFixed(2)));
        });
      } else {
        const rows = await this.activityRepo.find({ where: { recordDate: Between(segment.start, segment.end) } });
        rows.forEach((row) => add(Number(row.userId), Number(Number(row.carbonValue).toFixed(2))));
      }
    }
    return totals;
  }

  // All-time per-user totals (no explicit range): frozen current-version
  // snapshots for every closed month + live activities for open months.
  async readAllUserTotalsAcrossClosedMonths(): Promise<Map<number, number>> {
    const totals = new Map<number, number>();
    const add = (userId: number, value: number) => totals.set(userId, Number(((totals.get(userId) || 0) + value).toFixed(2)));

    const closedPeriods = await this.allClosedPeriods();
    const closedKeys = new Set(closedPeriods.map((period) => period.period));

    for (const periodRow of closedPeriods) {
      const snapshots = await this.snapshotRepo.find({
        where: { periodId: Number(periodRow.id), version: Number(periodRow.currentVersion) }
      });
      snapshots.forEach((snapshot) => add(Number(snapshot.userId), Number(snapshot.totalCarbon)));
    }

    const live = await this.activityRepo.find();
    live
      .filter((row) => !closedKeys.has(monthOf(row.recordDate)))
      .forEach((row) => add(Number(row.userId), Number(Number(row.carbonValue).toFixed(2))));

    return totals;
  }

  // ---------------------------------------------------------------------------
  // Member (self) and admin period results / history
  // ---------------------------------------------------------------------------
  async myResult(periodInput: string, userId: number, versionInput?: string) {
    const period = this.validatePeriod(periodInput);
    const periodRow = await this.periodRepo.findOne({ where: { period } });
    const start = `${period}-01`;
    const end = dayjs(start).endOf('month').format('YYYY-MM-DD');

    // An explicit version reads a retained historical snapshot (even after the
    // period has been reopened); the default read follows the period status.
    const version = versionInput ? Number(versionInput) : (periodRow && periodRow.status === PeriodStatus.CLOSED ? Number(periodRow.currentVersion) : 0);
    if (version > 0 && periodRow) {
      const snapshot = await this.snapshotRepo.findOne({
        where: { periodId: Number(periodRow.id), userId, version }
      });
      if (!snapshot) {
        throw new AppError(ErrorCodes.PERIOD_VERSION_NOT_FOUND, `AccountingSnapshot[period=${period}] version=${version} read failed: no snapshot for current user`, HttpStatus.NOT_FOUND);
      }
      return this.serializeSnapshot(snapshot, period, start, end);
    }

    // Open (or never-closed) month, and no explicit historical version: return
    // LIVE data routed through the same segment reader the dashboard uses, so a
    // reopened period immediately agrees with the dashboard.
    const rows = await this.readUserRows(userId, start, end);
    const byCategory = emptyByCategory();
    let total = 0;
    rows.forEach((row) => {
      byCategory[row.category] = Number((byCategory[row.category] + Number(row.carbonValue)).toFixed(2));
      total += Number(row.carbonValue);
    });
    return {
      period,
      status: PeriodStatus.OPEN,
      closed: false,
      version: Number(periodRow?.currentVersion || 0),
      start,
      end,
      activityCount: rows.length,
      totalCarbon: Number(total.toFixed(2)),
      byCategory,
      detail: rows
    };
  }

  async listSummaries(periodInput: string, versionInput?: string) {
    const period = this.validatePeriod(periodInput);
    const periodRow = await this.periodRepo.findOne({ where: { period } });
    if (!periodRow) {
      throw new AppError(ErrorCodes.PERIOD_NOT_FOUND, `AccountingPeriod[period=${period}] read failed: not found`, HttpStatus.NOT_FOUND);
    }
    const version = versionInput ? Number(versionInput) : Number(periodRow.currentVersion);
    const snapshots = await this.snapshotRepo.find({
      where: { periodId: Number(periodRow.id), version },
      order: { totalCarbon: 'DESC', userId: 'ASC' }
    });
    return {
      period,
      status: periodRow.status,
      version,
      members: snapshots.map((snapshot) => ({
        userId: Number(snapshot.userId),
        region: snapshot.region,
        activityCount: snapshot.activityCount,
        totalCarbon: Number(snapshot.totalCarbon),
        byCategory: snapshot.byCategory
      }))
    };
  }

  async listVersions(periodInput: string) {
    const period = this.validatePeriod(periodInput);
    const periodRow = await this.periodRepo.findOne({ where: { period } });
    if (!periodRow) {
      throw new AppError(ErrorCodes.PERIOD_NOT_FOUND, `AccountingPeriod[period=${period}] versions failed: not found`, HttpStatus.NOT_FOUND);
    }
    const grouped = await this.snapshotRepo
      .createQueryBuilder('snapshot')
      .where('snapshot.period_id = :periodId', { periodId: Number(periodRow.id) })
      .select('snapshot.version', 'version')
      .addSelect('MAX(snapshot.created_at)', 'createdAt')
      .addSelect('COUNT(snapshot.id)', 'memberCount')
      .groupBy('snapshot.version')
      .orderBy('snapshot.version', 'DESC')
      .getRawMany<{ version: number; createdAt: Date; memberCount: string }>();

    return {
      period,
      currentVersion: Number(periodRow.currentVersion),
      versions: grouped.map((row) => ({
        version: Number(row.version),
        createdAt: row.createdAt,
        memberCount: Number(row.memberCount)
      }))
    };
  }

  // ---------------------------------------------------------------------------
  // Serializers
  // ---------------------------------------------------------------------------
  private serializePeriod(row: AccountingPeriod) {
    return {
      id: Number(row.id),
      period: row.period,
      status: row.status,
      currentVersion: Number(row.currentVersion),
      closedBy: row.closedBy == null ? null : Number(row.closedBy),
      closedAt: row.closedAt,
      reopenReason: row.reopenReason,
      reopenedBy: row.reopenedBy == null ? null : Number(row.reopenedBy),
      reopenedAt: row.reopenedAt,
      createdAt: row.createdAt
    };
  }

  private serializeSnapshot(snapshot: AccountingSnapshot, period: string, start: string, end: string) {
    return {
      period,
      status: PeriodStatus.CLOSED,
      closed: true,
      version: Number(snapshot.version),
      start,
      end,
      region: snapshot.region,
      activityCount: snapshot.activityCount,
      totalCarbon: Number(snapshot.totalCarbon),
      byCategory: snapshot.byCategory,
      detail: snapshot.detail.map((row) => this.detailToActivity(row))
    };
  }

  private detailToActivity(row: SnapshotDetailRow): Activity {
    return {
      id: row.id,
      userId: row.userId,
      factorId: row.factorId,
      category: row.category,
      subType: row.subType,
      amount: row.amount,
      unit: row.unit,
      carbonValue: row.carbonValue,
      recordDate: row.recordDate,
      note: row.note,
      factor: null
    } as unknown as Activity;
  }
}
