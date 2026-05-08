# Pulse Platform

Mobile ordering for Pulse Coffee — an independent NYC coffee shop. iOS app, React staff dashboard, Telegram owner alerts, and Clover POS sync, all on one Postgres + Redis backend.

The product goal is unglamorous: a real customer orders a real coffee in the morning, picks it up reliably, and the barista isn't surprised by the order. Phase 1 ships *that*. AI personalisation, subscriptions, and other "smart" features are Phase 2 once we have real order data.

## Monorepo layout

```
pulse-platform/
  apps/
    api/            NestJS backend. Owns the database, Stripe, Clover, push, Telegram.
    ios/            SwiftUI iOS 16+. Owns the customer experience. Never decides money.
    dashboard/      React + Tailwind. Owns the staff-facing live order queue + reports.
  infra/            Terraform + Dockerfiles + GitHub Actions. Owns AWS + deploy. (DevOps only.)
  docs/             Architecture decisions, contracts, runbooks. Cross-domain.
  scripts/          (Dev convenience scripts — under apps/api/scripts/ for backend ones.)
  docker-compose.yml  Local Postgres 15 + Redis 7.
  PulsCoffee_Final_Spec.pdf   Authoritative product spec. Version 3.0.
```

## Quick start

```bash
# 1. Bring up Postgres + Redis
docker compose up -d

# 2. Backend
cd apps/api
cp ../../.env.example .env       # then edit JWT secrets, Stripe keys
npm install
npm run migration:run
npm run seed:feature-flags       # 12 feature flags from spec section 3.5
npm run seed:dev                 # 1 location with hours, settings, pricing rule
npm run start:dev                # http://localhost:3000/api/v1
                                 # Swagger UI: http://localhost:3000/api/docs
```

The detailed backend runbook (env vars, seeds, Swagger, port-conflict notes) is in [`apps/api/README.md`](apps/api/README.md).

## The five-chat team

We split the build across five Claude chats. **Each chat owns exactly one domain. No chat changes another chat's domain.**

| Chat | Domain | Touches |
|---|---|---|
| **CTO** | Architecture decisions, sequencing, scope | Specs, decision log. No code. |
| **Backend** | `apps/api/` only | NestJS, TypeORM, Stripe, Clover, workers. |
| **iOS** | `apps/ios/` only | SwiftUI, Stripe iOS SDK, APNs, Keychain. |
| **Dashboard** | `apps/dashboard/` only | React, Tailwind, Amplify hosting. |
| **DevOps** | `infra/`, Dockerfiles, CI/CD | AWS, Parameter Store. Never application code. |

When a chat needs work outside its domain (e.g., iOS needs a new endpoint), it stops and asks the CTO chat to delegate. Cross-domain decisions go through the CTO chat so the decision log stays single-threaded.

## Architecture freeze

The spec (`PulsCoffee_Final_Spec.pdf`) is final. Every architectural change requires CTO chat approval and a new entry in [`docs/decision-log.md`](docs/decision-log.md). Reasons:

- We've been bitten before by mid-build pivots that broke the workers and the iOS contract.
- AI chats have no memory between sessions. The decision log + spec are the only durable source of "why we built it this way."

If you find yourself wanting to "just simplify this one thing" — write a decision-log entry first.

## Documentation map

Start here, in this order:

- [`docs/architecture.md`](docs/architecture.md) — the five core flows (checkout, outbox, Clover sync, three-status system, menu cache).
- [`docs/golden-rules.md`](docs/golden-rules.md) — 15 non-negotiable rules and the production incident each one prevents.
- [`docs/glossary.md`](docs/glossary.md) — every domain term defined once.
- [`docs/decision-log.md`](docs/decision-log.md) — chronological "why" for every architectural choice.
- [`docs/troubleshooting.md`](docs/troubleshooting.md) — diagnose-by-symptom runbook.
- [`docs/ai-onboarding/`](docs/ai-onboarding/) — onboarding for each chat (backend, ios, dashboard, devops).

Module-level READMEs sit next to the code they describe:

- [`apps/api/src/database/README.md`](apps/api/src/database/README.md)
- [`apps/api/src/modules/checkout/README.md`](apps/api/src/modules/checkout/README.md)
- [`apps/api/src/modules/payments/README.md`](apps/api/src/modules/payments/README.md)
- [`apps/api/src/workers/README.md`](apps/api/src/workers/README.md) (planned — built next)
