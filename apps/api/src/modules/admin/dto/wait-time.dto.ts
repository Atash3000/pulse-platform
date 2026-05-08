import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Max, Min } from 'class-validator';

export class WaitTimeDto {
  @ApiProperty({
    description:
      'Wait time in minutes. Used as the offset for estimated_ready_at when staff accept ASAP orders.',
    minimum: 1,
    maximum: 120,
  })
  @IsInt()
  @Min(1)
  @Max(120)
  current_wait_minutes!: number;
}
