import { NestFactory } from '@nestjs/core';
import { LeaveServiceModule } from './leave-service';

export async function createLeaveApp() {
  return NestFactory.create(LeaveServiceModule);
}

async function bootstrap() {
  if (process.env.HRM_LAUNCHER_MANAGED !== '1') require('dotenv').config();
  if (process.env.NODE_ENV === 'production' && Buffer.byteLength(process.env.INTERNAL_SERVICE_TOKEN || '') < 32) {
    throw new Error('INTERNAL_SERVICE_TOKEN must contain at least 32 bytes in production');
  }
  for (const key of [
    'DB_FILE', 'JWT_SECRET', 'APP_URL', 'PORT', 'GATEWAY_HOST', 'GATEWAY_TRUST_PROXY',
    'GATEWAY_TIMEOUT_MS', 'EMAIL_DB_FILE', 'EMAIL_PORT', 'EMAIL_HOST', 'EMAIL_SERVICE_URL',
    'EMAIL_SERVICE_TIMEOUT_MS', 'NOTIFICATION_SERVICE_TIMEOUT_MS',
    'CONFIG_DB_FILE', 'CONFIG_PORT', 'CONFIG_HOST', 'CONFIG_SERVICE_URL', 'CONFIG_SERVICE_TIMEOUT_MS',
    'SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM',
    'IDENTITY_DB_FILE', 'IDENTITY_PORT', 'IDENTITY_HOST', 'IDENTITY_SERVICE_URL', 'IDENTITY_SERVICE_TIMEOUT_MS',
    'EMPLOYEE_DB_FILE', 'EMPLOYEE_PORT', 'EMPLOYEE_HOST', 'EMPLOYEE_SERVICE_URL', 'EMPLOYEE_SERVICE_TIMEOUT_MS',
    'ATTENDANCE_DB_FILE', 'ATTENDANCE_PORT', 'ATTENDANCE_HOST', 'ATTENDANCE_SERVICE_URL', 'ATTENDANCE_SERVICE_TIMEOUT_MS',
  ]) delete process.env[key];
  const app = await createLeaveApp();
  const port = Number(process.env.LEAVE_PORT || 3004);
  const host = process.env.LEAVE_HOST || '127.0.0.1';
  await app.listen(port, host);
  console.log(`HRM Leave Service listening at http://${host}:${port}`);
  return app;
}

if (require.main === module) {
  bootstrap().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
