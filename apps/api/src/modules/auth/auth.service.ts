import {
  ConflictException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcrypt';
import { Repository } from 'typeorm';

import { Customer, StaffUser } from '../../database/entities';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { JwtPayload } from './jwt-payload';

export interface CustomerAuthResponse {
  access_token: string;
  refresh_token: string;
  customer: {
    id: string;
    email: string;
    full_name: string;
  };
}

export interface StaffAuthResponse {
  access_token: string;
  refresh_token: string;
  staff: {
    id: string;
    email: string;
    full_name: string;
    role: string;
    location_id: string;
  };
}

export interface RefreshResponse {
  access_token: string;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly bcryptRounds: number;
  private readonly accessTtl: string;
  private readonly refreshTtl: string;
  private readonly accessSecret: string;
  private readonly refreshSecret: string;

  constructor(
    @InjectRepository(Customer)
    private readonly customers: Repository<Customer>,
    @InjectRepository(StaffUser)
    private readonly staff: Repository<StaffUser>,
    private readonly jwt: JwtService,
    config: ConfigService,
  ) {
    this.bcryptRounds = Number(config.get('BCRYPT_ROUNDS') ?? 12);
    this.accessTtl = config.get<string>('JWT_ACCESS_TTL') ?? '15m';
    this.refreshTtl = config.get<string>('JWT_REFRESH_TTL') ?? '30d';

    const accessSecret = config.get<string>('JWT_ACCESS_SECRET');
    const refreshSecret = config.get<string>('JWT_REFRESH_SECRET');
    if (!accessSecret || !refreshSecret) {
      throw new Error('JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must be set');
    }
    this.accessSecret = accessSecret;
    this.refreshSecret = refreshSecret;
  }

  // ---------------------------------------------------------------------------
  // Customer registration & login
  // ---------------------------------------------------------------------------

  async registerCustomer(dto: RegisterDto): Promise<CustomerAuthResponse> {
    const normalizedEmail = dto.email.trim().toLowerCase();

    const existing = await this.customers.findOne({ where: { email: normalizedEmail } });
    if (existing) {
      throw new ConflictException('Email already registered');
    }

    const password_hash = await bcrypt.hash(dto.password, this.bcryptRounds);

    const customer = this.customers.create({
      email: normalizedEmail,
      full_name: dto.full_name.trim(),
      phone: dto.phone ?? null,
      password_hash,
    });
    const saved = await this.customers.save(customer);

    return this.buildCustomerResponse(saved);
  }

  async loginCustomer(dto: LoginDto): Promise<CustomerAuthResponse> {
    const normalizedEmail = dto.email.trim().toLowerCase();

    const customer = await this.customers.findOne({ where: { email: normalizedEmail } });
    // Always run bcrypt to keep timing constant whether the user exists or not.
    const hash = customer?.password_hash ?? '$2b$12$invalidhashinvalidhashinvalidhashinvalidhashinvalidha';
    const ok = await bcrypt.compare(dto.password, hash);

    if (!customer || !customer.password_hash || !ok) {
      throw new UnauthorizedException('Invalid email or password');
    }

    return this.buildCustomerResponse(customer);
  }

  // ---------------------------------------------------------------------------
  // Staff login
  // ---------------------------------------------------------------------------

  async loginStaff(dto: LoginDto): Promise<StaffAuthResponse> {
    const normalizedEmail = dto.email.trim().toLowerCase();

    const staffUser = await this.staff.findOne({ where: { email: normalizedEmail } });
    const hash = staffUser?.password_hash ?? '$2b$12$invalidhashinvalidhashinvalidhashinvalidhashinvalidha';
    const ok = await bcrypt.compare(dto.password, hash);

    if (!staffUser || !ok) {
      throw new UnauthorizedException('Invalid email or password');
    }
    if (!staffUser.active) {
      throw new UnauthorizedException('Account disabled');
    }

    return this.buildStaffResponse(staffUser);
  }

  // ---------------------------------------------------------------------------
  // Refresh
  // ---------------------------------------------------------------------------

  async refresh(refreshToken: string): Promise<RefreshResponse> {
    let payload: JwtPayload;
    try {
      payload = await this.jwt.verifyAsync<JwtPayload>(refreshToken, {
        secret: this.refreshSecret,
      });
    } catch (err) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    if (!payload.sub || !payload.type) {
      throw new UnauthorizedException('Malformed refresh token');
    }

    // Re-check the user still exists and is allowed to authenticate.
    if (payload.type === 'customer') {
      const exists = await this.customers.exists({ where: { id: payload.sub } });
      if (!exists) {
        throw new UnauthorizedException('Account no longer exists');
      }
    } else if (payload.type === 'staff') {
      const staff = await this.staff.findOne({ where: { id: payload.sub } });
      if (!staff || !staff.active) {
        throw new UnauthorizedException('Account disabled or removed');
      }
    } else {
      throw new UnauthorizedException('Unknown token subject type');
    }

    const access_token = await this.signAccessToken({
      sub: payload.sub,
      type: payload.type,
      role: payload.role,
      location_id: payload.location_id,
    });

    return { access_token };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private async buildCustomerResponse(customer: Customer): Promise<CustomerAuthResponse> {
    const payload: JwtPayload = { sub: customer.id, type: 'customer' };
    const [access_token, refresh_token] = await Promise.all([
      this.signAccessToken(payload),
      this.signRefreshToken(payload),
    ]);
    return {
      access_token,
      refresh_token,
      customer: {
        id: customer.id,
        email: customer.email,
        full_name: customer.full_name,
      },
    };
  }

  private async buildStaffResponse(staff: StaffUser): Promise<StaffAuthResponse> {
    const payload: JwtPayload = {
      sub: staff.id,
      type: 'staff',
      role: staff.role,
      location_id: staff.location_id,
    };
    const [access_token, refresh_token] = await Promise.all([
      this.signAccessToken(payload),
      this.signRefreshToken(payload),
    ]);
    return {
      access_token,
      refresh_token,
      staff: {
        id: staff.id,
        email: staff.email,
        full_name: staff.full_name,
        role: staff.role,
        location_id: staff.location_id,
      },
    };
  }

  private signAccessToken(payload: JwtPayload): Promise<string> {
    return this.jwt.signAsync(payload, {
      secret: this.accessSecret,
      expiresIn: this.accessTtl,
    });
  }

  private signRefreshToken(payload: JwtPayload): Promise<string> {
    return this.jwt.signAsync(payload, {
      secret: this.refreshSecret,
      expiresIn: this.refreshTtl,
    });
  }
}
