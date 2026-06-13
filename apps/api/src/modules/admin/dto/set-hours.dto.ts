import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/; // HH:mm 00:00–23:59

export class HoursDayDto {
  @ApiProperty({ minimum: 0, maximum: 6, description: '0=Sun … 6=Sat' })
  @IsInt()
  @Min(0)
  @Max(6)
  day_of_week!: number;

  @ApiProperty({ example: '07:00', description: 'HH:mm, shop-local' })
  @Matches(TIME_RE, { message: 'open_time must be HH:mm' })
  open_time!: string;

  @ApiProperty({ example: '18:00', description: 'HH:mm, shop-local' })
  @Matches(TIME_RE, { message: 'close_time must be HH:mm' })
  close_time!: string;

  @ApiProperty()
  @IsBoolean()
  is_closed!: boolean;
}

export class SetHoursDto {
  @ApiProperty({ type: [HoursDayDto], description: 'Exactly 7 entries, one per day_of_week 0–6.' })
  @IsArray()
  @ArrayMinSize(7)
  @ArrayMaxSize(7)
  @ValidateNested({ each: true })
  @Type(() => HoursDayDto)
  hours!: HoursDayDto[];
}
