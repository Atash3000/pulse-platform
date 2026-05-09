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
