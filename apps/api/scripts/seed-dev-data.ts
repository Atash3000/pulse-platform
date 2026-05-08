/**
 * seed-dev-data.ts
 *
 * Idempotent dev seed. Creates one predictable Pulse Coffee location, its
 * 7-day hours, its settings, and a pricing rule. Safe to run multiple times.
 *
 * Run with: npm run seed:dev
 */

import 'reflect-metadata';
import { AppDataSource } from '../src/database/data-source';
import {
  Location,
  LocationHours,
  LocationSettings,
  PricingRule,
} from '../src/database/entities';

const LOCATION = {
  name: 'Pulse Coffee — Main St',
  address: '123 Main Street, New York, NY 10001',
  timezone: 'America/New_York',
  phone: null as string | null,
} as const;

// 0=Sun, 1=Mon, ..., 6=Sat — matches the spec's location_hours.day_of_week.
const HOURS: Array<{ day_of_week: number; open_time: string; close_time: string; is_closed: boolean }> = [
  { day_of_week: 1, open_time: '07:00', close_time: '18:00', is_closed: false }, // Mon
  { day_of_week: 2, open_time: '07:00', close_time: '18:00', is_closed: false }, // Tue
  { day_of_week: 3, open_time: '07:00', close_time: '18:00', is_closed: false }, // Wed
  { day_of_week: 4, open_time: '07:00', close_time: '18:00', is_closed: false }, // Thu
  { day_of_week: 5, open_time: '07:00', close_time: '18:00', is_closed: false }, // Fri
  { day_of_week: 6, open_time: '08:00', close_time: '16:00', is_closed: false }, // Sat
  { day_of_week: 0, open_time: '00:00', close_time: '00:00', is_closed: true  }, // Sun closed
];

const SETTINGS = {
  mobile_ordering_paused: false,
  current_wait_minutes: 5,
  scheduled_ordering: true,
  max_schedule_days: 7,
} as const;

const PRICING = {
  // 888 bps with the spec's formula (round(taxable * bps / 10000)) yields
  // 8.88% — the integer rounding of NYC's 8.875% combined sales tax.
  // Convention: 1 basis point = 0.01%. So 875 = 8.75%, 888 ≈ 8.875%.
  tax_rate_bps: 888,
  tip_options: [15, 18, 20, 25],
} as const;

interface Counts {
  inserted: number;
  updated: number;
}

async function run(): Promise<void> {
  await AppDataSource.initialize();
  const totals: Counts = { inserted: 0, updated: 0 };

  await AppDataSource.transaction(async (em) => {
    // ---- locations -------------------------------------------------------
    // Idempotency key: name. (Locations don't have a natural FK-friendly key
    // in the schema, so we de-dup by name within the dev seed.)
    const locationRepo = em.getRepository(Location);
    let location = await locationRepo.findOne({ where: { name: LOCATION.name } });
    if (location) {
      location.address = LOCATION.address;
      location.phone = LOCATION.phone;
      location.timezone = LOCATION.timezone;
      location.active = true;
      location = await locationRepo.save(location);
      totals.updated += 1;
    } else {
      location = await locationRepo.save(
        locationRepo.create({
          name: LOCATION.name,
          address: LOCATION.address,
          phone: LOCATION.phone,
          timezone: LOCATION.timezone,
          active: true,
        }),
      );
      totals.inserted += 1;
    }

    // ---- hours ----------------------------------------------------------
    // Day-of-week is unique per location (enforced in spirit, not by index).
    // Upsert one row per (location, day_of_week).
    const hoursRepo = em.getRepository(LocationHours);
    for (const h of HOURS) {
      const existing = await hoursRepo.findOne({
        where: { location_id: location.id, day_of_week: h.day_of_week },
      });
      if (existing) {
        existing.open_time = h.open_time;
        existing.close_time = h.close_time;
        existing.is_closed = h.is_closed;
        await hoursRepo.save(existing);
        totals.updated += 1;
      } else {
        await hoursRepo.save(
          hoursRepo.create({
            location_id: location.id,
            day_of_week: h.day_of_week,
            open_time: h.open_time,
            close_time: h.close_time,
            is_closed: h.is_closed,
          }),
        );
        totals.inserted += 1;
      }
    }

    // ---- settings -------------------------------------------------------
    // location_settings has a 1:1 relation keyed by location_id.
    const settingsRepo = em.getRepository(LocationSettings);
    const existingSettings = await settingsRepo.findOne({ where: { location_id: location.id } });
    if (existingSettings) {
      existingSettings.mobile_ordering_paused = SETTINGS.mobile_ordering_paused;
      existingSettings.current_wait_minutes = SETTINGS.current_wait_minutes;
      existingSettings.scheduled_ordering = SETTINGS.scheduled_ordering;
      existingSettings.max_schedule_days = SETTINGS.max_schedule_days;
      await settingsRepo.save(existingSettings);
      totals.updated += 1;
    } else {
      await settingsRepo.save(
        settingsRepo.create({
          location_id: location.id,
          ...SETTINGS,
        }),
      );
      totals.inserted += 1;
    }

    // ---- pricing rule ---------------------------------------------------
    // One ACTIVE rule per location is the convention. Find by (location, active),
    // upsert. Inactive historical rules are left alone for audit.
    const pricingRepo = em.getRepository(PricingRule);
    const existingRule = await pricingRepo.findOne({
      where: { location_id: location.id, active: true },
    });
    if (existingRule) {
      existingRule.tax_rate_bps = PRICING.tax_rate_bps;
      existingRule.tip_options = [...PRICING.tip_options];
      await pricingRepo.save(existingRule);
      totals.updated += 1;
    } else {
      await pricingRepo.save(
        pricingRepo.create({
          location_id: location.id,
          tax_rate_bps: PRICING.tax_rate_bps,
          tip_options: [...PRICING.tip_options],
          active: true,
        }),
      );
      totals.inserted += 1;
    }

    // eslint-disable-next-line no-console
    console.log(`seed:dev → location_id=${location.id}`);
  });

  // eslint-disable-next-line no-console
  console.log(`seed:dev complete — inserted=${totals.inserted} updated=${totals.updated}`);

  await AppDataSource.destroy();
}

run().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('seed:dev failed:', err);
  process.exit(1);
});
