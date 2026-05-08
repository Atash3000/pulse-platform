import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

export class FeatureFlagToggleDto {
  @ApiProperty({ description: 'Set the flag on or off.' })
  @IsBoolean()
  enabled!: boolean;
}
