import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsISO8601,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

import { PickupType } from '../../../database/entities';

// CartItem — what iOS sends per line. Modifier prices and item prices are
// LOOKED UP from the database server-side — anything from the client about
// money is ignored (Golden Rule #8).
export class CartItemDto {
  @ApiProperty({ format: 'uuid', description: 'menu_items.id' })
  @IsUUID()
  menuItemId!: string;

  @ApiProperty({ minimum: 1, maximum: 50, default: 1 })
  @IsInt()
  @Min(1)
  @Max(50)
  quantity!: number;

  @ApiProperty({
    type: [String],
    description: 'IDs of selected modifiers (must belong to a modifier_group of menuItemId).',
  })
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID('all', { each: true })
  modifierIds!: string[];
}

export class CheckoutRequestDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  locationId!: string;

  @ApiProperty({
    description:
      'SHA256 of (userId + sortedCartItemIds + timestamp). Identical keys are deduplicated.',
    minLength: 32,
    maxLength: 128,
  })
  @IsString()
  @Matches(/^[A-Za-z0-9_=:.+-]{32,128}$/, {
    message: 'idempotencyKey must be 32-128 chars [A-Za-z0-9_=:.+-]',
  })
  idempotencyKey!: string;

  @ApiProperty({ type: [CartItemDto], minItems: 1, maxItems: 50 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => CartItemDto)
  items!: CartItemDto[];

  @ApiProperty({ enum: [0, 15, 18, 20, 25], description: 'Whole-percent integer.' })
  @IsInt()
  @Min(0)
  @Max(100)
  tipPercent!: number;

  @ApiProperty({ enum: PickupType, default: PickupType.ASAP })
  @Transform(({ value }) => (typeof value === 'string' ? value.toUpperCase() : value))
  @IsEnum(PickupType)
  pickupType!: PickupType;

  @ApiPropertyOptional({
    description: 'ISO 8601 datetime; required when pickupType=SCHEDULED.',
    example: '2026-05-09T14:00:00.000Z',
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  scheduledPickupAt?: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}
