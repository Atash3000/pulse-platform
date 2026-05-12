import {
  isPermanentApnsResponse,
  isPermanentTelegramStatus,
} from './notification-error-classifier';

// =============================================================================
// notification-error-classifier — pure-function unit tests. One assertion per
// error code branch keeps a regression that flips a verdict obvious in the
// failure output (the failing test name names the offending code).
// =============================================================================

describe('isPermanentTelegramStatus', () => {
  it('400 Bad Request → permanent (malformed body, retry will not help)', () => {
    expect(isPermanentTelegramStatus(400)).toBe(true);
  });

  it('401 Unauthorized → permanent (bot token revoked or wrong)', () => {
    expect(isPermanentTelegramStatus(401)).toBe(true);
  });

  it('403 Forbidden → permanent (bot blocked / kicked)', () => {
    expect(isPermanentTelegramStatus(403)).toBe(true);
  });

  it('404 Not Found → permanent (chat does not exist)', () => {
    expect(isPermanentTelegramStatus(404)).toBe(true);
  });

  it('429 Too Many Requests → transient (rate limited, retry later)', () => {
    expect(isPermanentTelegramStatus(429)).toBe(false);
  });

  it('500 Internal Server Error → transient', () => {
    expect(isPermanentTelegramStatus(500)).toBe(false);
  });

  it('502 Bad Gateway → transient', () => {
    expect(isPermanentTelegramStatus(502)).toBe(false);
  });

  it('503 Service Unavailable → transient', () => {
    expect(isPermanentTelegramStatus(503)).toBe(false);
  });

  it('description field is accepted but does not change classification', () => {
    expect(isPermanentTelegramStatus(400, 'Bad Request: chat not found')).toBe(true);
    expect(isPermanentTelegramStatus(503, 'temporary failure')).toBe(false);
  });
});

describe('isPermanentApnsResponse', () => {
  it('BadDeviceToken reason → permanent', () => {
    expect(isPermanentApnsResponse('BadDeviceToken')).toBe(true);
  });

  it('Unregistered reason → permanent', () => {
    expect(isPermanentApnsResponse('Unregistered')).toBe(true);
  });

  it('DeviceTokenNotForTopic reason → permanent (wrong bundle)', () => {
    expect(isPermanentApnsResponse('DeviceTokenNotForTopic')).toBe(true);
  });

  it('PayloadTooLarge reason → permanent (retrying same payload fails)', () => {
    expect(isPermanentApnsResponse('PayloadTooLarge')).toBe(true);
  });

  it('ExpiredProviderToken reason → permanent for this call (JWT refresh handled by library)', () => {
    expect(isPermanentApnsResponse('ExpiredProviderToken')).toBe(true);
  });

  it('TooManyRequests reason → transient (rate limit)', () => {
    expect(isPermanentApnsResponse('TooManyRequests')).toBe(false);
  });

  it('ServiceUnavailable reason → transient', () => {
    expect(isPermanentApnsResponse('ServiceUnavailable')).toBe(false);
  });

  it('InternalServerError reason → transient', () => {
    expect(isPermanentApnsResponse('InternalServerError')).toBe(false);
  });

  it('status 410 with empty reason → permanent (Apple Unregistered signal)', () => {
    // Older APNs payloads sometimes return 410 with reason === '' or
    // undefined. The classifier must treat 410 as permanent regardless
    // of reason for the Unregistered case.
    expect(isPermanentApnsResponse('', 410)).toBe(true);
    expect(isPermanentApnsResponse(undefined, 410)).toBe(true);
    expect(isPermanentApnsResponse(null, 410)).toBe(true);
  });

  it('status 410 with explicit Unregistered reason → permanent', () => {
    expect(isPermanentApnsResponse('Unregistered', 410)).toBe(true);
  });

  it('no reason and no status 410 → transient by default (network / unknown)', () => {
    expect(isPermanentApnsResponse(undefined)).toBe(false);
    expect(isPermanentApnsResponse('')).toBe(false);
    expect(isPermanentApnsResponse(null)).toBe(false);
  });

  it('unknown reason string → transient by default (fail-open to retry)', () => {
    // Conservative: an unrecognised reason should not silently mark
    // events as PROCESSED. Retrying is cheap; missing a notification is
    // not. The set of permanent reasons is allow-list, not deny-list.
    expect(isPermanentApnsResponse('SomeFutureReasonAppleAddsLater')).toBe(false);
  });
});
