import { Reflector } from '@nestjs/core';

import { CustomerAwareThrottlerGuard, customerSubFromAuthHeader } from './customer-aware-throttler.guard';

function bearerFor(payload: object): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `Bearer header.${body}.sig`;
}

describe('customerSubFromAuthHeader', () => {
  it('returns sub for a customer token', () => {
    expect(customerSubFromAuthHeader(bearerFor({ sub: 'cust-1', type: 'customer' }))).toBe('cust-1');
  });

  it('returns null for a non-customer token (e.g. staff)', () => {
    expect(customerSubFromAuthHeader(bearerFor({ sub: 'staff-1', type: 'staff' }))).toBeNull();
  });

  it('returns null for garbage / missing header', () => {
    expect(customerSubFromAuthHeader('Bearer not-a-jwt')).toBeNull();
    expect(customerSubFromAuthHeader(undefined)).toBeNull();
  });
});

describe('CustomerAwareThrottlerGuard.getTracker', () => {
  const guard = new CustomerAwareThrottlerGuard({ throttlers: [] } as never, {} as never, new Reflector());
  const track = (req: Record<string, unknown>) =>
    (guard as unknown as { getTracker(r: Record<string, unknown>): Promise<string> }).getTracker(req);

  it('keys by customer sub when the route opted in', async () => {
    const req = { __throttleByCustomer: true, headers: { authorization: bearerFor({ sub: 'cust-9', type: 'customer' }) }, ip: '1.2.3.4' };
    await expect(track(req)).resolves.toBe('customer:cust-9|1.2.3.4');
  });

  it('gives two customers behind one IP independent keys', async () => {
    const a = { __throttleByCustomer: true, headers: { authorization: bearerFor({ sub: 'A', type: 'customer' }) }, ip: '1.2.3.4' };
    const b = { __throttleByCustomer: true, headers: { authorization: bearerFor({ sub: 'B', type: 'customer' }) }, ip: '1.2.3.4' };
    expect(await track(a)).not.toBe(await track(b));
  });

  it('falls back to IP when the route did not opt in', async () => {
    const req = { headers: { authorization: bearerFor({ sub: 'cust-1', type: 'customer' }) }, ip: '9.9.9.9' };
    await expect(track(req)).resolves.toBe('9.9.9.9');
  });

  it('a forged victim sub from a different IP does NOT collide with the victims real-IP bucket', async () => {
    const victimReal = { __throttleByCustomer: true, headers: { authorization: bearerFor({ sub: 'V', type: 'customer' }) }, ip: '10.0.0.1' };
    const attackerForging = { __throttleByCustomer: true, headers: { authorization: bearerFor({ sub: 'V', type: 'customer' }) }, ip: '203.0.113.9' };
    expect(await track(victimReal)).not.toBe(await track(attackerForging));
  });

  it('opted-in route with a malformed Authorization header falls back to IP', async () => {
    const req = { __throttleByCustomer: true, headers: { authorization: 'Bearer not-a-jwt' }, ip: '7.7.7.7' };
    await expect(track(req)).resolves.toBe('7.7.7.7');
  });
});
