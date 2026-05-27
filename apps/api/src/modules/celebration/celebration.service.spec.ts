import { Customer, Location, Offer } from '../../database/entities';
import { CelebrationService, CELEBRATION_FLAG_KEY } from './celebration.service';

// Forbidden keys that must NEVER appear in the staff payload, at any depth.
// Includes snake_case + camelCase variants as defense against a future field
// being spread in under a different naming convention.
const FORBIDDEN_KEYS = [
  'birthday', 'date_of_birth', 'dateOfBirth', 'birth_date', 'birthDate',
  'age', 'year', 'birth_year', 'birthYear', 'dob',
];

function assertNoForbiddenKeys(value: unknown): void {
  const json = JSON.parse(JSON.stringify(value));
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
    } else if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        expect(FORBIDDEN_KEYS).not.toContain(k);
        walk(v);
      }
    }
  };
  walk(json);
}

function makeService(opts: {
  flagEnabled?: boolean;
  customer?: Partial<Customer> | null;
  location?: Partial<Location> | null;
  offers?: Partial<Offer>[];
}) {
  const flags = {
    findOne: jest.fn().mockResolvedValue({
      key: CELEBRATION_FLAG_KEY,
      enabled: opts.flagEnabled === undefined ? true : opts.flagEnabled,
    }),
  };
  const customers = { findOne: jest.fn().mockResolvedValue(opts.customer ?? null) };
  const locations = { findOne: jest.fn().mockResolvedValue(opts.location ?? { timezone: 'America/New_York' }) };
  const offersRepo = { find: jest.fn().mockResolvedValue(opts.offers ?? []) };

  const service = new CelebrationService(
    customers as never,
    locations as never,
    offersRepo as never,
    flags as never,
  );
  return { service, flags, customers, locations, offersRepo };
}

const TODAY = new Date('2026-05-26T16:00:00Z'); // May 26 in America/New_York

describe('CelebrationService.getCelebrationState', () => {
  it('returns NONE/empty when the feature flag is OFF, regardless of birthday', async () => {
    const { service, customers } = makeService({
      flagEnabled: false,
      customer: { id: 'c1', date_of_birth: '1990-05-26' },
    });
    const result = await service.getCelebrationState('c1', 'loc1', TODAY);
    expect(result).toEqual({ state: 'NONE', label: '', active_rewards: [] });
    expect(customers.findOne).not.toHaveBeenCalled();
  });

  it('birthday today, no live offers -> BIRTHDAY_TODAY + empty rewards', async () => {
    const { service } = makeService({
      customer: { id: 'c1', date_of_birth: '1990-05-26' },
      offers: [],
    });
    const result = await service.getCelebrationState('c1', 'loc1', TODAY);
    expect(result.state).toBe('BIRTHDAY_TODAY');
    expect(result.label).toBe('Birthday today 🎂');
    expect(result.active_rewards).toEqual([]);
  });

  it('maps a live birthday_drink offer into active_rewards', async () => {
    const expires = new Date('2026-05-30T23:59:59Z');
    const { service } = makeService({
      customer: { id: 'c1', date_of_birth: '1990-05-26' },
      offers: [
        { id: 'o1', type: 'birthday_drink', description: 'Birthday drink — on us',
          sent_at: new Date('2026-05-26T08:00:00Z'), redeemed_at: null, expires_at: expires },
      ],
    });
    const result = await service.getCelebrationState('c1', 'loc1', TODAY);
    expect(result.active_rewards).toEqual([
      {
        reward_id: 'o1',
        type: 'birthday_drink',
        title: 'Birthday drink — on us',
        requires_purchase: true,
        expires_at: expires.toISOString(),
      },
    ]);
  });

  it('excludes redeemed, expired, and unsent offers from active_rewards', async () => {
    const { service } = makeService({
      customer: { id: 'c1', date_of_birth: '1990-05-26' },
      offers: [
        { id: 'redeemed', type: 'birthday_drink', description: null,
          sent_at: new Date('2026-05-01T00:00:00Z'), redeemed_at: new Date('2026-05-02T00:00:00Z'), expires_at: null },
        { id: 'expired', type: 'birthday_drink', description: null,
          sent_at: new Date('2026-05-01T00:00:00Z'), redeemed_at: null, expires_at: new Date('2026-05-10T00:00:00Z') },
        { id: 'unsent', type: 'birthday_drink', description: null,
          sent_at: null, redeemed_at: null, expires_at: null },
      ],
    });
    const result = await service.getCelebrationState('c1', 'loc1', TODAY);
    expect(result.active_rewards).toEqual([]);
  });

  it('unknown customer -> NONE/empty, no throw (anti-enumeration)', async () => {
    const { service } = makeService({ customer: null });
    const result = await service.getCelebrationState('does-not-exist', 'loc1', TODAY);
    expect(result).toEqual({ state: 'NONE', label: '', active_rewards: [] });
  });

  it('degrades to NONE (never throws) when a DB lookup fails (Golden Rule #17)', async () => {
    const { service, customers } = makeService({ customer: { id: 'c1', date_of_birth: '1990-05-26' } });
    customers.findOne.mockRejectedValueOnce(new Error('db down'));
    const result = await service.getCelebrationState('c1', 'loc1', TODAY);
    expect(result).toEqual({ state: 'NONE', label: '', active_rewards: [] });
  });

  it('PRIVACY: payload contains no DOB/age/year key under any state', async () => {
    const today = await makeService({ customer: { id: 'c1', date_of_birth: '1990-05-26' } })
      .service.getCelebrationState('c1', 'loc1', TODAY);
    const thisWeek = await makeService({ customer: { id: 'c2', date_of_birth: '1990-05-29' } })
      .service.getCelebrationState('c2', 'loc1', TODAY);
    const none = await makeService({ customer: { id: 'c3', date_of_birth: null } })
      .service.getCelebrationState('c3', 'loc1', TODAY);

    expect(today.state).toBe('BIRTHDAY_TODAY');
    expect(thisWeek.state).toBe('BIRTHDAY_THIS_WEEK');
    expect(none.state).toBe('NONE');
    assertNoForbiddenKeys(today);
    assertNoForbiddenKeys(thisWeek);
    assertNoForbiddenKeys(none);
  });
});
