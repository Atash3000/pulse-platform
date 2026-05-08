// IMPORTANT: Sentry instrumentation MUST be the first import. It patches the
// Node module loader, so nothing imported before this line is observable to
// Sentry. Do not move, do not group with other imports.
import './instrument';

import { ValidationPipe, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'log', 'debug', 'verbose'],
    // rawBody must be available on the Stripe webhook handler so signature
    // verification has the byte-for-byte request body. Express still parses
    // JSON for every other route — req.rawBody just stores the bytes alongside.
    rawBody: true,
  });

  app.setGlobalPrefix('api/v1');

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  // Swagger / OpenAPI — development only. Production deploys MUST keep the
  // schema endpoints off so we never publish internal contracts to the open net.
  if (process.env.NODE_ENV !== 'production') {
    const config = new DocumentBuilder()
      .setTitle('Pulse Coffee API')
      .setDescription(
        'Backend API for the Pulse Coffee mobile ordering platform. ' +
          'All money is integer cents; iOS never decides payment status (only the Stripe webhook does).',
      )
      .setVersion('0.1.0')
      .addBearerAuth(
        { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        'jwt',
      )
      .addTag('health', 'Liveness/readiness probes for ECS')
      .addTag('auth', 'Customer + staff authentication')
      .addTag('locations', 'Public locations and open-hours availability')
      .addTag('menu', 'Public menu (Redis-cached, location-scoped)')
      .build();

    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('api/docs', app, document, {
      swaggerOptions: { persistAuthorization: true },
    });
  }

  app.enableShutdownHooks();

  // API_ENABLED gates the HTTP listener. Workers still bootstrap via Nest's
  // module init lifecycle regardless — set WORKERS_ENABLED=false to disable
  // those independently.
  //
  // Typical ECS deployment:
  //   API task    → API_ENABLED=true   WORKERS_ENABLED=false
  //   Worker task → API_ENABLED=false  WORKERS_ENABLED=true
  //
  // Default (both unset): both run, which is what local development wants.
  const apiEnabled = process.env.API_ENABLED !== 'false';
  const port = Number(process.env.PORT ?? 3000);

  if (apiEnabled) {
    await app.listen(port, '0.0.0.0');
    Logger.log(`Pulse API listening on http://0.0.0.0:${port}/api/v1`, 'Bootstrap');
    if (process.env.NODE_ENV !== 'production') {
      Logger.log(`Swagger UI:  http://0.0.0.0:${port}/api/docs`, 'Bootstrap');
    }
  } else {
    // Workers-only mode: don't open the HTTP port, but keep the process alive
    // and the Nest application initialised so OnModuleInit-driven workers run.
    await app.init();
    Logger.log('API_ENABLED=false — HTTP listener NOT starting (workers-only mode)', 'Bootstrap');
  }
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal bootstrap error', err);
  process.exit(1);
});
