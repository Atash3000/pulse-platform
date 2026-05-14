import { BadRequestException, NotFoundException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';

import { Customer } from '../../database/entities';
import { CustomersService } from './customers.service';

// =============================================================================
// CustomersService — push token update.
//
// Pinned invariants:
//   - 64-char hex token persisted via update().
//   - Empty string → push_token cleared to NULL.
//   - Invalid shape → BadRequest with PUSH_TOKEN_INVALID code (defense in
//     depth in case DTO validation is bypassed).
//   - Affected-rows 0 → NotFound (JWT subject doesn't match a real customer).
//   - Token VALUE never appears in any log line (security regression).
// =============================================================================

// 64-char hex (32 bytes — APNs standard token format).
const VALID_TOKEN_LOWER =
  'a'.repeat(32) + 'b'.repeat(32);
const VALID_TOKEN_UPPER = VALID_TOKEN_LOWER.toUpperCase();

describe('CustomersService.updatePushToken', () => {
  let service: CustomersService;
  let updateMock: jest.Mock;
  let logSpy: jest.SpyInstance;

  beforeEach(async () => {
    updateMock = jest.fn().mockResolvedValue({ affected: 1 });
    const moduleRef = await Test.createTestingModule({
      providers: [
        CustomersService,
        {
          provide: getRepositoryToken(Customer),
          useValue: { update: updateMock },
        },
      ],
    }).compile();
    service = moduleRef.get(CustomersService);
    logSpy = jest
      .spyOn(
        (service as unknown as { logger: { log: (msg: string) => void } }).logger,
        'log',
      )
      .mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('persists a valid 64-char lowercase hex token', async () => {
    await service.updatePushToken('cust-1', VALID_TOKEN_LOWER);
    expect(updateMock).toHaveBeenCalledWith(
      { id: 'cust-1' },
      { push_token: VALID_TOKEN_LOWER },
    );
  });

  it('persists a valid 64-char uppercase hex token (case-insensitive)', async () => {
    await service.updatePushToken('cust-1', VALID_TOKEN_UPPER);
    expect(updateMock).toHaveBeenCalledWith(
      { id: 'cust-1' },
      { push_token: VALID_TOKEN_UPPER },
    );
  });

  it('empty string clears the token to NULL', async () => {
    await service.updatePushToken('cust-1', '');
    expect(updateMock).toHaveBeenCalledWith(
      { id: 'cust-1' },
      { push_token: null },
    );
  });

  it('throws PUSH_TOKEN_INVALID for non-hex characters (defense in depth)', async () => {
    const invalidToken = 'g'.repeat(64); // 'g' is not hex
    await expect(service.updatePushToken('cust-1', invalidToken)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(service.updatePushToken('cust-1', invalidToken)).rejects.toMatchObject({
      response: { code: 'PUSH_TOKEN_INVALID' },
    });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('throws PUSH_TOKEN_INVALID for wrong length (defense in depth)', async () => {
    const tooShort = 'ab'.repeat(20); // 40 chars
    await expect(service.updatePushToken('cust-1', tooShort)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('throws NotFoundException when no rows are affected', async () => {
    updateMock.mockResolvedValueOnce({ affected: 0 });
    await expect(service.updatePushToken('cust-gone', VALID_TOKEN_LOWER)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('idempotent: submitting the same token twice produces the same DB writes', async () => {
    await service.updatePushToken('cust-1', VALID_TOKEN_LOWER);
    await service.updatePushToken('cust-1', VALID_TOKEN_LOWER);
    expect(updateMock).toHaveBeenCalledTimes(2);
    expect(updateMock).toHaveBeenNthCalledWith(
      1,
      { id: 'cust-1' },
      { push_token: VALID_TOKEN_LOWER },
    );
    expect(updateMock).toHaveBeenNthCalledWith(
      2,
      { id: 'cust-1' },
      { push_token: VALID_TOKEN_LOWER },
    );
  });

  it('security invariant: token value NEVER appears in log output', async () => {
    await service.updatePushToken('cust-1', VALID_TOKEN_LOWER);
    const allLogged = logSpy.mock.calls.flat().join('\n');
    expect(allLogged).not.toContain(VALID_TOKEN_LOWER);
    // Log line should still exist (operators need confirmation of update).
    expect(allLogged).toMatch(/push-token-updated/);
    expect(allLogged).toMatch(/"cleared":false/);
  });

  it('clear path logs cleared:true for opt-out audit trail', async () => {
    await service.updatePushToken('cust-1', '');
    const logged = logSpy.mock.calls[0]![0] as string;
    expect(logged).toMatch(/"cleared":true/);
  });
});
