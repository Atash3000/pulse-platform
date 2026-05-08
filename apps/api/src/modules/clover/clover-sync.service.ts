import { Injectable, Logger } from '@nestjs/common';

/**
 * STUB. Real Clover REST integration lands in the clover module's full build.
 *
 * Contract (per spec section 5.4):
 *   - syncOrder(orderId) is called by order.worker on ORDER_PAID.
 *   - Real implementation will retry [0s, 30s, 2min, 10min] before giving up
 *     and setting orders.clover_sync_status = MANUAL_REQUIRED + Telegram alert.
 *   - Until the real version exists, this method MUST NOT throw — we don't
 *     want unimplemented downstream side-effects to mark good outbox events
 *     as DEAD.
 */
@Injectable()
export class CloverSyncService {
  private readonly logger = new Logger(CloverSyncService.name);

  async syncOrder(orderId: string): Promise<void> {
    this.logger.log(`Clover sync not yet implemented for order ${orderId}`);
  }
}
