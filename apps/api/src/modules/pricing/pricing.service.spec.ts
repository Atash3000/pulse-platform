import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { PricingRule } from '../../database/entities';
import { CalculateOrderItem, PricingService } from './pricing.service';

const LOC = '837ea20e-1a21-4d08-8833-daa4719a8ba6';

interface RuleOverrides {
  tax_rate_bps?: number;
  tip_options?: number[];
  active?: boolean;
}

const buildRule = (o: RuleOverrides = {}): PricingRule =>
  ({
    id: 'rule-id',
    location_id: LOC,
    tax_rate_bps: o.tax_rate_bps ?? 888,        // ~8.875% NYC
    tip_options: o.tip_options ?? [15, 18, 20, 25],
    active: o.active ?? true,
    updated_at: new Date(),
  }) as unknown as PricingRule;

const item = (overrides: Partial<CalculateOrderItem> = {}): CalculateOrderItem => ({
  menuItemId: overrides.menuItemId ?? 'item-1',
  itemName: overrides.itemName ?? 'Oat Milk Latte',
  unitPriceCents: overrides.unitPriceCents ?? 650,
  quantity: overrides.quantity ?? 1,
  modifiers: overrides.modifiers ?? [],
});

describe('PricingService', () => {
  let service: PricingService;
  let findOne: jest.Mock;

  beforeEach(async () => {
    findOne = jest.fn().mockResolvedValue(buildRule());
    const moduleRef = await Test.createTestingModule({
      providers: [
        PricingService,
        { provide: getRepositoryToken(PricingRule), useValue: { findOne } },
      ],
    }).compile();
    service = moduleRef.get(PricingService);
  });

  // ---------------------------------------------------------------------------
  // Required cases (per build instruction):
  //   zero tip, standard tip, tax rounding with bps, modifier addition, discount
  // ---------------------------------------------------------------------------

  describe('zero tip', () => {
    it('produces no tip cents when tipPercent=0', async () => {
      findOne.mockResolvedValueOnce(buildRule({ tax_rate_bps: 0 }));
      const result = await service.calculateOrder({
        locationId: LOC,
        items: [item({ unitPriceCents: 650 })],
        tipPercent: 0,
      });
      expect(result.subtotalCents).toBe(650);
      expect(result.tipCents).toBe(0);
      expect(result.taxCents).toBe(0);
      expect(result.totalCents).toBe(650);
      expect(result.display.total).toBe('6.50');
    });
  });

  describe('standard tip', () => {
    it('18% tip on $6.50 = 117 cents', async () => {
      findOne.mockResolvedValueOnce(buildRule({ tax_rate_bps: 0 }));
      const result = await service.calculateOrder({
        locationId: LOC,
        items: [item({ unitPriceCents: 650 })],
        tipPercent: 18,
      });
      // 650 * 18 / 100 = 117
      expect(result.tipCents).toBe(117);
      expect(result.totalCents).toBe(650 + 117);
    });

    it('does NOT include tax in tip base', async () => {
      // tax 8.88% + 18% tip on $6.50
      const r = await service.calculateOrder({
        locationId: LOC,
        items: [item({ unitPriceCents: 650 })],
        tipPercent: 18,
      });
      expect(r.taxCents).toBe(58); // round(650 * 888 / 10000) = 57.72 -> 58
      // tip is on subtotal+modifiers (650), NOT on (650+58)
      expect(r.tipCents).toBe(117); // 650 * 18 / 100 = 117
      // would be 650*888/10000 + 18%*(650+58) = 58 + 127 = 185 if tip-on-tax
      expect(r.totalCents).toBe(650 + 58 + 117);
    });

    it('does NOT include discount in tip base', async () => {
      const r = await service.calculateOrder({
        locationId: LOC,
        items: [item({ unitPriceCents: 1000 })],
        tipPercent: 20,
        discountCents: 200,
      });
      // tip is on (subtotal + modifiers) = 1000, not (1000 - 200)
      expect(r.tipCents).toBe(200); // 1000 * 20 / 100
    });
  });

  describe('tax rounding with basis points', () => {
    it('875 bps on $6.50 → 57 cents (round half up: 56.875 → 57)', async () => {
      findOne.mockResolvedValueOnce(buildRule({ tax_rate_bps: 875 }));
      const r = await service.calculateOrder({
        locationId: LOC,
        items: [item({ unitPriceCents: 650 })],
        tipPercent: 0,
      });
      // 650 * 875 / 10000 = 56.875 → Math.round = 57
      expect(r.taxCents).toBe(57);
    });

    it('888 bps on $6.50 → 58 cents (57.72 → 58)', async () => {
      const r = await service.calculateOrder({
        locationId: LOC,
        items: [item({ unitPriceCents: 650 })],
        tipPercent: 0,
      });
      expect(r.taxCents).toBe(58);
    });

    it('0 bps yields 0 tax', async () => {
      findOne.mockResolvedValueOnce(buildRule({ tax_rate_bps: 0 }));
      const r = await service.calculateOrder({
        locationId: LOC,
        items: [item({ unitPriceCents: 12345 })],
        tipPercent: 0,
      });
      expect(r.taxCents).toBe(0);
    });

    it('produces same cents result regardless of where rounding lands (no float drift)', async () => {
      findOne.mockResolvedValueOnce(buildRule({ tax_rate_bps: 875 }));
      // 1 cent * 875 / 10000 = 0.0875 → round = 0
      const r = await service.calculateOrder({
        locationId: LOC,
        items: [item({ unitPriceCents: 1 })],
        tipPercent: 0,
      });
      expect(r.taxCents).toBe(0);
    });
  });

  describe('modifier price addition', () => {
    it('sums modifier prices into modifierCents and into the tax/tip bases', async () => {
      findOne.mockResolvedValueOnce(buildRule({ tax_rate_bps: 1000 })); // 10% flat
      const r = await service.calculateOrder({
        locationId: LOC,
        items: [
          item({
            unitPriceCents: 500,
            quantity: 1,
            modifiers: [
              { modifierId: 'm1', name: 'Oat Milk', priceCents: 50 },
              { modifierId: 'm2', name: 'Extra Shot', priceCents: 100 },
            ],
          }),
        ],
        tipPercent: 20,
      });
      expect(r.subtotalCents).toBe(500);
      expect(r.modifierCents).toBe(150);
      // tax = (500 + 150) * 10% = 65
      expect(r.taxCents).toBe(65);
      // tip = (500 + 150) * 20% = 130
      expect(r.tipCents).toBe(130);
      // total = 500 + 150 + 65 + 130 = 845
      expect(r.totalCents).toBe(845);
    });

    it('multiplies modifier price by quantity', async () => {
      findOne.mockResolvedValueOnce(buildRule({ tax_rate_bps: 0 }));
      const r = await service.calculateOrder({
        locationId: LOC,
        items: [
          item({
            unitPriceCents: 600,
            quantity: 3,
            modifiers: [{ modifierId: 'm1', name: 'Large', priceCents: 100 }],
          }),
        ],
        tipPercent: 0,
      });
      expect(r.subtotalCents).toBe(1800); // 600 * 3
      expect(r.modifierCents).toBe(300); // 100 * 3
      expect(r.totalCents).toBe(2100);
    });
  });

  describe('discount application', () => {
    it('reduces the tax base but NOT the tip base', async () => {
      findOne.mockResolvedValueOnce(buildRule({ tax_rate_bps: 1000 })); // 10%
      const r = await service.calculateOrder({
        locationId: LOC,
        items: [item({ unitPriceCents: 1000 })],
        tipPercent: 20,
        discountCents: 200,
      });
      expect(r.subtotalCents).toBe(1000);
      expect(r.discountCents).toBe(200);
      // taxable = 1000 - 200 = 800; tax = 80
      expect(r.taxCents).toBe(80);
      // tip on (subtotal+modifiers) = 1000, not 800
      expect(r.tipCents).toBe(200);
      // total = 1000 - 200 + 80 + 200 = 1080
      expect(r.totalCents).toBe(1080);
    });

    it('rejects discount greater than (subtotal + modifiers)', async () => {
      await expect(
        service.calculateOrder({
          locationId: LOC,
          items: [item({ unitPriceCents: 100 })],
          tipPercent: 0,
          discountCents: 200,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('discount of 0 is a no-op (default)', async () => {
      findOne.mockResolvedValueOnce(buildRule({ tax_rate_bps: 0 }));
      const r = await service.calculateOrder({
        locationId: LOC,
        items: [item({ unitPriceCents: 500 })],
        tipPercent: 0,
      });
      expect(r.discountCents).toBe(0);
      expect(r.totalCents).toBe(500);
    });
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  describe('input validation', () => {
    it('rejects empty cart', async () => {
      await expect(
        service.calculateOrder({ locationId: LOC, items: [], tipPercent: 0 }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects negative tip', async () => {
      await expect(
        service.calculateOrder({
          locationId: LOC,
          items: [item()],
          tipPercent: -5,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects non-integer quantity', async () => {
      await expect(
        service.calculateOrder({
          locationId: LOC,
          items: [item({ quantity: 1.5 })],
          tipPercent: 0,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws NotFoundException when no active pricing rule exists', async () => {
      findOne.mockResolvedValueOnce(null);
      await expect(
        service.calculateOrder({
          locationId: LOC,
          items: [item()],
          tipPercent: 0,
        }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('validateTipPercent', () => {
    it('always allows 0', async () => {
      await expect(service.validateTipPercent(LOC, 0)).resolves.toBeUndefined();
      // Should NOT have hit the database for the 0 case
      expect(findOne).not.toHaveBeenCalled();
    });

    it('allows percentages in tip_options', async () => {
      await expect(service.validateTipPercent(LOC, 20)).resolves.toBeUndefined();
    });

    it('rejects percentages not in tip_options', async () => {
      await expect(service.validateTipPercent(LOC, 13)).rejects.toThrow(BadRequestException);
    });

    it('throws when no rule exists for location', async () => {
      findOne.mockResolvedValueOnce(null);
      await expect(service.validateTipPercent(LOC, 18)).rejects.toThrow(NotFoundException);
    });
  });

  describe('display formatting', () => {
    it('formats integer cents as "X.YY"', async () => {
      const r = await service.calculateOrder({
        locationId: LOC,
        items: [item({ unitPriceCents: 650 })],
        tipPercent: 18,
      });
      expect(r.display.subtotal).toBe('6.50');
      expect(r.display.tax).toBe('0.58');
      expect(r.display.tip).toBe('1.17');
      expect(r.display.total).toBe('8.25');
    });
  });
});
