import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class MenuQueryDto {
  @ApiProperty({
    description: 'Location whose menu to fetch. iOS picks one on first launch.',
    format: 'uuid',
  })
  @IsUUID()
  locationId!: string;
}
