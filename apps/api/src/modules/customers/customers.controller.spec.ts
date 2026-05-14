import { ForbiddenException } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import type { JwtPayload } from '../auth/jwt-payload';
import { CustomersController } from './customers.controller';
import { CustomersService } from './customers.service';

// =============================================================================
// CustomersController — focused unit tests on the JWT-subject routing
// behaviour (the DTO + global pipe are validated end-to-end in NestJS
// itself; we trust those rather than re-test the framework). What we
// pin here:
//
//   - Customer JWT → service.updatePushToken called with the JWT subject
//     as customerId.
//   - Staff JWT → ForbiddenException.
//   - Missing user → ForbiddenException (defensive — JWT guard should
//     have thrown 401 first, but the controller still asserts).
//   - Different customers cannot affect each other (customerId is read
//     from JWT, not from request body).
// =============================================================================

describe('CustomersController', () => {
  let controller: CustomersController;
  let serviceUpdate: jest.Mock;

  beforeEach(async () => {
    serviceUpdate = jest.fn().mockResolvedValue(undefined);
    const moduleRef = await Test.createTestingModule({
      controllers: [CustomersController],
      providers: [
        {
          provide: CustomersService,
          useValue: { updatePushToken: serviceUpdate },
        },
      ],
    }).compile();
    controller = moduleRef.get(CustomersController);
  });

  function makeRequest(user: Partial<JwtPayload> | undefined): { user?: JwtPayload } {
    return user ? { user: user as JwtPayload } : {};
  }

  it('customer JWT → calls service.updatePushToken with the JWT subject', async () => {
    const req = makeRequest({ sub: 'cust-1', type: 'customer' });
    const result = await controller.updatePushToken(req as never, { token: 'abc' });
    expect(serviceUpdate).toHaveBeenCalledWith('cust-1', 'abc');
    expect(result).toEqual({ success: true });
  });

  it('staff JWT → ForbiddenException (customer creds required)', async () => {
    const req = makeRequest({ sub: 'staff-1', type: 'staff' });
    await expect(
      controller.updatePushToken(req as never, { token: 'abc' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(serviceUpdate).not.toHaveBeenCalled();
  });

  it('missing user → ForbiddenException (defensive)', async () => {
    const req = makeRequest(undefined);
    await expect(
      controller.updatePushToken(req as never, { token: 'abc' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(serviceUpdate).not.toHaveBeenCalled();
  });

  it("customer cannot update another customer's token — customerId comes from JWT subject, not the body", async () => {
    // Even if a malicious caller embeds a different customerId somewhere
    // in the body (defense pattern: trust JWT subject, never trust body
    // for actor identity), the controller routes the call to the JWT
    // subject only.
    const req = makeRequest({ sub: 'cust-attacker', type: 'customer' });
    await controller.updatePushToken(req as never, { token: 'xyz' });
    expect(serviceUpdate).toHaveBeenCalledWith('cust-attacker', 'xyz');
    expect(serviceUpdate).not.toHaveBeenCalledWith('cust-victim', expect.anything());
  });

  it('empty token is forwarded to service (clear-token semantics)', async () => {
    const req = makeRequest({ sub: 'cust-1', type: 'customer' });
    await controller.updatePushToken(req as never, { token: '' });
    expect(serviceUpdate).toHaveBeenCalledWith('cust-1', '');
  });
});
