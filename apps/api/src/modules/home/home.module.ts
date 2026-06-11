import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { OrderItem } from '../../database/entities';
import { AuthModule } from '../auth/auth.module';
import { HomeController } from './home.controller';
import { HomeService } from './home.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([OrderItem]),
    AuthModule, // for AuthGuard('jwt')
  ],
  controllers: [HomeController],
  providers: [HomeService],
})
export class HomeModule {}
