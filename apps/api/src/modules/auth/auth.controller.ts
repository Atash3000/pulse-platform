import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { LoginDto } from './dto/login.dto';
import { RefreshDto } from './dto/refresh.dto';
import { RegisterDto } from './dto/register.dto';
import {
  AuthService,
  CustomerAuthResponse,
  RefreshResponse,
  StaffAuthResponse,
} from './auth.service';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Customer registration',
    description: 'Public. Rate-limited 10/min/IP. Email is normalised to lowercase. Password is bcrypt-hashed (12 rounds). Returns access + refresh JWTs.',
  })
  @ApiResponse({ status: 201, description: 'Account created. Tokens issued.' })
  @ApiResponse({ status: 400, description: 'Validation failed (invalid email, short password, missing full_name).' })
  @ApiResponse({ status: 409, description: 'Email already registered.' })
  @ApiResponse({ status: 429, description: 'Too many requests (>10/min from this IP).' })
  register(@Body() dto: RegisterDto): Promise<CustomerAuthResponse> {
    return this.auth.registerCustomer(dto);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Customer login',
    description: 'Public. Rate-limited 5/min/IP. Constant-time response whether the user exists or not (prevents enumeration).',
  })
  @ApiResponse({ status: 200, description: 'Authentication successful. Tokens issued.' })
  @ApiResponse({ status: 401, description: 'Invalid email or password.' })
  @ApiResponse({ status: 429, description: 'Too many requests (>5/min from this IP).' })
  login(@Body() dto: LoginDto): Promise<CustomerAuthResponse> {
    return this.auth.loginCustomer(dto);
  }

  @Post('staff/login')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Staff login (BARISTA / MANAGER / OWNER)',
    description: 'Public. Rate-limited 5/min/IP. Token carries role and location_id. Disabled accounts (active=false) cannot log in.',
  })
  @ApiResponse({ status: 200, description: 'Authentication successful. Staff token issued.' })
  @ApiResponse({ status: 401, description: 'Invalid credentials, OR account disabled.' })
  @ApiResponse({ status: 429, description: 'Too many requests (>5/min from this IP).' })
  staffLogin(@Body() dto: LoginDto): Promise<StaffAuthResponse> {
    return this.auth.loginStaff(dto);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Refresh access token',
    description: 'Exchange a valid refresh token for a new 15-minute access token. Re-validates the underlying account still exists and is active.',
  })
  @ApiResponse({ status: 200, description: 'New access token issued.' })
  @ApiResponse({ status: 400, description: 'refresh_token missing or not a JWT.' })
  @ApiResponse({ status: 401, description: 'Token invalid/expired, or account no longer exists / disabled.' })
  refresh(@Body() dto: RefreshDto): Promise<RefreshResponse> {
    return this.auth.refresh(dto.refresh_token);
  }
}
