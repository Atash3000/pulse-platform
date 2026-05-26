import { ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Repository } from 'typeorm';

import { Customer, StaffUser } from '../../database/entities';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';

/**
 * Unit coverage for customer registration: that the new profile fields
 * (first/last/nickname/date_of_birth) are persisted and that the auth
 * response exposes the name split + nickname (and nothing more).
 */
describe('AuthService.registerCustomer', () => {
  let service: AuthService;
  let customers: jest.Mocked<Pick<Repository<Customer>, 'findOne' | 'create' | 'save'>>;
  let lastCreated: Partial<Customer>;

  const baseDto: RegisterDto = {
    email: 'Sarah@Example.com',
    password: 'correcthorsebatterystaple',
    first_name: 'Abdurakhman',
    last_name: 'Ivanov',
  };

  beforeEach(() => {
    lastCreated = {};
    customers = {
      findOne: jest.fn().mockResolvedValue(null),
      // `create` echoes the partial back so `save` sees what the service built.
      create: jest.fn((partial: Partial<Customer>) => {
        lastCreated = partial;
        return partial as Customer;
      }),
      save: jest.fn(async (c: Customer) => ({ ...c, id: 'cust-1' })),
    } as unknown as jest.Mocked<Pick<Repository<Customer>, 'findOne' | 'create' | 'save'>>;

    const jwt = { signAsync: jest.fn().mockResolvedValue('signed-token') } as unknown as JwtService;
    const config = {
      get: jest.fn((key: string) => {
        switch (key) {
          case 'JWT_ACCESS_SECRET':
            return 'access-secret';
          case 'JWT_REFRESH_SECRET':
            return 'refresh-secret';
          default:
            return undefined;
        }
      }),
    } as unknown as ConfigService;

    service = new AuthService(
      customers as unknown as Repository<Customer>,
      {} as Repository<StaffUser>,
      jwt,
      config,
    );
  });

  it('persists the name split, trims values, and lower-cases the email', async () => {
    await service.registerCustomer({
      ...baseDto,
      first_name: '  Abdurakhman ',
      last_name: ' Ivanov ',
      nickname: '  Abdu  ',
      phone: '+1 718 555 0100',
      date_of_birth: '1994-03-15',
    });

    expect(lastCreated).toMatchObject({
      email: 'sarah@example.com',
      first_name: 'Abdurakhman',
      last_name: 'Ivanov',
      nickname: 'Abdu',
      phone: '+1 718 555 0100',
      date_of_birth: '1994-03-15',
    });
  });

  it('stores nickname/phone/date_of_birth as null when omitted', async () => {
    await service.registerCustomer(baseDto);
    expect(lastCreated).toMatchObject({ nickname: null, phone: null, date_of_birth: null });
  });

  it('normalises a blank/whitespace nickname to null', async () => {
    await service.registerCustomer({ ...baseDto, nickname: '   ' });
    expect(lastCreated.nickname).toBeNull();
  });

  it('returns the name split + nickname in the customer payload (no full_name)', async () => {
    const res = await service.registerCustomer({ ...baseDto, nickname: 'Abdu' });
    expect(res.customer).toEqual({
      id: 'cust-1',
      email: 'sarah@example.com',
      first_name: 'Abdurakhman',
      last_name: 'Ivanov',
      nickname: 'Abdu',
    });
    expect(res.customer).not.toHaveProperty('full_name');
    expect(res.access_token).toBe('signed-token');
    expect(res.refresh_token).toBe('signed-token');
  });

  it('rejects a duplicate email with 409', async () => {
    customers.findOne.mockResolvedValueOnce({ id: 'existing' } as Customer);
    await expect(service.registerCustomer(baseDto)).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('Customer display-name getters', () => {
  function customerWith(fields: Partial<Customer>): Customer {
    return Object.assign(new Customer(), fields);
  }

  it('fullName joins first + last', () => {
    expect(customerWith({ first_name: 'Abdurakhman', last_name: 'Ivanov' }).fullName).toBe(
      'Abdurakhman Ivanov',
    );
  });

  it('baristaName prefers the nickname when set', () => {
    expect(
      customerWith({ first_name: 'Abdurakhman', last_name: 'Ivanov', nickname: 'Abdu' }).baristaName,
    ).toBe('Abdu');
  });

  it('baristaName falls back to the full name when nickname is null or blank', () => {
    expect(
      customerWith({ first_name: 'Abdurakhman', last_name: 'Ivanov', nickname: null }).baristaName,
    ).toBe('Abdurakhman Ivanov');
    expect(
      customerWith({ first_name: 'Abdurakhman', last_name: 'Ivanov', nickname: '   ' }).baristaName,
    ).toBe('Abdurakhman Ivanov');
  });
});
