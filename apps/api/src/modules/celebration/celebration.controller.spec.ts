import { ForbiddenException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Request } from 'express';

import { StaffRole } from '../../database/entities';
import { CelebrationController } from './celebration.controller';
import { CelebrationService } from './celebration.service';
import { CelebrationStateDto } from './dto/celebration-state.dto';

const STAFF_REQ: Partial<Request> = {
  user: {
    type: 'staff',
    sub: 'staff-1',
    role: StaffRole.BARISTA,
    location_id: 'loc-1',
  } as unknown as Express.User,
};

const CUSTOMER_REQ: Partial<Request> = {
  user: { type: 'customer', sub: 'cust-9' } as unknown as Express.User,
};

describe('CelebrationController.getCelebrationState', () => {
  let controller: CelebrationController;
  let getState: jest.Mock;

  beforeEach(async () => {
    getState = jest.fn();
    const moduleRef = await Test.createTestingModule({
      controllers: [CelebrationController],
      providers: [{ provide: CelebrationService, useValue: { getCelebrationState: getState } }],
    }).compile();
    controller = moduleRef.get(CelebrationController);
  });

  it('passes the customerId and the staff location to the service and returns its DTO', async () => {
    const dto = new CelebrationStateDto('BIRTHDAY_TODAY', 'Birthday today 🎂', []);
    getState.mockResolvedValue(dto);

    const result = await controller.getCelebrationState('cust-1', STAFF_REQ as Request);

    expect(getState).toHaveBeenCalledWith('cust-1', 'loc-1');
    expect(result).toBe(dto);
  });

  it('throws ForbiddenException (403) for a non-staff (customer) token', async () => {
    await expect(
      controller.getCelebrationState('cust-1', CUSTOMER_REQ as Request),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(getState).not.toHaveBeenCalled();
  });
});
