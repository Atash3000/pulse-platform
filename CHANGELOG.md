# Changelog

All notable changes to Pulse Platform are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
loosely follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
once we cut a `1.0.0` (currently pre-1.0 alpha — minor releases may break
API contracts without warning).

Each entry names the user-visible behaviour change. The full rationale for
each change lives in [`docs/decision-log.md`](docs/decision-log.md), referenced
by entry title — search the log for the quoted title.

## [Unreleased]

### Changed

- Admin transition endpoints (`accept`, `progress`, `ready`, `picked-up`,
  `cancel`, `refund`) now return a consistent `AdminOrderDetail` response
  shape that includes the order's items, customer name, payment status,
  and scheduled pickup time. The list endpoint already returned a similar
  shape; transitions previously returned the raw `Order` entity without
  relations.
- The active-orders list endpoint and transition endpoints now expose
  `items[].unit_price_cents` and richer modifier fields (`modifierId`,
  `priceCents`) — previously only modifier `name` was returned. Per-line
  pricing is admin-role-gated and intended for manager dashboards.
- The shape change is a wire-format update for admin clients only; iOS
  and webhook paths are unaffected. `customer_name` is now nullable in
  the type system; downstream admin clients that treated it as
  definitely-a-string should handle the null case explicitly.
- `AdminOrderListItem` is preserved as a deprecated alias for
  `AdminOrderDetail` so existing imports continue to compile; the alias
  will be removed once consumers migrate. — see decision-log entry
  *"Admin response shape: AdminOrderDetail as the unified DTO"*. Bundle B2.

### Fixed

- Dashboard top items now correctly count units sold rather than line
  items. A single order with multiple of the same item (e.g., a catering
  order of 12 lattes) now contributes its full quantity to the
  `units_sold` ranking. The field has been renamed from `order_count` to
  `units_sold` to reflect its semantic. — see decision-log entry
  *"Dashboard arithmetic: net revenue and unit sales semantics"*. Bundle
  A10.

- Dashboard revenue is now net of partial refunds. Previously, an order
  with a partial refund contributed its gross total to today's revenue;
  now it contributes the net amount. Fully refunded orders continue to
  be excluded entirely (REFUNDED is not in `REVENUE_STATUSES`). Average
  order value follows the same net calculation. — see decision-log entry
  *"Dashboard arithmetic: net revenue and unit sales semantics"*. Bundle
  A11.

- Refund attempts on unrefundable orders no longer move money at Stripe
  before the validation rejects them. A refund attempt on a FAILED or
  otherwise non-refundable order, or one whose amount would exceed the
  remaining refundable, is now rejected in a pre-validation phase BEFORE
  the Stripe call — previously the assertion ran after Stripe had already
  moved money, leaving the merchant with money out and no DB record.
  Cumulative partial refunds correctly transition the order to REFUNDED
  when the cumulative refund total reaches the order amount (e.g., a
  prior $5 partial on a $20 order followed by a $15 refund now flips the
  order to REFUNDED, where it previously stayed in PARTIALLY_REFUNDED).
  Stripe refund calls now carry an idempotency key so a retried request
  after a network blip cannot double-refund. Successful refund outbox
  events now carry `refundType` (`partial`, `single-full`, or
  `cumulative-full`), `isCumulativelyFull`, and `cumulativeRefundedCents`
  so downstream notifications can word the receipt correctly. The race
  branch now returns a discriminated `status: 'race-recorded'` shape
  instead of a synthetic refund object — callers cannot accidentally
  treat a Stripe-succeeded-but-DB-raced refund as a normal commit.
  — see decision-log entry *"Refund pre-validation before Stripe call:
  avoid money out with no DB record"*. Bundles A5, A6, A7, A8.

### Added

- `POST /admin/orders/:id/picked-up` now emits an `ORDER_PICKED_UP`
  outbox event alongside the READY → PICKED_UP transition. Mirrors the
  `markReady → ORDER_READY` shape so the future analytics module
  (retention, time-to-pickup metrics) and any close-of-loop receipt push
  receive the close-of-loop event from day one. The outbox worker
  currently no-ops the event; the case branch in
  `workers/outbox.worker.ts` already lists it. Bundle A9.

## [0.2.0-alpha] — 2026-05-09

### Fixed

- Customers can now cancel orders that are in `PENDING_PAYMENT` (Stripe
  payment sheet shown but not confirmed). Previously the cancel endpoint
  was unreachable from any state, returning 409 even for orders the
  customer legitimately wanted to abandon. The handler also asks Stripe
  to cancel the underlying PaymentIntent so the customer can't accidentally
  complete payment after the cancel commits. — see decision-log entry
  *"Customer cancel during PENDING_PAYMENT"*.

- `GET /api/v1/orders/:id` and `POST /api/v1/orders/:id/cancel` no longer
  leak whether a given order ID exists. Both endpoints now return `404` with
  the message `"Order {id} not found"` when the order is missing OR belongs
  to a different customer. The previous behaviour returned `403` for the
  cross-customer case, letting an attacker enumerate valid order UUIDs by
  status code. — see decision-log entry *"Privacy: 404 over 403 for
  cross-customer order access (correction of earlier reasoning)"*.

- The staff "accept order" action no longer overwrites the pickup time of
  scheduled orders. Previously, accepting a scheduled order at any time
  would silently shift `estimated_ready_at` to `now + current_wait_minutes`,
  breaking the customer's chosen pickup time and the iOS countdown display.
  Scheduled orders now retain the time the customer selected at checkout;
  ASAP orders continue to be recomputed. — see decision-log entry
  *"Scheduled orders: estimated_ready_at set once at checkout, never
  overwritten"*.

- Stripe webhook deliveries for `payment_intent.succeeded` arriving after
  an order has been cancelled, abandoned-cleanup-reaped, or refunded no
  longer trigger a 3-day Stripe retry storm. The handler detects the race,
  emits a structured warning log and (for cancel/cleanup races) an outbox
  event flagging the manager-refund liability, and returns 200 to Stripe.
  — see decision-log entry *"Webhook-after-state-change races: log +
  outbox, never throw"*.

### Added

- Background job that automatically transitions orders abandoned at checkout.
  Any order left in `PENDING_PAYMENT` for more than 30 minutes is moved to
  `FAILED` with reason `"abandoned at checkout"` every 5 minutes. The job
  best-effort cancels the underlying Stripe PaymentIntent first. Runs only
  on tasks where `WORKERS_ENABLED=true` (default). Uses
  `SELECT ... FOR UPDATE SKIP LOCKED` so it's safe to run on multiple
  worker pods. — see decision-log entry *"Abandoned-checkout cleanup:
  30-minute threshold, FAILED state, no outbox event"*.

### Tests

- Suite grew from 22 tests (pricing only) to **94 tests** across 6 suites:
  `pricing`, `order-state-machine`, `pending-payment-cleanup.task`,
  `orders.service` (customer-side privacy), `payments/orders.service`
  (webhook race detection), `admin-orders.service` (accept pickup-type
  branching).

### Internal

- Added `@nestjs/schedule` dependency to support the abandoned-checkout
  cleanup cron.
- Extended `OrderStateMachine`: `PENDING_PAYMENT → CANCELLED` for
  `customer + system` actors; `PENDING_PAYMENT → FAILED` adds the `system`
  actor alongside `stripe-webhook`. Both are pinned with unit tests.
- New `StripeService.cancelPaymentIntent()` — idempotent, swallows the
  `payment_intent_unexpected_state` error so already-cancelled or
  already-succeeded intents return cleanly.

## [0.1.0-alpha] — 2026-05-08

### Added

- Initial Phase 1 backend scaffold:
  `auth`, `health`, `locations`, `menu`, `pricing`, `payments` (Stripe
  webhook + atomic outbox transaction), `checkout`, `orders`, `admin`
  (14 endpoints across queue/transitions/refund/items/ordering/dashboard/
  feature-flags), `workers` (outbox worker + order worker).
- Documentation set:
  `README`, `docs/{architecture,golden-rules,glossary,troubleshooting,
  decision-log}.md`, `docs/diagrams/outbox-lifecycle.md`, per-module
  READMEs, AI-onboarding docs.
- 22 unit tests covering `PricingService`.
- Phase 1 stance: Clover POS integration deferred to Phase 2; staff
  dashboard handles operational order management.
