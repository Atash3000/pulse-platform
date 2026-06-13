import { computeStoreStatus, HoursRow } from './store-status';

// All times are America/New_York. June 2026 is EDT (UTC-4).
const TZ = 'America/New_York';

// Mon–Fri 07:00–18:00, Sat 08:00–16:00, Sun closed (the seed schedule).
const WEEK: HoursRow[] = [
  { day_of_week: 0, open_time: '00:00:00', close_time: '00:00:00', is_closed: true },
  { day_of_week: 1, open_time: '07:00:00', close_time: '18:00:00', is_closed: false },
  { day_of_week: 2, open_time: '07:00:00', close_time: '18:00:00', is_closed: false },
  { day_of_week: 3, open_time: '07:00:00', close_time: '18:00:00', is_closed: false },
  { day_of_week: 4, open_time: '07:00:00', close_time: '18:00:00', is_closed: false },
  { day_of_week: 5, open_time: '07:00:00', close_time: '18:00:00', is_closed: false },
  { day_of_week: 6, open_time: '08:00:00', close_time: '16:00:00', is_closed: false },
];

// 2026-06-15 is a Monday. EDT = UTC-4, so NY 10:00 = 14:00Z.
const nyMondayAt = (hhmmZ: string) => new Date(`2026-06-15T${hhmmZ}:00Z`);

describe('computeStoreStatus', () => {
  it('returns null fields when the location has no hours', () => {
    expect(computeStoreStatus([], TZ, nyMondayAt('14:00'))).toEqual({
      status: null, next_transition_at: null, today_open: null, today_close: null,
    });
  });

  it('is open mid-day with the close-60m boundary as the next transition', () => {
    const r = computeStoreStatus(WEEK, TZ, nyMondayAt('14:00'));
    expect(r.status).toBe('open');
    expect(r.today_open).toBe('07:00');
    expect(r.today_close).toBe('18:00');
    expect(r.next_transition_at).toBe('2026-06-15T21:00:00.000Z'); // 17:00 NY
  });

  it('is closing_soon within 60 minutes of close, transition at close', () => {
    const r = computeStoreStatus(WEEK, TZ, nyMondayAt('21:30')); // 17:30 NY
    expect(r.status).toBe('closing_soon');
    expect(r.next_transition_at).toBe('2026-06-15T22:00:00.000Z'); // 18:00 NY
  });

  it('is closed before open, transition at today open', () => {
    const r = computeStoreStatus(WEEK, TZ, nyMondayAt('10:00')); // 06:00 NY
    expect(r.status).toBe('closed');
    expect(r.today_open).toBe('07:00');
    expect(r.next_transition_at).toBe('2026-06-15T11:00:00.000Z'); // 07:00 NY
  });

  it('is closed after close, transition at the next day open', () => {
    const r = computeStoreStatus(WEEK, TZ, nyMondayAt('23:00')); // 19:00 NY
    expect(r.status).toBe('closed');
    expect(r.next_transition_at).toBe('2026-06-16T11:00:00.000Z'); // Tue 07:00 NY
  });

  it('is closed all day on a closed day, today_open/close null, next open is the following day', () => {
    const sunNoon = new Date('2026-06-14T16:00:00Z'); // Sunday 12:00 NY
    const r = computeStoreStatus(WEEK, TZ, sunNoon);
    expect(r.status).toBe('closed');
    expect(r.today_open).toBeNull();
    expect(r.today_close).toBeNull();
    expect(r.next_transition_at).toBe('2026-06-15T11:00:00.000Z'); // Mon 07:00 NY
  });
});
