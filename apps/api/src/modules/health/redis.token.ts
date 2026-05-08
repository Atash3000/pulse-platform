// Shared injection token for the ioredis client. Living in its own file so
// future modules (menu cache, idempotency cache) can import it without depending
// on HealthModule.
export const REDIS_CLIENT = Symbol('REDIS_CLIENT');
