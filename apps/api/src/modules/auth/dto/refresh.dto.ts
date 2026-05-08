import { ApiProperty } from '@nestjs/swagger';
import { IsJWT } from 'class-validator';

export class RefreshDto {
  @ApiProperty({
    description: 'JWT issued by /login, /staff/login, or /register. 30-day TTL.',
    example: 'eyJhbGciOiJIUzI1NiIs...',
  })
  @IsJWT()
  refresh_token!: string;
}
