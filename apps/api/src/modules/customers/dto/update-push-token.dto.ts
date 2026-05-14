import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';

/**
 * APNs device tokens are conventionally a 64-character hex string (the
 * library's `ResponseSent.device` field uses the same shape). Apple has
 * stated the length may grow in future iOS versions, so the validator
 * uses a fixed expected length CONSTANT named here for easy future
 * relaxation — if production logs ever show a non-64-char token rejected
 * with PUSH_TOKEN_INVALID, this is the single spot to widen.
 *
 * Empty string is allowed and means "remove my push token / stop sending
 * me push notifications" — the customers service converts it to NULL in
 * the database. See decision-log entry "Push token registration endpoint
 * design".
 */
export const EXPECTED_PUSH_TOKEN_LENGTH = 64;
const HEX_TOKEN_REGEX = /^[0-9a-fA-F]+$/;

export class UpdatePushTokenDto {
  @ApiProperty({
    description:
      'APNs hex device token (lowercase or uppercase hex, expected 64 chars). Submit an empty string to clear the token (opt out of push notifications).',
    example: 'ed5f44b51e9bdc5c7e5cef7afe05d9c9b1a6f0c2c0e1b04ff1234567890abcdef',
    minLength: 0,
    maxLength: EXPECTED_PUSH_TOKEN_LENGTH,
  })
  // Trim whitespace before validation so callers passing trailing newline
  // / leading space (common when copy-pasting from an iOS debug log) still
  // succeed. class-transformer's Transform runs before class-validator.
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString({ message: 'token must be a string' })
  @MaxLength(EXPECTED_PUSH_TOKEN_LENGTH, {
    message: `token must be at most ${EXPECTED_PUSH_TOKEN_LENGTH} chars`,
  })
  // Empty string IS allowed (means clear). Validate hex shape only when
  // non-empty: a regex of /^[0-9a-fA-F]*$/ would accept arbitrary lengths;
  // we want EXACTLY 64 hex chars OR exactly the empty string. The two
  // discrete shapes are clearer than a single regex with conditional
  // alternation, and the assertion in the service catches anything
  // class-validator might miss.
  @Matches(new RegExp(`^(|[0-9a-fA-F]{${EXPECTED_PUSH_TOKEN_LENGTH}})$`), {
    message: `token must be exactly ${EXPECTED_PUSH_TOKEN_LENGTH} hex chars or empty string`,
  })
  token!: string;
}
