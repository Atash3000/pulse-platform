import {
  BadRequestException,
  HttpException,
  HttpStatus,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import * as Sentry from '@sentry/node';

import { SentryExceptionFilter } from './sentry-exception.filter';

jest.mock('@sentry/node', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

// =============================================================================
// SentryExceptionFilter — Golden Rule #10 wiring.
//
// Capture policy pinned here:
//   - 4xx HttpException  → NOT captured (expected client behavior: validation,
//                          404 privacy responses, 429 throttles).
//   - 5xx HttpException  → captured.
//   - non-HttpException  → captured (programmer errors, DB failures).
// In every case the exception still flows to Nest's BaseExceptionFilter so
// the HTTP response shape is unchanged.
// =============================================================================

describe('SentryExceptionFilter', () => {
  let filter: SentryExceptionFilter;
  let baseCatchSpy: jest.SpyInstance;
  const fakeHost = {} as ArgumentsHost;

  beforeEach(() => {
    filter = new SentryExceptionFilter();
    // Stub the delegate — we only assert the capture policy + delegation,
    // not Nest's response writing (which needs a live HTTP adapter).
    baseCatchSpy = jest
      .spyOn(BaseExceptionFilter.prototype, 'catch')
      .mockImplementation(() => {});
    (Sentry.captureException as jest.Mock).mockClear();
  });

  afterEach(() => {
    baseCatchSpy.mockRestore();
  });

  it('does NOT capture 4xx HttpExceptions (expected client errors)', () => {
    for (const err of [new BadRequestException('nope'), new NotFoundException()]) {
      filter.catch(err, fakeHost);
    }
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(baseCatchSpy).toHaveBeenCalledTimes(2);
  });

  it('captures 5xx HttpExceptions', () => {
    const err = new InternalServerErrorException('boom');
    filter.catch(err, fakeHost);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledWith(err);
    expect(baseCatchSpy).toHaveBeenCalledWith(err, fakeHost);
  });

  it('captures 502 Bad Gateway (Stripe-failure surface)', () => {
    const err = new HttpException('stripe down', HttpStatus.BAD_GATEWAY);
    filter.catch(err, fakeHost);
    expect(Sentry.captureException).toHaveBeenCalledWith(err);
  });

  it('captures non-HttpException errors (programmer errors, DB failures)', () => {
    const err = new TypeError('cannot read properties of undefined');
    filter.catch(err, fakeHost);
    expect(Sentry.captureException).toHaveBeenCalledWith(err);
    expect(baseCatchSpy).toHaveBeenCalledWith(err, fakeHost);
  });

  it('always delegates to BaseExceptionFilter so the HTTP response is unchanged', () => {
    const err = new BadRequestException('still delegated');
    filter.catch(err, fakeHost);
    expect(baseCatchSpy).toHaveBeenCalledWith(err, fakeHost);
  });
});
