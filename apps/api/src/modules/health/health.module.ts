import { Inject, Logger, Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

import { HealthController } from './health.controller';
import { REDIS_CLIENT } from './redis.token';

const redisProvider = {
  provide: REDIS_CLIENT,
  inject: [ConfigService],
  useFactory: (config: ConfigService): Redis => {
    const client = new Redis({
      host: config.get<string>('REDIS_HOST') ?? 'localhost',
      port: Number(config.get<string>('REDIS_PORT') ?? 6379),
      password: config.get<string>('REDIS_PASSWORD') || undefined,
      tls: config.get<string>('REDIS_TLS') === 'true' ? {} : undefined,
      lazyConnect: false,
      maxRetriesPerRequest: 3,
      // Fail a command fast instead of hanging through the full retry budget,
      // so the menu falls back to Postgres quickly during a Redis blip.
      commandTimeout: 1000,
      enableReadyCheck: true,
    });
    // ioredis emits 'error' on connection trouble; without a listener Node logs
    // an unhandled error. Log it (warn) so a Redis outage is observable.
    const logger = new Logger('RedisClient');
    client.on('error', (err) => logger.warn(`Redis client error: ${err.message}`));
    return client;
  },
};

@Module({
  imports: [ConfigModule],
  controllers: [HealthController],
  providers: [redisProvider],
  exports: [redisProvider],
})
export class HealthModule implements OnApplicationShutdown {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  // Disconnect ioredis on graceful shutdown so SIGTERM doesn't leak a TCP socket.
  // Fired by Nest because main.ts calls enableShutdownHooks().
  async onApplicationShutdown(): Promise<void> {
    if (this.redis.status !== 'end') {
      await this.redis.quit();
    }
  }
}
