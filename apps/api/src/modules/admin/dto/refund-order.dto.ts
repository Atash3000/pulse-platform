import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, MaxLength, Min, MinLength } from 'class-validator';

export class RefundOrderDto {
  @ApiProperty({
    description: 'Free-text reason. Required.',
    minLength: 10,
    maxLength: 500,
  })
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  reason!: string;

  @ApiPropertyOptional({
    description:
      'Integer cents to refund. Omit for a full refund. Must be ≤ order.total_cents and ≥ 1.',
    minimum: 1,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  amount_cents?: number;
}
