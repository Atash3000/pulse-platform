import { BadRequestException } from '@nestjs/common';
import { AdminHoursService } from './admin-hours.service';

const STAFF = { staff_user_id: 's1', location_id: 'loc-1', role: 'OWNER' };
const fullWeek = (overrides: any[] = []) => {
  const base = Array.from({ length: 7 }, (_, d) => ({
    day_of_week: d, open_time: '07:00', close_time: '18:00', is_closed: false,
  }));
  for (const o of overrides) base[o.day_of_week] = { ...base[o.day_of_week], ...o };
  return base;
};

function makeService() {
  const saved: any[] = [];
  const manager = {
    delete: jest.fn().mockResolvedValue({}),
    insert: jest.fn().mockImplementation((_e, rows) => { saved.push(...rows); return {}; }),
    find: jest.fn().mockImplementation(async () => saved),
  };
  const ds = { transaction: jest.fn().mockImplementation(async (cb: any) => cb(manager)) };
  return { service: new AdminHoursService(ds as any), manager, saved };
}

describe('AdminHoursService.setHours', () => {
  it('replaces all hours for the staff location in a transaction', async () => {
    const { service, manager } = makeService();
    await service.setHours(STAFF as any, { hours: fullWeek() });
    expect(manager.delete).toHaveBeenCalledWith(expect.anything(), { location_id: 'loc-1' });
    expect(manager.insert).toHaveBeenCalledTimes(1);
    const inserted = manager.insert.mock.calls[0][1];
    expect(inserted).toHaveLength(7);
    expect(inserted.every((r: any) => r.location_id === 'loc-1')).toBe(true);
  });

  it('rejects a missing/duplicate day (must cover 0–6 exactly once)', async () => {
    const { service } = makeService();
    const dupSunday = fullWeek().map((h, i) => (i === 6 ? { ...h, day_of_week: 0 } : h));
    await expect(service.setHours(STAFF as any, { hours: dupSunday })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects open_time >= close_time on an operating day', async () => {
    const { service } = makeService();
    const bad = fullWeek([{ day_of_week: 1, open_time: '18:00', close_time: '07:00', is_closed: false }]);
    await expect(service.setHours(STAFF as any, { hours: bad })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('allows open == close when the day is closed', async () => {
    const { service } = makeService();
    const week = fullWeek([{ day_of_week: 0, open_time: '00:00', close_time: '00:00', is_closed: true }]);
    await expect(service.setHours(STAFF as any, { hours: week })).resolves.toBeDefined();
  });
});
