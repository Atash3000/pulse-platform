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

### Added

- Customer-facing iOS push notifications are now wired and live for two
  events:
  - `ORDER_READY` ("Your coffee is ready!" — "Pickup is waiting for you
    at <location name>")
  - `REFUND_CREATED` committed arm only ("Refund processed" —
    "Your refund of $X.XX is on its way back to your card")
  When the iOS app registers a push token via the new
  `PUT /customers/me/push-token` endpoint AND the APNS_* env is
  configured (post-Apple-verification), real APNs delivery fires.
  Race-recorded refund variants (Phase 3 race + webhook race) carry
  `actionRequired` and DO NOT push — a customer notification on those
  paths would be factually false (no card refund has moved). The
  `handleOrderPickedUp` handler intentionally stays unwired (no UX
  value). — see decision-log entry *"Push handler wiring (Phase 1
  subset)"*.

- `PUT /api/v1/customers/me/push-token` — authenticated customers can
  register or clear their APNs device token. New `CustomersModule` /
  `CustomersService` / `CustomersController` under
  `apps/api/src/modules/customers/`. Validates exactly 64 hex chars or
  empty string (empty clears the token / opts out of push). Customer
  JWT required; staff JWTs return 403. Idempotent. Returns
  `{success: true}` on 200; invalid token shape returns 400 with
  `code: 'PUSH_TOKEN_INVALID'`. The token value is never logged on any
  path (matches the C8 output-side security invariant). Closes the
  input-side gap left by C8 — iOS can now register a token that the
  push handlers will eventually dispatch to. — see decision-log entry
  *"Push token registration endpoint design"*.

- Real Telegram Bot API delivery in `TelegramService`. When
  `TELEGRAM_BOT_TOKEN` and `TELEGRAM_OWNER_CHAT_ID` are both set, the
  six event-driven dispatch methods (`newOrder`, `paymentFailed`,
  `itemSoldOut`, `orderingPaused`, `orderCancelledByStaff`,
  `refundIssued`) and `alertDeadOutboxEvent` POST to
  `api.telegram.org/sendMessage` in addition to emitting the
  structured log line. Permanent errors (400/401/403/404) are logged
  and swallowed; transient errors (429/5xx/network/timeout) throw so
  the outbox retries. Every fetch is bounded by
  `AbortSignal.timeout(5000)` to cap the outbox-worker lock-hold
  window. — see decision-log entry *"Real Telegram Bot API + APNs
  delivery (C8)"*.

- Real APNs delivery in `PushNotificationService` via
  `@parse/node-apn` (v8.1.0). When all four `APNS_*` env vars are set
  and the `.p8` key file is readable, the service constructs an apn
  Provider (sandbox/production selected via `APNS_USE_SANDBOX`) and
  `send()` performs a real APNs request alongside the structured
  `[push]` log line. Provider construction is wrapped in try/catch:
  on failure (missing/unreadable .p8) the service logs
  `[push] provider-init-failed` and falls back to stub-only mode
  rather than crashing app boot. `onModuleDestroy` calls
  `provider.shutdown()` to release HTTP/2 connections cleanly.

- `notification-error-classifier.ts`: pure-function helpers
  `isPermanentTelegramStatus(status, description?)` and
  `isPermanentApnsResponse(reason, status?)` codify the
  permanent-vs-transient split. The APNs classifier treats status
  410 as permanent regardless of reason value (Apple's Unregistered
  signal sometimes ships with empty reason).

- `.env.example`: inline documentation describing the empty-env →
  stub-only graceful-degradation pattern for both Telegram and APNs.

- `apps/api/package.json` declares `engines.node >= 18` to pin native
  `fetch` availability for production builds.

- `.gitignore`: `apps/api/secrets/` directory added (belt-and-
  suspenders with the existing `*.p8` glob — catches the conventional
  key-file location even if a future engineer renames the extension).

### Changed

- `[telegram-stub]` log prefix renamed to `[telegram]` on the six
  dispatch methods. The renamed prefix reflects that the log line now
  represents a real (or stub-fallback) dispatch ATTEMPT, not stub-
  only-by-design. `alertDeadOutboxEvent` intentionally KEEPS the
  `[telegram-stub]` prefix per the C3 decision-log entry's stance on
  not migrating its plain-text format. The asymmetry is documented
  inline.

- `[push-stub]` log prefix renamed to `[push]` on the dispatch path.
  `[push-skip]` is PRESERVED (operationally meaningful: "how many
  users don't have push enabled"). The customer-not-found warn line
  is now `[push] missing-customer:` to avoid prefix collision with the
  dispatch line at the same `[push]` root.

- `TelegramService.alertDeadOutboxEvent` truncates the message body to
  4000 chars before send (Telegram's hard cap is 4096; the safety
  margin accommodates the appended truncation suffix). Truncated
  bodies append `... (truncated, see CloudWatch [telegram] dead-event-
  alert-failed for full payload)`.

- Outbox worker now dispatches the six event-driven event types
  (`ORDER_PAID_NOTIFICATION`, `ORDER_CANCELLED`, `ORDER_READY`,
  `ORDER_PICKED_UP`, `REFUND_CREATED`, `ITEM_OUT_OF_STOCK`) to
  `NotificationsService.dispatch` instead of warning-and-marking-PROCESSED.
  The full dispatch chain is now wired end-to-end: real paid order →
  outbox row → worker pickup → notifications.dispatch → handler →
  stub-logged alert payload. Operationally, every paid order now
  produces a `[telegram-stub]` log line in CloudWatch; every status
  transition produces a `[notifications-stub]` log line. **No real
  Telegram messages or iOS APNs pushes are sent yet** — the actual
  network delivery is C8's scope. `ORDER_PAID` continues to route to
  `orderWorker.handleOrderPaid` for analytics, unchanged.

- `NotificationsService.dispatch`'s default branch now **throws** on an
  unknown event type instead of warning-and-returning. A corrupted
  runtime event type (e.g., a stale outbox row whose enum string was
  removed in a later migration) now retries up to 5 times and
  transitions to DEAD, triggering `TelegramService.alertDeadOutboxEvent`
  for operator attention. Previously these were silently marked
  PROCESSED, dropping the notification. The compile-time
  `_exhaustive: never` check stays as a complementary guard for the
  static case. — see decision-log entry *"Notifications dispatch
  wiring (C4) + outbox-worker README update (C7)"*. Bundle C4+C7.

### Added

- New `ORDER_PAID_NOTIFICATION` outbox event type, emitted atomically
  alongside the existing `ORDER_PAID` event from
  `markPaidFromWebhook`'s success transaction. The split-event design
  routes analytics (`orderWorker.handleOrderPaid` —
  `customer.last_visit_at` update + structured log) and the manager
  Telegram "NEW ORDER" alert
  (`NotificationsService.handleOrderPaidNotification` →
  `telegramService.newOrder`) through independent outbox dispatch
  paths. Each retries independently — a transient failure in the
  alert side no longer causes the analytics handler to re-run (which
  would have re-sent the Telegram message, producing duplicate alerts
  on every transient blip). The Postgres `outbox_event_type_enum` is
  extended via a new migration (`1778625600000-AddOrderPaidNotificationEnumValue`).
  The alert is not yet wired into the outbox-worker dispatch — that's
  C4 — so production traffic doesn't yet trigger Telegram messages on
  paid orders. The C5 handler exists and is exercised by tests. —
  see decision-log entry *"ORDER_PAID split-event design: analytics +
  notification retry independently"*. Bundle C5.

### Fixed

- Checkout modifier validation now enforces three previously-silent
  rules: per-cart-item duplicate detection
  (`MODIFIER_DUPLICATE`), `modifier_groups.required` enforcement
  (`MODIFIER_GROUP_REQUIRED`), and `modifier_groups.multi_select`
  enforcement (`MODIFIER_GROUP_SINGLE_SELECT`). Pre-fix, a customer
  could post the same modifier twice on one line item (charged twice
  for the same upcharge), omit all selections from a required group
  (e.g., order a drink with no size — barista has no idea what to
  make), or select multiple modifiers from a single-select group
  (e.g., "Small" AND "Large" simultaneously). All cart-validation
  rejections — both the three new rules and the four pre-existing
  ones (item not found, wrong location, modifier not on item) —
  now throw `BadRequestException` carrying a structured `reason`
  code + human `message` + optional `meta` (itemId, itemName,
  groupName) so the iOS client can render localized strings.
  Mirrors the `AvailabilityRejectReason` pattern from
  `HoursService`. — see decision-log entry *"Modifier validation:
  required, multi-select, and duplicate enforcement"*.

- Stale `payment_intent.payment_failed` webhooks for orders that have
  already moved past `PENDING_PAYMENT` no longer trigger Stripe retry
  storms. Previously, a failure event arriving for a PAID / ACCEPTED /
  IN_PROGRESS / READY / PICKED_UP / REFUNDED / CANCELLED order hit the
  state-machine assertion, threw `ConflictException`, returned 5xx to
  Stripe, and Stripe retried every few minutes for 3 days. The handler
  now detects three post-payment race types (`stale-failure-after-success`,
  `stale-failure-after-refund`, `stale-failure-after-cancel`) before the
  state-machine assertion, logs a structured WARN with the stripe event
  ID + the actual `order_status` for diagnostic correlation, and returns
  200 to Stripe. No outbox emission (no money moved, no operator action
  needed); no order mutation; no audit-row pollution. Mirrors the
  existing `markPaidFromWebhook` race-detection pattern. — see
  decision-log entry *"markFailedFromWebhook idempotency: stale failure
  webhook handling against post-payment states"*.

- Store hours and scheduled pickup validation now use the location's
  configured timezone rather than server time. Previously, stores in
  timezones other than the server's UTC would silently report wrong
  open/closed status, especially around server-midnight UTC. Scheduled
  pickup validation similarly reads day-of-week and time-of-day in the
  location's timezone. Rejection messages render times in the
  location's timezone (e.g. "We open at 09:00" matching what the
  customer expects, not a UTC translation that's correct only by
  coincidence). Bad timezone values on a Location row (e.g. typos like
  `America/Newyork`) are logged at WARN and fall back to
  `America/New_York` so the customer-facing flow keeps working while
  an operator fixes the row. — see decision-log entry *"Timezone-aware
  hours and scheduled pickup validation"*.

### Added

- `TelegramService` extended with six event-driven alert methods —
  `newOrder`, `paymentFailed`, `itemSoldOut`, `orderingPaused`,
  `orderCancelledByStaff`, `refundIssued`. Four match Spec Part 9
  templates directly; two (`orderCancelledByStaff`, `refundIssued`)
  are architectural extensions covering existing C1 outbox events
  (`ORDER_CANCELLED`, `REFUND_CREATED`). Each method takes a typed
  object literal of pre-formatted scalars (decoupled from TypeORM)
  and logs a hybrid `[telegram-stub] {alert,chat_id,level,body,...}`
  payload — `body` is the rendered Spec Part 9 string. Three pure
  formatting helpers (`formatCustomerName`, `formatCents`,
  `formatItemList` plus `formatOrderShortId` for UUID → display ID)
  land in a co-located `telegram-formatters.ts`. Real Telegram Bot
  API delivery is deferred to a consolidated turn after C5 + C4
  prove the dispatch logic. `paymentFailed` and `orderingPaused`
  are dead code in C3 — their first callers arrive when future
  turns add the corresponding emit sites. `dailySummary` /
  `weeklySummary` (also in Part 9) are deferred to a future
  scheduled-summary turn — cron-driven, not event-driven, warrants
  its own architecture. — see decision-log entry *"Telegram service
  extension: six alert methods for notification handlers"*.
  Bundle C3.

- `PushNotificationService` — APNs push-notification stub service. Exposes
  `send(customerId, title, body, data?)`. Loads the customer from the DB,
  warns and returns when the row is missing, INFO-logs a `[push-skip]`
  line when the customer has no `push_token`, and INFO-logs a `[push-stub]`
  line with the would-be APNs payload when a token is present. The push
  token value is **never** logged — only `push_token_present: true | false`
  surfaces in log output. Real APNs delivery is a Phase 2 Week 5
  deliverable; this stub establishes the call-site contract that
  `NotificationsService` handlers will eventually inject and call (wiring
  lands in C3 alongside the Telegram extension). No production code path
  yet calls this service; entirely additive infrastructure. — see
  decision-log entry *"Push-notification service: APNs stub for deferred
  C-series wiring"*. Bundle C2.

- `NotificationsService` — a router with six stubbed handlers
  (`handleOrderPaid`, `handleOrderReady`, `handleOrderCancelled`,
  `handleOrderPickedUp`, `handleRefundCreated`, `handleItemOutOfStock`).
  Each handler loads the relevant entity from the database the same way
  `orderWorker.handleOrderPaid` does, then logs a structured info-level
  (or warn-level when the payload carries `actionRequired`) line
  containing every field a future Telegram or APNs payload would carry.
  No real Telegram or APNs delivery is wired up yet (C2 and C3
  respectively), and the outbox worker is not yet calling
  `dispatch()` (C4). This is entirely additive infrastructure; no
  user-visible behaviour change. — see decision-log entry
  *"Notifications service: router pattern with stubbed handlers"*.
  Bundle C1.

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
