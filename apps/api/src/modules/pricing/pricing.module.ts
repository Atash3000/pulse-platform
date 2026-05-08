import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { PricingRule } from '../../database/entities';
import { PricingService } from './pricing.service';

@Module({
  imports: [TypeOrmModule.forFeature([PricingRule])],
  providers: [PricingService],
  exports: [PricingService],
})
export class PricingModule {}
