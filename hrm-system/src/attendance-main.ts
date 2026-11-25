import { NestFactory } from '@nestjs/core';
import { AttendanceServiceModule } from './attendance-service';

export async function createAttendanceApp() {
  return NestFactory.create(AttendanceServiceModule);
}

async function bootstrap() {
  if (process.env.HRM_LAUNCHER_MANAGED !== '1') require('dotenv').config();
  if (process.env.NODE_ENV === 'production' && Buffer.byteLength(process.env.INTERNAL_SERVICE_TOKEN || '') < 32) {
    throw new Error('INTERNAL_SERVICE_TOKEN must contain at least 32 bytes in production');
  }
  for (const key of [
    'DB_FILE', 'JWT_SECRET', 'APP_URL', 'CORE_PORT', 'CORE_HOST', 'CORE_SERVICE_URL',
    'PORT', 'GATEWAY_HOST', 'GATEWAY_TRUST_PROXY',
    'GATEWAY_TIMEOUT_MS', 'EMAIL_DB_FILE', 'EMAIL_PORT', 'EMAIL_HOST', 'EMAIL_SERVICE_URL',
    'CONFIG_DB_FILE', 'CONFIG_PORT', 'CONFIG_HOST', 'IDENTITY_DB_FILE', 'IDENTITY_PORT',
    'IDENTITY_HOST', 'IDENTITY_SERVICE_URL', 'EMPLOYEE_DB_FILE', 'EMPLOYEE_PORT',
    'EMPLOYEE_HOST', 'EMPLOYEE_SERVICE_URL', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE',
    'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM',
  ]) delete process.env[key];
  const app = await createAttendanceApp();
  const port = Number(process.env.ATTENDANCE_PORT || 3003);
  const host = process.env.ATTENDANCE_HOST || '127.0.0.1';
  await app.listen(port, host);
  console.log(`HRM Attendance Service listening at http://${host}:${port}`);
  return app;
}

if (require.main === module) {
  bootstrap().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
