import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Customer, FeatureFlag, Location, Offer } from '../../database/entities';
import { AuthModule } from '../auth/auth.module';
import { CelebrationController } from './celebration.controller';
import { CelebrationService } from './celebration.service';

/**
 * Staff-facing birthday/celebration state. A deliberately small, single-purpose
 * module: it is the ONLY staff-side reader of Customer.date_of_birth, which
 * keeps the privacy audit boundary tight (cf. AdminModule's breadth).
 *
 * AuthGuard('jwt') is provided via AuthModule; RolesGuard is used directly on
 * the controller. Repos are registered locally (TypeORM tolerates the same
 * entity in multiple forFeature calls across modules).
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Customer, Location, Offer, FeatureFlag]),
    AuthModule,
  ],
  controllers: [CelebrationController],
  providers: [CelebrationService],
})
export class CelebrationModule {}
