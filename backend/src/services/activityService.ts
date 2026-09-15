import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import dayjs from 'dayjs';
import { Repository } from 'typeorm';
import { ActivityCategory } from '../constants/activity';
import { ErrorCodes } from '../constants/errorCodes';
import { Messages } from '../constants/messages';
import { Activity } from '../models/activity';
import { AppError } from '../utils/AppError';
import { calculateCarbonValue } from '../utils/carbonCalculator';
import { logTemplate } from '../utils/logger';
import { AccountingService, monthOf, PeriodGates } from './accountingService';
import { FactorService } from './factorService';
import { UserService } from './userService';

export interface ActivityInput {
  category: ActivityCategory;
  subType: string;
  amount: number;
  unit: string;
  recordDate: string;
  note?: string;
}

@Injectable()
export class ActivityService {
  constructor(
    @InjectRepository(Activity) private readonly activityRepo: Repository<Activity>,
    private readonly factorService: FactorService,
    private readonly userService: UserService,
    private readonly accountingService: AccountingService
  ) {}

  // Reads route through accounting: closed months come from frozen snapshots,
  // open months from live activities. With no range the Activities page still
  // gets every month (frozen closed months + live open months), so its
  // client-side category filter and pagination keep working unchanged.
  async list(userId: number, category?: ActivityCategory, start?: string, end?: string) {
    logTemplate('info', 'ACTIVITY_LIST_START');
    if (start && end) {
      return this.accountingService.readUserRows(userId, start, end, category);
    }
    return this.accountingService.readAllRowsAcrossClosedMonths(userId, category);
  }

  async create(userId: number, input: ActivityInput, gates?: PeriodGates) {
    logTemplate('info', 'ACTIVITY_CREATE_START', { userId, category: input.category, subType: input.subType });
    if (!Object.values(ActivityCategory).includes(input.category)) {
      logTemplate('warn', 'ACTIVITY_CREATE_FAILED', { id: 0, field: 'Activity.category', reason: 'invalid enum' });
      throw new AppError(ErrorCodes.ACTIVITY_CATEGORY_INVALID, `Activity[id=0] create failed: category invalid`);
    }
    const recordDate = dayjs(input.recordDate).format('YYYY-MM-DD');
    const month = monthOf(recordDate);

    return this.accountingService.runWithPeriodLocks([month], async ({ queryRunner, periods }) => {
      this.accountingService.assertWritable(periods, 'Activity create');
      const user = await this.userService.findById(userId);
      const factor = await this.factorService.findMatching(input.category, input.subType, user.region);
      const carbonValue = calculateCarbonValue({ category: input.category, amount: Number(input.amount), factorValue: Number(factor.factorValue) });
      const activity = queryRunner.manager.create(Activity, {
        userId,
        factorId: Number(factor.id),
        category: input.category,
        subType: input.subType,
        amount: String(input.amount),
        unit: input.unit,
        carbonValue: String(carbonValue),
        recordDate,
        note: input.note || null
      });
      const saved = await queryRunner.manager.save(activity);
      await this.accountingService.bumpActivityVersionOnRunner(queryRunner, periods);
      logTemplate('info', 'ACTIVITY_CREATE_SUCCESS', { id: saved.id, carbonValue });
      return { message: Messages.ACTIVITY_CREATED, activity: saved };
    }, gates);
  }

  async update(userId: number, id: number, input: Partial<ActivityInput>, gates?: PeriodGates) {
    logTemplate('info', 'ACTIVITY_UPDATE_START', { id, fields: Object.keys(input).join(',') });

    // Pre-read (no lock) only to learn the candidate months to guard.
    const pre = await this.activityRepo.findOne({ where: { id, userId } });
    if (!pre) {
      logTemplate('warn', 'ACTIVITY_UPDATE_FAILED', { id, field: 'Activity.id', reason: 'not found' });
      throw new AppError(ErrorCodes.ACTIVITY_NOT_FOUND, `Activity[id=${id}] update failed: id not found`, HttpStatus.NOT_FOUND);
    }
    const provisionalDate = input.recordDate ? dayjs(input.recordDate).format('YYYY-MM-DD') : pre.recordDate;
    const guardMonths = Array.from(new Set([monthOf(pre.recordDate), monthOf(provisionalDate)])).sort();

    return this.accountingService.runWithPeriodLocks(guardMonths, async ({ queryRunner, periods }) => {
      // Row-level lock first; the date could have shifted since the pre-read,
      // so re-lock the row's ACTUAL month before checking writability.
      const activity = await queryRunner.manager.findOne(Activity, {
        where: { id, userId },
        lock: { mode: 'pessimistic_write' }
      });
      if (!activity) {
        throw new AppError(ErrorCodes.ACTIVITY_NOT_FOUND, `Activity[id=${id}] update failed: id not found`, HttpStatus.NOT_FOUND);
      }
      const finalDate = input.recordDate ? dayjs(input.recordDate).format('YYYY-MM-DD') : activity.recordDate;
      const requiredMonths = Array.from(new Set([monthOf(activity.recordDate), monthOf(finalDate)])).sort();
      const lockedPeriods = [...periods];
      for (const month of requiredMonths) {
        if (!lockedPeriods.some((period) => period.period === month)) {
          lockedPeriods.push(await this.accountingService.lockPeriodOnRunner(queryRunner, month));
        }
      }
      this.accountingService.assertWritable(lockedPeriods, 'Activity update');

      const nextCategory = input.category ?? activity.category;
      const nextSubType = input.subType ?? activity.subType;
      const nextAmount = Number(input.amount ?? activity.amount);
      const user = await this.userService.findById(userId);
      const factor = await this.factorService.findMatching(nextCategory, nextSubType, user.region);
      const carbonValue = calculateCarbonValue({ category: nextCategory, amount: nextAmount, factorValue: Number(factor.factorValue) });
      activity.category = nextCategory;
      activity.subType = nextSubType;
      activity.amount = String(nextAmount);
      activity.unit = input.unit ?? activity.unit;
      activity.factorId = Number(factor.id);
      activity.carbonValue = String(carbonValue);
      activity.recordDate = finalDate;
      activity.note = input.note ?? activity.note;
      const saved = await queryRunner.manager.save(activity);
      await this.accountingService.bumpActivityVersionOnRunner(queryRunner, lockedPeriods);
      logTemplate('info', 'ACTIVITY_UPDATE_SUCCESS', { id: saved.id, carbonValue });
      return { message: Messages.ACTIVITY_UPDATED, activity: saved };
    }, gates);
  }

  async remove(userId: number, id: number, gates?: PeriodGates) {
    const pre = await this.activityRepo.findOne({ where: { id, userId } });
    if (!pre) {
      throw new AppError(ErrorCodes.ACTIVITY_NOT_FOUND, `Activity[id=${id}] delete failed: id not found`, HttpStatus.NOT_FOUND);
    }

    return this.accountingService.runWithPeriodLocks([monthOf(pre.recordDate)], async ({ queryRunner, periods }) => {
      const activity = await queryRunner.manager.findOne(Activity, {
        where: { id, userId },
        lock: { mode: 'pessimistic_write' }
      });
      if (!activity) {
        throw new AppError(ErrorCodes.ACTIVITY_NOT_FOUND, `Activity[id=${id}] delete failed: id not found`, HttpStatus.NOT_FOUND);
      }
      const lockedPeriods = [...periods];
      if (!lockedPeriods.some((period) => period.period === monthOf(activity.recordDate))) {
        lockedPeriods.push(await this.accountingService.lockPeriodOnRunner(queryRunner, monthOf(activity.recordDate)));
      }
      this.accountingService.assertWritable(lockedPeriods, 'Activity delete');
      await queryRunner.manager.remove(activity);
      await this.accountingService.bumpActivityVersionOnRunner(queryRunner, lockedPeriods);
      logTemplate('info', 'ACTIVITY_DELETE_SUCCESS', { id });
      return { message: Messages.ACTIVITY_DELETED };
    }, gates);
  }

  async summarize(userId: number, start: string, end: string) {
    const rows = await this.list(userId, undefined, start, end);
    const total = rows.reduce((sum, row) => sum + Number(row.carbonValue), 0);
    const byCategory = Object.values(ActivityCategory).map((category) => ({
      category,
      value: rows.filter((row) => row.category === category).reduce((sum, row) => sum + Number(row.carbonValue), 0)
    }));
    return { total: Number(total.toFixed(2)), byCategory, rows };
  }
}
