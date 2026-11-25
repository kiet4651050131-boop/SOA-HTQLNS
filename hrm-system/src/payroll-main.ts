import { NestFactory } from '@nestjs/core';
import { PayrollServiceModule } from './payroll-service';

export async function createPayrollApp() {
  return NestFactory.create(PayrollServiceModule);
}

async function bootstrap() {
  if (process.env.HRM_LAUNCHER_MANAGED !== '1') require('dotenv').config();
  if (process.env.NODE_ENV === 'production' && Buffer.byteLength(process.env.INTERNAL_SERVICE_TOKEN || '') < 32) {
    throw new Error('INTERNAL_SERVICE_TOKEN must contain at least 32 bytes in production');
  }
  for (const key of [
    'DB_FILE', 'JWT_SECRET', 'APP_URL', 'CORE_PORT', 'CORE_HOST', 'CORE_SERVICE_URL',
    'PORT', 'GATEWAY_HOST', 'GATEWAY_TRUST_PROXY', 'GATEWAY_TIMEOUT_MS',
    'EMAIL_DB_FILE', 'EMAIL_PORT', 'EMAIL_HOST', 'EMAIL_SERVICE_URL', 'EMAIL_SERVICE_TIMEOUT_MS',
    'NOTIFICATION_SERVICE_TIMEOUT_MS', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS',
    'SMTP_FROM', 'CONFIG_DB_FILE', 'CONFIG_PORT', 'CONFIG_HOST', 'IDENTITY_DB_FILE', 'IDENTITY_PORT',
    'IDENTITY_HOST', 'IDENTITY_SERVICE_URL', 'IDENTITY_SERVICE_TIMEOUT_MS',
  ]) delete process.env[key];
  const app = await createPayrollApp();
  const port = Number(process.env.PAYROLL_PORT || 3005);
  const host = process.env.PAYROLL_HOST || '127.0.0.1';
  await app.listen(port, host);
  console.log(`HRM Payroll Service listening at http://${host}:${port}`);
  return app;
}

if (require.main === module) {
  bootstrap().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
