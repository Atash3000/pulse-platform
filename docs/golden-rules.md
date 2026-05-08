# 15 Golden Rules

These are non-negotiable. Each one prevents a specific class of incident — the kind that loses real money, breaks customer trust, or leaves the barista holding the bag.

---

### 1. Menu loads instantly

**Rule:** iOS shows the local disk-cached menu immediately on launch and refreshes from the API in a background `Task{}`. The UI never blocks on the network for menu display.

**Why:** Coffee customers are queuing or driving. A 2-second cold start during the morning rush kills the first impression and sends them back to ordering at the counter — which is exactly the friction we built the app to remove. Stale menu data is recoverable; a blank loading spinner at 7:45 AM isn't.

---

### 2. Checkout is sacred

**Rule:** No AI, no experiments, no dynamic logic, no clever optimisations in the checkout path. Cart → tax → tip → pay → confirmed. Change as rarely as possible.

**Why:** Every modification to checkout is a chance to introduce a payment bug. Subtle ones — off-by-one cents, wrong tip base, double-charge on retry — don't surface in QA, they surface as Stripe disputes. Aggressively boring code in checkout is the cheapest insurance we can buy.

---

### 3. Stripe webhook is payment truth

**Rule:** The iOS app NEVER marks an order paid. Only `POST /api/v1/payments/webhook` with a valid `Stripe-Signature` header sets `payment_status = SUCCEEDED`.

**Why:** A client-driven "I paid, mark this order PAID" call can be forged. A Stripe-signed webhook can't — it requires a secret only Stripe and our server hold. Skipping this means an attacker with a JWT can mark any order paid without paying. We've seen this exact bug published as a CVE in another mobile-ordering app.

---

### 4. Idempotency on every payment

**Rule:** Every checkout request carries a client-generated key (`SHA256(userId + sortedCartItemIds + timestamp)`). The server deduplicates silently — replays of a SUCCEEDED order return the cached success payload; replays of an in-flight order return 409.

**Why:** Mobile networks drop responses constantly. If the customer taps Checkout, their connection blips between "PaymentIntent confirmed" and the success screen, the iOS retry logic re-posts the request. Without an idempotency key, we charge the customer twice. With one, the second request is a no-op and the customer never knows the network blinked.

---

### 5. Order status is a strict enum

**Rule:** No ad-hoc status strings. Invalid transitions are rejected by the state machine. TypeScript enum in code; PostgreSQL `ENUM` in the schema.

**Why:** A free-text status field is the easiest way to put "Cancelled" and "cancelled" and "CANCELED" into production simultaneously and have your reporting silently double-count or drop orders. The state machine also catches programming errors (e.g., `READY` → `DRAFT`) at the call site rather than in a corrupted database row.

---

### 6. Clover failure is not order failure

**Rule:** `CloverSyncStatus = MANUAL_REQUIRED` means the POS sync failed, **not** the order. `OrderStatus` stays `PAID`. The owner is alerted; staff enter the order manually. Never confuse these.

**Why:** The instinct is "POS sync failed → cancel the order." That instinct refunds a customer who already has their drink in hand because the cashier entered it manually after seeing the Telegram alert. We've seen exactly this happen at coffee shops using less-careful platforms. Three independent statuses exist precisely so a downstream outage doesn't silently undo customer-visible state.

---

### 7. All money in integer cents

**Rule:** `650` means $6.50. Never floats for money in business logic. Display formatting (`"6.50"`) happens only in the UI layer.

**Why:** IEEE 754 floating-point arithmetic loses pennies on long-tail rounding cases that compound across thousands of orders. `0.1 + 0.2 === 0.30000000000000004`. After 10,000 orders, you've drifted from your Stripe ledger by enough that reconciliation becomes impossible — and you can't tell whether the customer was over-charged or you under-charged. Integer cents end the problem at the source.

---

### 8. iOS never calculates prices

**Rule:** iOS sends items + tip percent. The backend calculates everything. iOS displays only what the backend returns. Modifier prices, tax, tip, total — all server-computed.

**Why:** A client-side price can be manipulated. Open the iOS Stripe SDK, intercept the request, and pay $0.50 for a $6.50 latte. The server-side recalc is the only thing standing between us and that attack. Any number that comes from the client about money is treated as a hint at most — usually ignored entirely.

---

### 9. Outbox for critical events

**Rule:** `ORDER_PAID` (and other critical events) are inserted into `outbox_events` in the same database transaction as the status update. Never publish to SQS directly from a request handler.

**Why:** A direct `await sqs.publish(...)` after a successful DB commit fails on every single network blip. The order is paid, the database knows it, and Clover never gets the order, the customer never gets a push, the owner never gets an alert. The outbox table makes the publish intent durable; a separate poller retries until it succeeds. See `docs/architecture.md` for the failure-mode diagram.

---

### 10. Sentry on day one

**Rule:** Sentry is initialised in the very first import of `main.ts`. Before logging, before NestFactory, before anything. iOS does the same in `App.init()`.

**Why:** You need observability before you know you need it. The bugs that *don't* hit Sentry on day one are the ones that take down production at 8 AM the morning of launch — and you spend the rush hour fumbling for log files instead of looking at a triaged stack trace. Cost is ~30 minutes of setup; benefit is the difference between "fixed in 5 minutes" and "fixed by lunch."

---

### 11. Staff dashboard before AI

**Rule:** Build the staff order queue, inventory controls, and wait time before any AI feature. Staff need these on day one.

**Why:** The barista has to be able to mark an order ready, mark an item sold out, and pause mobile ordering during the rush. Without those, the app is *worse* than not having it — orders pile up, customers wait, and staff can't do anything about it. AI features add nothing if the operational loop is broken.

---

### 12. Feature flags for everything risky

**Rule:** AI features, dynamic pricing, subscriptions — all behind a feature flag defaulting `FALSE`. Deploy code, enable when ready. No hotfix-flag deploys.

**Why:** A flag-gated feature can be shut off in 30 seconds when it misbehaves. A non-flagged feature requires a code revert, a build, a deploy, and a fingers-crossed prayer. After the third incident where "rolling back is going to take 45 minutes," every team learns this. We're learning it on day one instead.

---

### 13. Locations from day one

**Rule:** Every order, menu item, staff user, and setting is scoped to `location_id`. Never hardcode a single location anywhere.

**Why:** Pulse Coffee is one shop today. Multi-shop SaaS is the long-term direction (spec Phase 4). Going from one location to two with the assumption baked in costs a week. Going from one to two without it costs a month and produces a parallel codebase that diverges from the original. We pay the small structural cost now to avoid the large rewrite later.

---

### 14. Three separate status enums

**Rule:** `OrderStatus`, `PaymentStatus`, `CloverSyncStatus` are independent. They fail independently. Never merge.

**Why:** A single conflated "order_state" field forces you to choose between lying about one dimension or another. If Stripe succeeded but Clover failed, what's the order's state? PAID is wrong (POS doesn't have it). FAILED is wrong (the customer paid). Three fields let each system tell its own truth, and the UI composes the right view (customer sees `OrderStatus`, staff see all three).

---

### 15. Ship boring and reliable first

**Rule:** A simple app that takes orders reliably beats a clever app that occasionally double-charges. Trust is everything.

**Why:** The product wins or loses on whether the customer trusts the app to take their money correctly. Every "interesting" addition before that trust is established is a liability. We add cleverness *after* the boring core ships and stays up for a month without incident. Not before.
