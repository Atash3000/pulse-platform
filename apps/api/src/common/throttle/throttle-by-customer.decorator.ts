import { SetMetadata } from '@nestjs/common';

/** Metadata key marking a route as "throttle by authenticated customer id". */
export const THROTTLE_BY_CUSTOMER = 'throttle_by_customer';

/**
 * Marks a route so the global throttler keys its bucket by customer id instead
 * of IP — so customers behind one NAT/Wi-Fi IP don't share a rate-limit bucket.
 * Apply ONLY to customer-authenticated routes (e.g. checkout).
 */
export const ThrottleByCustomer = () => SetMetadata(THROTTLE_BY_CUSTOMER, true);
