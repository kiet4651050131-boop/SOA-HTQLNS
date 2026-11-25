import { NestFactory } from '@nestjs/core';
import { ConfigServiceModule } from './config-service';

export async function createConfigApp() {
  return NestFactory.create(ConfigServiceModule);
}

async function bootstrap() {
  if (process.env.HRM_LAUNCHER_MANAGED !== '1') require('dotenv').config();
  if (process.env.NODE_ENV === 'production' && Buffer.byteLength(process.env.INTERNAL_SERVICE_TOKEN || '') < 32) {
    throw new Error('INTERNAL_SERVICE_TOKEN must contain at least 32 bytes in production');
  }
  for (const key of [
    'DB_FILE', 'JWT_SECRET', 'APP_URL', 'CORE_PORT', 'CORE_HOST', 'CORE_SERVICE_URL',
    'EMAIL_DB_FILE', 'EMAIL_PORT', 'EMAIL_HOST', 'EMAIL_SERVICE_URL',
    'EMAIL_SERVICE_TIMEOUT_MS', 'NOTIFICATION_SERVICE_TIMEOUT_MS',
    'SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM',
    'PORT', 'GATEWAY_HOST', 'GATEWAY_TRUST_PROXY', 'GATEWAY_TIMEOUT_MS',
    'CONFIG_SERVICE_URL', 'CONFIG_SERVICE_TIMEOUT_MS',
    'IDENTITY_DB_FILE', 'IDENTITY_PORT', 'IDENTITY_HOST', 'IDENTITY_SERVICE_URL', 'IDENTITY_SERVICE_TIMEOUT_MS',
  ]) {
    delete process.env[key];
  }
  const app = await createConfigApp();
  const port = Number(process.env.CONFIG_PORT || 3300);
  const host = process.env.CONFIG_HOST || '127.0.0.1';
  await app.listen(port, host);
  console.log(`HRM Config Service listening at http://${host}:${port}`);
  return app;
}

if (require.main === module) {
  bootstrap().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
