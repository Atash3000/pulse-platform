import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { RegisterDto } from './register.dto';

/**
 * Validation coverage for the registration contract. Mirrors the global
 * ValidationPipe config (whitelist + transform) by running class-validator
 * directly against a `plainToInstance`-built DTO.
 *
 * Focus: the new name split + optional nickname / phone / date_of_birth.
 */
async function constraintsFor(payload: Record<string, unknown>): Promise<string[]> {
  const dto = plainToInstance(RegisterDto, payload);
  const errors = await validate(dto, { whitelist: true });
  return errors.flatMap((e) => Object.keys(e.constraints ?? {}));
}

const VALID: Record<string, unknown> = {
  email: 'sarah@example.com',
  password: 'correcthorsebatterystaple',
  first_name: 'Abdurakhman',
  last_name: 'Ivanov',
};

describe('RegisterDto', () => {
  it('accepts the minimal required payload (no nickname/phone/dob)', async () => {
    expect(await constraintsFor(VALID)).toEqual([]);
  });

  it('accepts a full payload with nickname, phone, and date_of_birth', async () => {
    expect(
      await constraintsFor({
        ...VALID,
        nickname: 'Abdu',
        phone: '+1 718 555 0100',
        date_of_birth: '1994-03-15',
      }),
    ).toEqual([]);
  });

  it('rejects a missing first_name', async () => {
    const { first_name, ...rest } = VALID;
    expect(await constraintsFor(rest)).toContain('isString');
  });

  it('rejects a missing last_name', async () => {
    const { last_name, ...rest } = VALID;
    expect(await constraintsFor(rest)).toContain('isString');
  });

  it('rejects a first_name longer than 60 chars', async () => {
    expect(await constraintsFor({ ...VALID, first_name: 'a'.repeat(61) })).toContain('maxLength');
  });

  it('rejects a nickname longer than 40 chars', async () => {
    expect(await constraintsFor({ ...VALID, nickname: 'a'.repeat(41) })).toContain('maxLength');
  });

  it('rejects a malformed date_of_birth shape', async () => {
    expect(await constraintsFor({ ...VALID, date_of_birth: '03/15/1994' })).toContain('matches');
  });

  it('rejects a future date_of_birth', async () => {
    const nextYear = new Date();
    nextYear.setUTCFullYear(nextYear.getUTCFullYear() + 1);
    const iso = nextYear.toISOString().slice(0, 10);
    expect(await constraintsFor({ ...VALID, date_of_birth: iso })).toContain('isPlausibleDateOfBirth');
  });

  it('rejects an impossible calendar date (2024-02-30)', async () => {
    expect(await constraintsFor({ ...VALID, date_of_birth: '2024-02-30' })).toContain('isPlausibleDateOfBirth');
  });

  it('rejects a year before 1900', async () => {
    expect(await constraintsFor({ ...VALID, date_of_birth: '1899-12-31' })).toContain('isPlausibleDateOfBirth');
  });

  it('rejects an invalid phone format', async () => {
    expect(await constraintsFor({ ...VALID, phone: 'not-a-phone!!' })).toContain('matches');
  });
});
