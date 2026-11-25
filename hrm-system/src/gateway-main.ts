import 'reflect-metadata';

async function bootstrap() {
  if (process.env.HRM_LAUNCHER_MANAGED !== '1') require('dotenv').config();
  if (process.env.NODE_ENV === 'production' && Buffer.byteLength(process.env.INTERNAL_SERVICE_TOKEN || '') < 32) {
    throw new Error('INTERNAL_SERVICE_TOKEN must contain at least 32 bytes in production');
  }
  for (const key of [
    'DB_FILE', 'EMAIL_DB_FILE', 'JWT_SECRET', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE',
    'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'APP_URL', 'EMAIL_PORT', 'EMAIL_HOST',
    'EMAIL_SERVICE_URL', 'EMAIL_SERVICE_TIMEOUT_MS',
    'CONFIG_DB_FILE', 'CONFIG_PORT', 'CONFIG_HOST', 'CONFIG_SERVICE_URL', 'CONFIG_SERVICE_TIMEOUT_MS',
    'IDENTITY_DB_FILE', 'IDENTITY_PORT', 'IDENTITY_HOST',
  ]) {
    delete process.env[key];
  }
  const { createGateway } = require('./gateway') as typeof import('./gateway');
  const app = createGateway();
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.GATEWAY_HOST ?? '0.0.0.0';
  const server = app.listen(port, host, () => {
    console.log(`HRM API Gateway listening at http://${host}:${port}`);
  });
  return server;
}

if (require.main === module) {
  bootstrap().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
