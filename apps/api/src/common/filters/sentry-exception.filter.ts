import { ArgumentsHost, Catch, HttpException } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import * as Sentry from '@sentry/node';

/**
 * Global exception filter that reports server faults to Sentry, then delegates
 * to Nest's default handling (so response shapes are unchanged).
 *
 * Why this exists: instrument.ts calls Sentry.init() (Golden Rule #10), but
 * Nest's built-in exception layer catches every error before it can reach
 * Sentry's process-level handlers — without this filter NOTHING was ever
 * reported. The project uses @sentry/node (not @sentry/nestjs), so the
 * idiomatic wiring is a thin BaseExceptionFilter subclass registered via
 * APP_FILTER.
 *
 * Capture policy: 5xx HttpExceptions and any non-HttpException (programmer
 * errors, DB failures) are captured. 4xx responses are expected client
 * behavior (validation failures, 404s, throttle 429s) — reporting them would
 * bury real faults in noise.
 *
 * When SENTRY_DSN is unset (local dev), captureException is a silent no-op.
 */
@Catch()
export class SentryExceptionFilter extends BaseExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const isExpectedClientError =
      exception instanceof HttpException && exception.getStatus() < 500;
    if (!isExpectedClientError) {
      Sentry.captureException(exception);
    }
    super.catch(exception, host);
  }
}
