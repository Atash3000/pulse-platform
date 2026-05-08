// =============================================================================
// SENTRY INSTRUMENTATION
//
// This file MUST be the very first import in main.ts. Sentry's auto-instru-
// mentation patches the Node module loader, so anything imported before
// Sentry.init() is invisible to it.
//
// Rule #10 (Golden Rules): "Initialize in the first commit. Before any other
// logic. You need it before you know you need it."
// =============================================================================

import * as Sentry from '@sentry/node';
import { nodeProfilingIntegration } from '@sentry/profiling-node';

const dsn = process.env.SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? 'development',
    integrations: [nodeProfilingIntegration()],
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0.1),
    profilesSampleRate: Number(process.env.SENTRY_PROFILES_SAMPLE_RATE ?? 0.1),
  });
}
// If SENTRY_DSN is unset (e.g. local dev without an account) we no-op silently.
// The server still boots; errors just won't be reported. Production deploys
// must set SENTRY_DSN — checked separately in the deploy pipeline.
