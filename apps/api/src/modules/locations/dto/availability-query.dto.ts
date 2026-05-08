import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEnum, IsISO8601, IsOptional } from 'class-validator';

import { PickupType } from '../../../database/entities';

export class AvailabilityQueryDto {
  @ApiPropertyOptional({
    enum: PickupType,
    default: PickupType.ASAP,
    description: 'ASAP for immediate pickup, SCHEDULED for a future time.',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.toUpperCase() : value))
  @IsOptional()
  @IsEnum(PickupType)
  pickupType?: PickupType;

  @ApiPropertyOptional({
    description: 'ISO 8601 datetime. Required when pickupType=SCHEDULED.',
    example: '2026-05-09T14:00:00.000Z',
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  scheduledPickupAt?: string;
}
