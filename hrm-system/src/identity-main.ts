import { NestFactory } from '@nestjs/core';
import { IdentityServiceModule } from './identity-service';

export async function createIdentityApp() {
  return NestFactory.create(IdentityServiceModule);
}

async function bootstrap() {
  if (process.env.HRM_LAUNCHER_MANAGED !== '1') require('dotenv').config();
  if (process.env.NODE_ENV === 'production' && Buffer.byteLength(process.env.JWT_SECRET || '') < 32) {
    throw new Error('JWT_SECRET must contain at least 32 bytes in production');
  }
  if (process.env.NODE_ENV === 'production' && Buffer.byteLength(process.env.INTERNAL_SERVICE_TOKEN || '') < 32) {
    throw new Error('INTERNAL_SERVICE_TOKEN must contain at least 32 bytes in production');
  }
  for (const key of [
    'DB_FILE', 'EMAIL_DB_FILE', 'CONFIG_DB_FILE', 'PORT', 'GATEWAY_HOST',
    'EMAIL_PORT', 'EMAIL_HOST', 'CONFIG_PORT', 'CONFIG_HOST',
    'SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM',
    'GATEWAY_TRUST_PROXY', 'GATEWAY_TIMEOUT_MS', 'CONFIG_SERVICE_URL', 'CONFIG_SERVICE_TIMEOUT_MS',
  ]) {
    delete process.env[key];
  }
  const app = await createIdentityApp();
  const port = Number(process.env.IDENTITY_PORT || 3001);
  const host = process.env.IDENTITY_HOST || '127.0.0.1';
  await app.listen(port, host);
  console.log(`HRM Identity Service listening at http://${host}:${port}`);
  return app;
}

if (require.main === module) {
  bootstrap().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
