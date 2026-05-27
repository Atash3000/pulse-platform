import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Customer, FeatureFlag, Location, Offer } from '../../database/entities';
import { resolveTimezone } from '../locations/hours-tz';
import { computeCelebrationState, labelForState } from './celebration-date';
import { ActiveRewardDto, CelebrationStateDto } from './dto/celebration-state.dto';

/** Feature flag gating the entire endpoint (Golden Rule #12). */
export const CELEBRATION_FLAG_KEY = 'birthday_celebration_state';

/** The safe default returned when the flag is off / customer is unknown. */
const NONE_STATE = (): CelebrationStateDto => new CelebrationStateDto('NONE', '', []);

/**
 * Reward types attached to a purchase (never standalone giveaways). Default is
 * `true` — a reward applies to an order, per the product rule.
 */
function requiresPurchaseForType(_type: string): boolean {
  return true;
}

/** Display title when an offer has no description of its own. */
function defaultTitleForType(type: string): string {
  if (type === 'birthday_drink') return 'Birthday drink — on us';
  return 'Reward';
}

/**
 * Computes the staff-facing celebration state for a customer. Read-only:
 * issues nothing, claims nothing, mutates nothing. The customer's date of
 * birth is read here and turned into a derived state — it never appears in the
 * returned DTO (see CelebrationStateDto).
 */
@Injectable()
export class CelebrationService {
  private readonly logger = new Logger(CelebrationService.name);

  constructor(
    @InjectRepository(Customer) private readonly customers: Repository<Customer>,
    @InjectRepository(Location) private readonly locations: Repository<Location>,
    @InjectRepository(Offer) private readonly offers: Repository<Offer>,
    @InjectRepository(FeatureFlag) private readonly flags: Repository<FeatureFlag>,
  ) {}

  /**
   * @param customerId   the customer the order is attached to
   * @param staffLocationId the staff member's location (from the JWT) — supplies
   *                        the store timezone for the date math
   * @param now           injected for deterministic tests; defaults to real time
   */
  async getCelebrationState(
    customerId: string,
    staffLocationId: string,
    now: Date = new Date(),
  ): Promise<CelebrationStateDto> {
    try {
      const flag = await this.flags.findOne({ where: { key: CELEBRATION_FLAG_KEY } });
      if (!flag?.enabled) return NONE_STATE();

      const customer = await this.customers.findOne({ where: { id: customerId } });
      // Unknown customer -> NONE, never 404: prevents customer-UUID enumeration.
      if (!customer) return NONE_STATE();

      const location = await this.locations.findOne({ where: { id: staffLocationId } });
      const { tz } = resolveTimezone(location?.timezone);

      const state = computeCelebrationState(customer.date_of_birth, now, tz);
      const label = labelForState(state);
      const active_rewards = await this.mapActiveRewards(customerId, now);

      return new CelebrationStateDto(state, label, active_rewards);
    } catch (err) {
      // Golden Rule #17 — a non-critical surface fails safe. This endpoint is
      // off the order/checkout path; a warm gesture is never worth a 500 to the
      // staff client. Degrade silently to NONE and log (Sentry, GR#10).
      this.logger.error(
        `[celebration] degraded to NONE for customer=${customerId}: ${String(err)}`,
      );
      return NONE_STATE();
    }
  }

  /**
   * Live rewards from the generic `offers` table: unredeemed, already sent, and
   * not past expiry. Independent of birthday state — a BIRTHDAY_TODAY customer
   * whose reward is already claimed correctly returns an empty array.
   *
   * Reality: nothing writes `offers` yet, so this is empty in practice. The
   * mapping + shape ship now; issuance is deferred.
   *
   * All liveness filtering is done in code (not a SQL `where`) so the single
   * predicate is unit-testable and lives in one place; per-customer offer rows
   * are few, so fetching by customer_id and filtering in memory is fine.
   */
  private async mapActiveRewards(customerId: string, now: Date): Promise<ActiveRewardDto[]> {
    const candidates = await this.offers.find({ where: { customer_id: customerId } });
    return candidates
      .filter(
        (o) => o.redeemed_at == null && o.sent_at != null && (o.expires_at == null || o.expires_at > now),
      )
      .map(
        (o) =>
          new ActiveRewardDto(
            o.id,
            o.type,
            o.description ?? defaultTitleForType(o.type),
            requiresPurchaseForType(o.type),
            o.expires_at ? o.expires_at.toISOString() : null,
          ),
      );
  }
}
