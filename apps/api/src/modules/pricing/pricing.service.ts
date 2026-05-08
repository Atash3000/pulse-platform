import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { PricingRule } from '../../database/entities';

// =============================================================================
// PricingService
//
// SOLE OWNER of all financial calculation in the platform. No other module
// computes money. Ever.
//
// Hard rules:
//   - All values are integer cents. 650 = $6.50. NEVER float.
//   - Tax uses basis points: round(taxableCents * tax_rate_bps / 10000).
//     Convention: 1 bp = 0.01%, so 875 = 8.75%, 888 ≈ 8.875%.
//   - Tip applies to (subtotal + modifiers) only. Never on tax. Never on tip.
//   - Discounts apply to the tax base. Tax = (subtotal + modifiers - discount) * rate.
//   - All rounding uses Math.round (banker's rounding NOT used — match Stripe).
//
// This service has NO controller, NO endpoints. It is a pure dependency of
// CheckoutService and (later) RefundsService.
// =============================================================================

export interface CalculateOrderModifier {
  modifierId: string;
  name: string;
  /** Backend-sourced price. iOS-supplied prices are NEVER trusted. */
  priceCents: number;
}

export interface CalculateOrderItem {
  menuItemId: string;
  itemName: string;
  /** Backend-sourced base price. iOS-supplied prices are NEVER trusted. */
  unitPriceCents: number;
  quantity: number;
  modifiers: CalculateOrderModifier[];
}

export interface CalculateOrderParams {
  locationId: string;
  items: CalculateOrderItem[];
  /** Whole-percent integer (0, 15, 18, 20, 25 typical). */
  tipPercent: number;
  /** Optional integer cents discount. Reduces the tax base. */
  discountCents?: number;
}

export interface OrderCalculationDisplay {
  subtotal: string;
  modifier: string;
  discount: string;
  tax: string;
  tip: string;
  total: string;
}

export interface OrderCalculation {
  subtotalCents: number;
  modifierCents: number;
  discountCents: number;
  taxCents: number;
  tipCents: number;
  totalCents: number;
  display: OrderCalculationDisplay;
}

@Injectable()
export class PricingService {
  constructor(
    @InjectRepository(PricingRule)
    private readonly pricingRules: Repository<PricingRule>,
  ) {}

  /**
   * Calculates the full order math given backend-validated items.
   * Throws if no active pricing rule is configured for the location.
   */
  async calculateOrder(params: CalculateOrderParams): Promise<OrderCalculation> {
    if (params.items.length === 0) {
      throw new BadRequestException('Cart cannot be empty');
    }
    if (!Number.isInteger(params.tipPercent) || params.tipPercent < 0 || params.tipPercent > 100) {
      throw new BadRequestException('tipPercent must be an integer between 0 and 100');
    }
    const discountCents = params.discountCents ?? 0;
    if (!Number.isInteger(discountCents) || discountCents < 0) {
      throw new BadRequestException('discountCents must be a non-negative integer');
    }

    const rule = await this.getActiveRule(params.locationId);

    // ---- Sum subtotal and modifiers in pure integer arithmetic ------------
    let subtotalCents = 0;
    let modifierCents = 0;

    for (const item of params.items) {
      if (!Number.isInteger(item.quantity) || item.quantity < 1) {
        throw new BadRequestException(`Invalid quantity for item ${item.menuItemId}`);
      }
      if (!Number.isInteger(item.unitPriceCents) || item.unitPriceCents < 0) {
        throw new BadRequestException(`Invalid unit price for item ${item.menuItemId}`);
      }

      subtotalCents += item.unitPriceCents * item.quantity;

      let perUnitModifier = 0;
      for (const mod of item.modifiers) {
        if (!Number.isInteger(mod.priceCents) || mod.priceCents < 0) {
          throw new BadRequestException(`Invalid modifier price for ${mod.modifierId}`);
        }
        perUnitModifier += mod.priceCents;
      }
      modifierCents += perUnitModifier * item.quantity;
    }

    // ---- Discount cannot exceed (subtotal + modifiers) --------------------
    const preDiscount = subtotalCents + modifierCents;
    if (discountCents > preDiscount) {
      throw new BadRequestException('discountCents cannot exceed item total');
    }

    // ---- Tax: applied to (subtotal + modifiers - discount) ----------------
    const taxableCents = preDiscount - discountCents;
    const taxCents = Math.round((taxableCents * rule.tax_rate_bps) / 10000);

    // ---- Tip: subtotal + modifiers only. NEVER on tax. NEVER on discount. -
    const tipBaseCents = preDiscount;
    const tipCents = Math.round((tipBaseCents * params.tipPercent) / 100);

    const totalCents = taxableCents + taxCents + tipCents;

    return {
      subtotalCents,
      modifierCents,
      discountCents,
      taxCents,
      tipCents,
      totalCents,
      display: {
        subtotal: fmtCents(subtotalCents),
        modifier: fmtCents(modifierCents),
        discount: fmtCents(discountCents),
        tax: fmtCents(taxCents),
        tip: fmtCents(tipCents),
        total: fmtCents(totalCents),
      },
    };
  }

  /**
   * Validates that a tip percent is acceptable for this location.
   * 0 is always allowed (no tip). Otherwise must appear in pricing_rules.tip_options.
   * Throws BadRequestException with the allowed list if invalid.
   */
  async validateTipPercent(locationId: string, tipPercent: number): Promise<void> {
    if (tipPercent === 0) return;
    const rule = await this.getActiveRule(locationId);
    if (!rule.tip_options.includes(tipPercent)) {
      throw new BadRequestException(
        `tipPercent must be 0 or one of [${rule.tip_options.join(', ')}]`,
      );
    }
  }

  /**
   * Fetches the active pricing rule for a location. Exposed so CheckoutService
   * can pass the same rule into both validateTipPercent and calculateOrder
   * without two DB round trips. Internal callers can ignore it.
   */
  async getActiveRule(locationId: string): Promise<PricingRule> {
    const rule = await this.pricingRules.findOne({
      where: { location_id: locationId, active: true },
    });
    if (!rule) {
      throw new NotFoundException(`No active pricing rule configured for location ${locationId}`);
    }
    return rule;
  }
}

/** Format integer cents as "X.YY" — DISPLAY ONLY. Never charge from this. */
function fmtCents(cents: number): string {
  // Negative not expected in MVP, but `(- 50 / 100).toFixed(2)` returns "-0.50",
  // which is at least non-lossy.
  return (cents / 100).toFixed(2);
}
