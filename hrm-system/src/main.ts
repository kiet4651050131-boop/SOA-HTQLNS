export async function bootstrap() {
  if (process.env.HRM_LAUNCHER_MANAGED !== '1') require('dotenv').config();
  process.env.TZ = process.env.TZ || 'Asia/Ho_Chi_Minh';
  for (const key of [
    'SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM',
    'EMAIL_DB_FILE', 'EMAIL_PORT', 'EMAIL_HOST',
    'CONFIG_DB_FILE', 'CONFIG_PORT', 'CONFIG_HOST',
    'IDENTITY_DB_FILE', 'IDENTITY_PORT', 'IDENTITY_HOST',
    'JWT_SECRET',
  ]) {
    delete process.env[key];
  }
  if (process.env.NODE_ENV === 'production' && Buffer.byteLength(process.env.INTERNAL_SERVICE_TOKEN || '') < 32) {
    throw new Error('INTERNAL_SERVICE_TOKEN must contain at least 32 bytes in production');
  }

  const { createApp } = require('./app') as typeof import('./app');
  const app = await createApp();
  const port = Number(process.env.CORE_PORT || 3100);
  const host = process.env.CORE_HOST || '127.0.0.1';
  await app.listen(port, host);
  console.log(`HRM Core Service listening at http://${host}:${port}`);
  return app;
}

if (require.main === module) {
  bootstrap().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
