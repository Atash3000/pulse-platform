/**
 * Pure formatters for Telegram alert message bodies (Spec Part 9).
 *
 * Separated from `TelegramService` so each formatter can be unit-tested in
 * isolation against its edge cases without standing up the full service +
 * its `ConfigService` dependency. The service composes these into the
 * Part 9 message strings.
 *
 * All formatters are SYNCHRONOUS, PURE, and have no I/O — easy to test,
 * easy to reason about, easy to swap when the message templates evolve.
 */

/**
 * "Sarah Mitchell" → "Sarah M."
 *
 *   - Single-word names ("Madonna") return as-is — no last initial to add.
 *   - Three-or-more-word names abbreviate the last word: "Mary Jane Watson"
 *     → "Mary Jane W.".
 *   - Empty / whitespace-only input returns an empty string. The caller
 *     (currently always one of the C1 handlers via C4/C5 wiring) is
 *     responsible for ensuring a non-empty name reaches this formatter,
 *     since the `customers.full_name` column is NOT NULL at the schema
 *     level. Returning empty rather than throwing keeps the formatter
 *     contract simple and prevents notifications from crashing on a
 *     malformed input — the resulting alert message would have a missing
 *     name slot, which is operator-visible but non-fatal.
 */
export function formatCustomerName(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter((p) => p.length > 0);
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0]!;
  const last = parts[parts.length - 1]!;
  const prefix = parts.slice(0, -1).join(' ');
  return `${prefix} ${last[0]!}.`;
}

/**
 * Integer cents → USD with two decimals.
 *
 *   1000 → "$10.00"
 *      0 → "$0.00"
 *    999 → "$9.99"
 *
 * `Number.toFixed(2)` rounds half-to-even; for the integer-cents inputs we
 * always pass, the `/100` division is exact for values up to 2^53 cents
 * (~$90 trillion), well above any plausible coffee-shop order. No
 * scientific-notation risk.
 */
export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * "Oat Latte + Muffin" — items joined with " + ". Quantity > 1 appends
 * "x{n}" to the item name, e.g., "Oat Latte x2 + Muffin".
 *
 * Empty input returns empty string — defensive; an order with zero items
 * shouldn't reach the alert path, but if it does the message body just has
 * a missing slot rather than crashing.
 *
 * Spec Part 9 example shows quantity=1 items joined directly. The "x{n}"
 * extension for quantity > 1 is the natural reading of the same template
 * for catering / multi-quantity orders, which Part 9 doesn't show
 * explicitly. Documented in the C3 decision-log entry.
 */
export function formatItemList(items: ReadonlyArray<{ name: string; quantity: number }>): string {
  if (items.length === 0) return '';
  return items
    .map((it) => (it.quantity > 1 ? `${it.name} x${it.quantity}` : it.name))
    .join(' + ');
}

/**
 * UUID → short order-display ID for alert messages: first 8 chars prefixed
 * with `#`. Spec Part 9 shows "Order #124" — a short numeric identifier —
 * but Pulse Coffee orders are UUID-keyed at the schema level (no
 * sequential order number). The first 8 chars of a UUID are unique enough
 * for visual correlation in a Telegram alert and short enough to match
 * the spec's compact-ID feel. Manager can paste the full UUID into the
 * dashboard if they need disambiguation.
 *
 * Documented in the C3 decision-log entry. If Phase 2 adds a `order_number`
 * column or a sequential public ID, this formatter swaps to use it.
 */
export function formatOrderShortId(orderId: string): string {
  return `#${orderId.slice(0, 8)}`;
}
