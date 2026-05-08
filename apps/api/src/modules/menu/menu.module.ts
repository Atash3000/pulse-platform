import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import {
  Inventory,
  Location,
  MenuCategory,
  MenuItem,
  Modifier,
  ModifierGroup,
} from '../../database/entities';
import { HealthModule } from '../health/health.module';
import { MenuCache } from './menu.cache';
import { MenuController } from './menu.controller';
import { MenuService } from './menu.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Location, MenuCategory, MenuItem, ModifierGroup, Modifier, Inventory]),
    // HealthModule exports the REDIS_CLIENT provider used by MenuCache.
    HealthModule,
  ],
  controllers: [MenuController],
  providers: [MenuService, MenuCache],
  // Inventory toggles, Clover sync, and Phase-2 dynamic-pricing flips will all
  // call MenuService.invalidate(). Keep both visible to consumers.
  exports: [MenuService, MenuCache],
})
export class MenuModule {}
