import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { OutboxEvent } from '../../database/entities';

/**
 * STUB. Real Telegram Bot API integration comes with the notifications
 * module. For now we log alerts at WARN level with a `[telegram-stub]`
 * prefix so they're easy to grep in CloudWatch / docker logs.
 *
 * The DEAD-event alert is the most operationally important alert on the
 * platform — when it fires, the on-call needs to act. The stub logs the
 * full payload so a human can resolve the incident from the log line alone
 * if real Telegram delivery hasn't been wired up yet.
 */
@Injectable()
export class TelegramService {
  private readonly logger = new Logger(TelegramService.name);
  private readonly botToken: string | undefined;
  private readonly ownerChatId: string | undefined;

  constructor(config: ConfigService) {
    this.botToken = config.get<string>('TELEGRAM_BOT_TOKEN') || undefined;
    this.ownerChatId = config.get<string>('TELEGRAM_OWNER_CHAT_ID') || undefined;
  }

  async alertDeadOutboxEvent(event: OutboxEvent, lastError: string): Promise<void> {
    const message = this.formatDeadEvent(event, lastError);

    if (!this.botToken || !this.ownerChatId) {
      // Local dev / staging without a bot configured — log loudly. Real
      // implementation will retain this fallback as the catch-all when
      // Telegram itself is unreachable.
      this.logger.warn(`[telegram-stub] would alert owner:\n${message}`);
      return;
    }

    // Real send will go here. Keeping the stub log so the message is visible
    // even in environments that have a token configured (until we trust
    // delivery).
    this.logger.warn(`[telegram-stub] alert (real send not yet implemented):\n${message}`);
  }

  private formatDeadEvent(event: OutboxEvent, lastError: string): string {
    return [
      'DEAD OUTBOX EVENT — manual intervention required',
      `event_id:    ${event.id}`,
      `event_type:  ${event.event_type}`,
      `attempts:    ${event.attempts}`,
      `created_at:  ${event.created_at?.toISOString?.() ?? event.created_at}`,
      `last_error:  ${lastError}`,
      `payload:     ${JSON.stringify(event.payload)}`,
    ].join('\n');
  }
}
