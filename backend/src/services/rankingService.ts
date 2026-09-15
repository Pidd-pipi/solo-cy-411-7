import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../models/user';
import { logTemplate } from '../utils/logger';
import { AccountingService } from './accountingService';

@Injectable()
export class RankingService {
  constructor(
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    private readonly accountingService: AccountingService
  ) {}

  async list(region?: string, start?: string, end?: string) {
    logTemplate('info', 'ACTIVITY_LIST_START');
    // Region membership and identity always come from the live users table;
    // snapshot.region captured at close is audit-only. Closed months are read
    // from frozen current-version snapshots, open months from live activities,
    // so ranking stays consistent with dashboard and goal progress.
    const users = await this.userRepo.find({ where: region ? { region } : {}, order: { username: 'ASC' } });
    const totals = start && end
      ? await this.accountingService.readAllUserTotals(start, end)
      : await this.accountingService.readAllUserTotalsAcrossClosedMonths();
    const result = users.map((user) => ({
      userId: Number(user.id),
      username: user.username,
      region: user.region,
      avatar: user.avatar,
      totalCarbon: Number((totals.get(Number(user.id)) || 0).toFixed(2))
    }));
    return result.sort((a, b) => a.totalCarbon - b.totalCarbon).map((item, index) => ({ ...item, rank: index + 1 }));
  }
}
