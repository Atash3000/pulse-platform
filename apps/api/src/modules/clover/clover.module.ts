import { Module } from '@nestjs/common';

import { CloverSyncService } from './clover-sync.service';

@Module({
  providers: [CloverSyncService],
  exports: [CloverSyncService],
})
export class CloverModule {}
