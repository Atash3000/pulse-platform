import { Location, LocationSettings } from '../../database/entities';
import { LocationsService } from './locations.service';

// =============================================================================
// LocationsService.listActive — the location LIST summary must expose
// current_wait_minutes (the same value PublicLocationDetail already surfaces
// from LocationSettings, default 5). The settings lookup must be batched —
// no per-location query (no N+1).
//
// NOTE: the real LocationsService constructor injects three repositories
// (locations, hours, settings) and the list method is `listActive()`, not
// `list()`. The plan's two-arg `new LocationsService(locRepo, settingsRepo)`
// and `list()` were adjusted to match the real code; the two assertions
// (value 4 from settings; default 5 when none) are unchanged in intent.
// =============================================================================

describe('LocationsService.listActive — currentWaitMinutes on summary', () => {
  function makeService(opts: { locations: Partial<Location>[]; settings: Partial<LocationSettings>[] }) {
    const locRepo = { find: jest.fn().mockResolvedValue(opts.locations) };
    const hoursRepo = { find: jest.fn().mockResolvedValue([]) };
    const settingsRepo = { find: jest.fn().mockResolvedValue(opts.settings) };
    return new LocationsService(locRepo as any, hoursRepo as any, settingsRepo as any);
  }

  it('uses the per-location current_wait_minutes when a settings row exists', async () => {
    const svc = makeService({
      locations: [{ id: 'loc-1', name: 'Maiden Ln', address: '100 Maiden Ln', phone: null, timezone: 'America/New_York' }],
      settings: [{ location_id: 'loc-1', current_wait_minutes: 4 } as Partial<LocationSettings>],
    });
    const out = await svc.listActive();
    expect(out[0].current_wait_minutes).toBe(4);
  });

  it('defaults current_wait_minutes to 5 when no settings row exists', async () => {
    const svc = makeService({
      locations: [{ id: 'loc-2', name: 'Broadway', address: '1 Broadway', phone: null, timezone: 'America/New_York' }],
      settings: [],
    });
    const out = await svc.listActive();
    expect(out[0].current_wait_minutes).toBe(5);
  });
});

describe('LocationsService — store status on payload', () => {
  const WEEK = [
    { day_of_week: 1, open_time: '07:00:00', close_time: '18:00:00', is_closed: false },
  ];
  function makeService(opts: { locations: any[]; hours: any[]; settings: any[] }) {
    const locRepo = { find: jest.fn().mockResolvedValue(opts.locations) };
    const hoursRepo = { find: jest.fn().mockResolvedValue(opts.hours) };
    const settingsRepo = { find: jest.fn().mockResolvedValue(opts.settings) };
    return { svc: new LocationsService(locRepo as any, hoursRepo as any, settingsRepo as any), hoursRepo };
  }

  it('includes status + next_transition_at + today fields on each summary, hours batch-loaded once', async () => {
    const { svc, hoursRepo } = makeService({
      locations: [{ id: 'loc-1', name: 'P', address: 'a', phone: null, timezone: 'America/New_York' }],
      hours: WEEK.map((h) => ({ ...h, location_id: 'loc-1' })),
      settings: [],
    });
    const out = await svc.listActive();
    expect(Object.keys(out[0])).toEqual(
      expect.arrayContaining(['status', 'next_transition_at', 'today_open', 'today_close']),
    );
    expect(hoursRepo.find).toHaveBeenCalledTimes(1);
  });
});
