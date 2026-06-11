import { PaymentStatus } from '../../database/entities';
import { HomeService } from './home.service';

type FakeItem = {
  menu_item_id: string;
  quantity: number;
  unit_price_cents: number;
  modifiers: { modifierId: string; name: string; priceCents: number }[];
  order: { created_at: Date };
};

function makeService(items: FakeItem[]) {
  const qb: any = {
    innerJoinAndSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue(items),
  };
  const repo = { createQueryBuilder: jest.fn().mockReturnValue(qb) };
  return { service: new HomeService(repo as any), qb };
}

const d = (iso: string) => new Date(iso);
const item = (id: string, mods: string[], price: number, at: string, qty = 1): FakeItem => ({
  menu_item_id: id,
  quantity: qty,
  unit_price_cents: price,
  modifiers: mods.map((m) => ({ modifierId: m, name: m, priceCents: 0 })),
  order: { created_at: d(at) },
});

describe('HomeService.getHomeSummary', () => {
  it('returns null usual and empty recent when the customer has no paid items', async () => {
    const { service } = makeService([]);
    const out = await service.getHomeSummary('cust-1');
    expect(out).toEqual({ usual: null, recent: [] });
  });

  it('picks the most-frequent config as usual', async () => {
    const { service } = makeService([
      item('latte', [], 525, '2026-06-01'),
      item('matcha', [], 645, '2026-06-02'),
      item('latte', [], 525, '2026-06-03'),
      item('latte', [], 525, '2026-06-04'),
    ]);
    const out = await service.getHomeSummary('cust-1');
    expect(out.usual).toEqual({ menuItemId: 'latte', modifierIds: [], quantity: 1, lastUnitPriceCents: 525 });
    expect(out.recent.map((r) => r.menuItemId)).toEqual(['matcha']);
  });

  it('treats modifier order as irrelevant (set equality) when grouping', async () => {
    const { service } = makeService([
      item('matcha', ['oat', 'lightIce'], 645, '2026-06-01'),
      item('matcha', ['lightIce', 'oat'], 645, '2026-06-05'),
    ]);
    const out = await service.getHomeSummary('cust-1');
    expect(out.usual).toEqual({ menuItemId: 'matcha', modifierIds: ['lightIce', 'oat'], quantity: 1, lastUnitPriceCents: 645 });
    expect(out.recent).toEqual([]);
  });

  it('breaks frequency ties by most-recent and uses the most-recent price + quantity', async () => {
    const { service } = makeService([
      item('latte', [], 500, '2026-06-01', 1),
      item('mocha', [], 600, '2026-06-02', 1),
      item('latte', [], 550, '2026-06-10', 2),
    ]);
    const out = await service.getHomeSummary('cust-1');
    expect(out.usual).toEqual({ menuItemId: 'latte', modifierIds: [], quantity: 2, lastUnitPriceCents: 550 });
  });

  it('caps recent to RECENT_LIMIT distinct configs', async () => {
    const many: FakeItem[] = [];
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) many.push(item(id, [], 100, '2026-06-0' + (many.length + 1)));
    const { service } = makeService(many);
    const out = await service.getHomeSummary('cust-1');
    expect(out.recent.length).toBe(4);
  });

  it('filters to PAID orders only via the query', async () => {
    const { service, qb } = makeService([item('latte', [], 525, '2026-06-01')]);
    await service.getHomeSummary('cust-1');
    const andWhereCalls = qb.andWhere.mock.calls.flat();
    expect(andWhereCalls.some((c: string) => typeof c === 'string' && c.includes('payment_status'))).toBe(true);
  });
});
