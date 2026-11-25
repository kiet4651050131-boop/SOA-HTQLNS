import { NestFactory } from '@nestjs/core';
import { EmailServiceModule } from './email-service';

export async function createEmailApp() {
  return NestFactory.create(EmailServiceModule);
}

async function bootstrap() {
  if (process.env.HRM_LAUNCHER_MANAGED !== '1') require('dotenv').config();
  if (process.env.NODE_ENV === 'production' && Buffer.byteLength(process.env.INTERNAL_SERVICE_TOKEN || '') < 32) {
    throw new Error('INTERNAL_SERVICE_TOKEN must contain at least 32 bytes in production');
  }
  for (const key of [
    'DB_FILE', 'JWT_SECRET', 'APP_URL', 'CORE_PORT', 'CORE_HOST', 'CORE_SERVICE_URL',
    'PORT', 'GATEWAY_HOST', 'GATEWAY_TRUST_PROXY', 'GATEWAY_TIMEOUT_MS',
    'CONFIG_DB_FILE', 'CONFIG_PORT', 'CONFIG_HOST', 'CONFIG_SERVICE_URL', 'CONFIG_SERVICE_TIMEOUT_MS',
    'IDENTITY_DB_FILE', 'IDENTITY_PORT', 'IDENTITY_HOST', 'IDENTITY_SERVICE_URL', 'IDENTITY_SERVICE_TIMEOUT_MS',
  ]) {
    delete process.env[key];
  }
  const app = await createEmailApp();
  const port = Number(process.env.EMAIL_PORT || 3200);
  const host = process.env.EMAIL_HOST || '127.0.0.1';
  await app.listen(port, host);
  console.log(`HRM Email Service listening at http://${host}:${port}`);
  return app;
}

if (require.main === module) {
  bootstrap().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
