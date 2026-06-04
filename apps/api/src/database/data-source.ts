import 'reflect-metadata';
import * as dotenv from 'dotenv';
import { DataSource, DataSourceOptions } from 'typeorm';
import { ALL_ENTITIES } from './entities';

// The TypeORM CLI (typeorm-ts-node-commonjs) does not auto-load .env. The Nest
// app does (via ConfigModule.forRoot()), but for `npm run migration:*` we need
// to populate process.env ourselves. Loading is silent if .env is absent.
dotenv.config();

const isProduction = process.env.NODE_ENV === 'production';

const requireEnv = (name: string): string => {
  const v = process.env[name];
  if (!v || v.length === 0) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
};

// Pool ceiling must be a positive integer. An empty-string or non-numeric env
// var (Number('') === 0, Number('abc') === NaN) must NOT slip through — a pool
// size of 0 breaks every query — so fall back to the safe default instead.
const parsePoolMax = (raw: string | undefined): number => {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : 20;
};

export const dataSourceOptions: DataSourceOptions = {
  type: 'postgres',
  host: process.env.DATABASE_HOST ?? 'localhost',
  port: Number(process.env.DATABASE_PORT ?? 5432),
  username: process.env.DATABASE_USER ?? 'pulse',
  password: process.env.DATABASE_PASSWORD ?? 'pulse',
  database: process.env.DATABASE_NAME ?? 'pulse',
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
  entities: ALL_ENTITIES,
  migrations: [__dirname + '/migrations/!(*.spec).{ts,js}'],
  migrationsTableName: 'typeorm_migrations',
  // Schema is now managed exclusively by migration files. Never re-enable
  // synchronize — see Fix 1 in the build plan.
  synchronize: false,
  logging: process.env.DATABASE_LOGGING === 'true' ? ['error', 'warn', 'migration'] : ['error'],
  // node-postgres pool. Default 10 is too small once checkout holds a
  // connection across the in-transaction Stripe call. PRODUCTION must set
  // DATABASE_POOL_MAX = floor((postgres_max_connections - reserved) / api_instances).
  // 20 is a safe local/staging default, NOT a production value.
  extra: {
    max: parsePoolMax(process.env.DATABASE_POOL_MAX),
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
  },
};

if (isProduction) {
  requireEnv('DATABASE_HOST');
  requireEnv('DATABASE_PASSWORD');
  requireEnv('DATABASE_NAME');
}

export const AppDataSource = new DataSource(dataSourceOptions);
