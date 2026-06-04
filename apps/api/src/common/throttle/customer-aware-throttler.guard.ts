import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

import { THROTTLE_BY_CUSTOMER } from './throttle-by-customer.decorator';

/**
 * Decodes (does NOT verify) the JWT in an Authorization header and returns its
 * `sub` iff it is a customer token. Used only to build a throttle bucket key —
 * the route's AuthGuard still verifies and rejects bad tokens downstream.
 */
export function customerSubFromAuthHeader(header: unknown): string | null {
  if (typeof header !== 'string') return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const parts = match[1].split('.');
  if (parts.length < 2) return null;
  try {
    const json = Buffer.from(parts[1], 'base64url').toString('utf8');
    // Only the scalar `sub`/`type` are read below — the parsed object is never
    // spread/merged, so a hostile `__proto__` key in the payload is inert. Keep it that way.
    const payload = JSON.parse(json) as { sub?: unknown; type?: unknown };
    if (payload.type === 'customer' && typeof payload.sub === 'string' && payload.sub.length > 0) {
      return payload.sub;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Global throttler guard that keys routes marked with @ThrottleByCustomer() by
 * customer id, and every other route by IP (unchanged base behaviour).
 *
 * Why decode the header instead of using req.user: the global guard runs BEFORE
 * the controller's AuthGuard, so req.user is not populated yet (verified against
 * @nestjs/throttler@5.2.0, whose getTracker only receives `req`).
 */
@Injectable()
export class CustomerAwareThrottlerGuard extends ThrottlerGuard {
  // getRequestResponse is the one override with the ExecutionContext that also
  // returns the req getTracker will receive — stash the per-route flag here.
  protected getRequestResponse(context: ExecutionContext) {
    const result = super.getRequestResponse(context);
    const byCustomer = this.reflector.getAllAndOverride<boolean>(THROTTLE_BY_CUSTOMER, [
      context.getHandler(),
      context.getClass(),
    ]);
    (result.req as Record<string, unknown>).__throttleByCustomer = byCustomer === true;
    return result;
  }

  protected async getTracker(req: Record<string, any>): Promise<string> {
    const ips = req.ips as string[] | undefined;
    const ip = ips && ips.length > 0 ? ips[0] : req.ip;
    if (req.__throttleByCustomer === true) {
      const sub = customerSubFromAuthHeader(req.headers?.authorization);
      // Composite customer+IP key. The `sub` comes from an UNVERIFIED token
      // (the AuthGuard verifies later), so binding the bucket to the request
      // IP too means a forged-sub request can only ever land in the attacker's
      // own IP bucket — it cannot deny a different customer (on a different IP)
      // their checkout. Honest customers behind one NAT still get independent
      // buckets because their `sub` differs.
      if (sub) return `customer:${sub}|${ip}`;
    }
    return ip;
  }
}
