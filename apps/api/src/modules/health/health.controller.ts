import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import Redis from 'ioredis';
import { DataSource } from 'typeorm';

import { REDIS_CLIENT } from './redis.token';

interface HealthResponse {
  status: 'ok';
  postgres: 'up';
  redis: 'up';
  timestamp: string;
}

@ApiTags('health')
@Controller('health')
@SkipThrottle()
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(
    private readonly ds: DataSource,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Liveness/readiness probe',
    description:
      "Checks PostgreSQL via 'SELECT 1' and Redis via 'PING'. Each check has a 2-second cap so a hung dependency never blocks the probe. Used as the ECS task health check.",
  })
  @ApiResponse({
    status: 200,
    description: 'Both Postgres and Redis are reachable.',
    schema: {
      example: {
        status: 'ok',
        postgres: 'up',
        redis: 'up',
        timestamp: '2026-05-08T20:58:22.631Z',
      },
    },
  })
  @ApiResponse({
    status: 503,
    description: 'At least one dependency is down or timing out.',
    schema: {
      example: {
        statusCode: 503,
        message: {
          status: 'degraded',
          postgres: 'up',
          redis: 'down',
          timestamp: '2026-05-08T20:58:22.631Z',
        },
        error: 'Service Unavailable',
      },
    },
  })
  async check(): Promise<HealthResponse> {
    const timestamp = new Date().toISOString();

    const [pgOk, redisOk] = await Promise.all([
      this.checkPostgres(),
      this.checkRedis(),
    ]);

    if (!pgOk || !redisOk) {
      throw new ServiceUnavailableException({
        status: 'degraded',
        postgres: pgOk ? 'up' : 'down',
        redis: redisOk ? 'up' : 'down',
        timestamp,
      });
    }

    return { status: 'ok', postgres: 'up', redis: 'up', timestamp };
  }

  private async checkPostgres(): Promise<boolean> {
    try {
      await this.withTimeout(this.ds.query('SELECT 1'), 2000, 'postgres');
      return true;
    } catch (err) {
      this.logger.warn(`Postgres health check failed: ${(err as Error).message}`);
      return false;
    }
  }

  private async checkRedis(): Promise<boolean> {
    try {
      const reply = await this.withTimeout(this.redis.ping(), 2000, 'redis');
      return reply === 'PONG';
    } catch (err) {
      this.logger.warn(`Redis health check failed: ${(err as Error).message}`);
      return false;
    }
  }

  private withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
    return Promise.race([
      p,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms),
      ),
    ]);
  }
}
