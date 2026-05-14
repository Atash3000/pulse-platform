import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Customer } from '../../database/entities';
import { AuthModule } from '../auth/auth.module';
import { CustomersController } from './customers.controller';
import { CustomersService } from './customers.service';

/**
 * Customer self-service endpoints (iOS-facing). Phase 1 surface is
 * intentionally tiny: push-token registration only. Future additions
 * (profile read, account deletion, etc.) land here.
 *
 * Auth is delegated to AuthGuard('jwt') via AuthModule. The customer
 * entity's TypeOrmModule registration is local to this module — it is
 * also independently registered in NotificationsModule for the push
 * service's reads. Both registrations are scoped to their owning
 * module; TypeORM tolerates multiple forFeature calls for the same
 * entity across modules.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Customer]),
    AuthModule,
  ],
  controllers: [CustomersController],
  providers: [CustomersService],
  exports: [CustomersService],
})
export class CustomersModule {}
