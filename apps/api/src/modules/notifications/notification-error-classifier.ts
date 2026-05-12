/**
 * Notification error classification — pure functions, no I/O.
 *
 * Two questions this module answers for the C8 delivery path:
 *
 *   isPermanentTelegramStatus(status, description?)
 *     Given an HTTP status code (and optional Telegram `description` field)
 *     from a `sendMessage` reply, is this error PERMANENT (retrying won't
 *     help — bad token, banned chat, malformed message) or TRANSIENT
 *     (5xx, rate-limited)? TelegramService logs+returns on permanent;
 *     throws on transient so the outbox retries toward DEAD.
 *
 *   isPermanentApnsResponse(reason, status?)
 *     Given a failed[] entry from `@parse/node-apn`'s send result, is
 *     this token-or-message permanently bad (BadDeviceToken, Unregistered,
 *     410) or transient (TooManyRequests, ServiceUnavailable)?
 *     PushNotificationService logs+returns on permanent; throws on
 *     transient.
 *
 * APNs note on 410: Apple's documentation marks status 410 as the
 * canonical signal that a token is "Unregistered" (uninstalled or
 * signed-out device). Older payload shapes can return status 410 with
 * an empty/missing `reason` string, so the classifier treats 410 as
 * permanent regardless of the reason value.
 *
 * Convention: "permanent" means "do not retry". The caller decides
 * whether to log at warn level and return (push/telegram) or do
 * additional work (e.g., writeback push_token=null for BadDeviceToken,
 * deferred per C8 decision-log entry).
 */

const PERMANENT_TELEGRAM_STATUSES: ReadonlySet<number> = new Set([
  400, // Bad Request — malformed message body, chat_id, parse mode errors
  401, // Unauthorized — bot token is wrong/revoked
  403, // Forbidden — bot was blocked by the user / kicked from the chat
  404, // Not Found — chat_id does not resolve to a real chat
]);

/**
 * Returns true if the given Telegram Bot API response indicates a
 * permanent failure (retrying won't help).
 *
 * Status codes are the HTTP code from the `sendMessage` POST. The
 * optional `description` is the JSON `description` field Telegram
 * returns alongside `ok: false`; reserved for future-proofing against
 * a permanent error that surfaces as 200-with-ok-false (Telegram's
 * documented protocol uses 4xx for errors, but the parameter is here
 * so a callsite can pass description for log enrichment without
 * changing this function's shape).
 */
export function isPermanentTelegramStatus(
  status: number,
  _description?: string,
): boolean {
  return PERMANENT_TELEGRAM_STATUSES.has(status);
}

const PERMANENT_APNS_REASONS: ReadonlySet<string> = new Set([
  'BadDeviceToken',
  'Unregistered',
  'DeviceTokenNotForTopic',
  'BadCertificate',
  'BadCertificateEnvironment',
  'ExpiredProviderToken',
  'InvalidProviderToken',
  'MissingProviderToken',
  'BadTopic',
  'TopicDisallowed',
  'MissingDeviceToken',
  'PayloadTooLarge',
  'BadMessageId',
  'BadExpirationDate',
  'BadPriority',
  'BadCollapseId',
  'IdleTimeout', // permanent in the sense that no retry will revive a dead stream
]);

/**
 * Returns true if the APNs failure indicates a permanent token/message
 * error.
 *
 * Apple uses HTTP status 410 as the canonical "Unregistered" signal —
 * the token has been invalidated by iOS (app uninstalled, signed out,
 * etc.). Some payloads return 410 with `reason === ''` or undefined;
 * treat 410 as permanent regardless of reason.
 *
 * Everything else (TooManyRequests, ServiceUnavailable, InternalServerError,
 * Shutdown, network errors with no reason) is treated as transient — the
 * caller throws so the outbox retries.
 */
export function isPermanentApnsResponse(
  reason: string | undefined | null,
  status?: number,
): boolean {
  if (status === 410) return true;
  if (typeof reason !== 'string' || reason.length === 0) return false;
  return PERMANENT_APNS_REASONS.has(reason);
}
