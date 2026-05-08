import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { FeatureFlag } from '../../database/entities';

@Injectable()
export class AdminFeatureFlagsService {
  private readonly logger = new Logger(AdminFeatureFlagsService.name);

  constructor(
    @InjectRepository(FeatureFlag) private readonly flags: Repository<FeatureFlag>,
  ) {}

  async list(): Promise<FeatureFlag[]> {
    return this.flags.find({ order: { key: 'ASC' } });
  }

  async toggle(key: string, enabled: boolean, ownerUserId: string): Promise<FeatureFlag> {
    const row = await this.flags.findOne({ where: { key } });
    if (!row) {
      throw new NotFoundException(`Feature flag "${key}" not found`);
    }
    row.enabled = enabled;
    row.rollout_pct = enabled ? 100 : 0;
    const saved = await this.flags.save(row);
    this.logger.log(`feature flag "${key}" set to ${enabled} by owner ${ownerUserId}`);
    return saved;
  }
}
