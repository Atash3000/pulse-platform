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

export const dataSourceOptions: DataSourceOptions = {
  type: 'postgres',
  host: process.env.DATABASE_HOST ?? 'localhost',
  port: Number(process.env.DATABASE_PORT ?? 5432),
  username: process.env.DATABASE_USER ?? 'pulse',
  password: process.env.DATABASE_PASSWORD ?? 'pulse',
  database: process.env.DATABASE_NAME ?? 'pulse',
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
  entities: ALL_ENTITIES,
  migrations: [__dirname + '/migrations/*.{ts,js}'],
  migrationsTableName: 'typeorm_migrations',
  // Schema is now managed exclusively by migration files. Never re-enable
  // synchronize — see Fix 1 in the build plan.
  synchronize: false,
  logging: process.env.DATABASE_LOGGING === 'true' ? ['error', 'warn', 'migration'] : ['error'],
};

if (isProduction) {
  requireEnv('DATABASE_HOST');
  requireEnv('DATABASE_PASSWORD');
  requireEnv('DATABASE_NAME');
}

export const AppDataSource = new DataSource(dataSourceOptions);
