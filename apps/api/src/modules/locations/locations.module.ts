import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import {
  Location,
  LocationHours,
  LocationSettings,
} from '../../database/entities';
import { HoursService } from './hours.service';
import { LocationsController } from './locations.controller';
import { LocationsService } from './locations.service';

@Module({
  imports: [TypeOrmModule.forFeature([Location, LocationHours, LocationSettings])],
  controllers: [LocationsController],
  providers: [LocationsService, HoursService],
  // HoursService is exported because checkout will need canAcceptOrders().
  exports: [LocationsService, HoursService],
})
export class LocationsModule {}
