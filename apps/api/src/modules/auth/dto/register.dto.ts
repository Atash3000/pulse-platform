import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  Validate,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

/**
 * Validates an optional date-of-birth wire value: it must be a real
 * calendar date in `YYYY-MM-DD` form, not in the future, and no earlier
 * than 1900 (guards typos like `0190-01-01`). Format (the `YYYY-MM-DD`
 * shape) is enforced separately by `@Matches` so this constraint can
 * assume well-formed input and focus on the range/validity check.
 */
@ValidatorConstraint({ name: 'isPlausibleDateOfBirth', async: false })
export class IsPlausibleDateOfBirth implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (typeof value !== 'string') return false;
    // Reject impossible calendar dates (e.g. 2024-02-30): JS Date would
    // roll them over, so re-serialize and compare.
    const parsed = new Date(`${value}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime())) return false;
    if (parsed.toISOString().slice(0, 10) !== value) return false;

    const year = parsed.getUTCFullYear();
    if (year < 1900) return false;

    // Compare against today's UTC date only (no time component).
    const todayUtc = new Date();
    todayUtc.setUTCHours(0, 0, 0, 0);
    return parsed.getTime() <= todayUtc.getTime();
  }

  defaultMessage(): string {
    return 'date_of_birth must be a valid past date in YYYY-MM-DD format';
  }
}

export class RegisterDto {
  @ApiProperty({ example: 'sarah@example.com', maxLength: 254 })
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @ApiProperty({ example: 'correcthorsebatterystaple', minLength: 8, maxLength: 128 })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password!: string;

  @ApiProperty({ example: 'Abdurakhman', minLength: 1, maxLength: 60 })
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  first_name!: string;

  @ApiProperty({ example: 'Ivanov', minLength: 1, maxLength: 60 })
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  last_name!: string;

  @ApiPropertyOptional({
    example: 'Abdu',
    maxLength: 40,
    description: 'Shorter name baristas see on the order (defaults to the full name).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  nickname?: string;

  @ApiPropertyOptional({ example: '+1 718 555 0100' })
  @IsOptional()
  @IsString()
  @Matches(/^\+?[0-9\s\-()]{7,20}$/, { message: 'phone must be a valid phone number' })
  phone?: string;

  @ApiPropertyOptional({
    example: '1994-03-15',
    description: 'Calendar date of birth (YYYY-MM-DD). Optional; powers birthday rewards.',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'date_of_birth must be in YYYY-MM-DD format',
  })
  @Validate(IsPlausibleDateOfBirth)
  date_of_birth?: string;
}
