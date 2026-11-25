import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

interface ExitResult {
  code: number | null;
  signal: NodeJS.Signals | null;
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForService(url: string, serviceName: string, serviceExit: Promise<ExitResult>) {
  const deadline = Date.now() + 15000;
  let lastError = 'health check did not succeed';
  while (Date.now() < deadline) {
    const result = await Promise.race([
      fetch(url, { signal: AbortSignal.timeout(1000) })
        .then((response) => response.ok ? 'ready' : `health check returned HTTP ${response.status}`)
        .catch((error: unknown) => {
          lastError = error instanceof Error ? error.message : String(error);
          return 'retry';
        }),
      serviceExit.then((exit) => {
        throw new Error(`${serviceName} exited before becoming ready (${exit.code ?? exit.signal})`);
      }),
    ]);
    if (result === 'ready') return;
    if (result !== 'retry') lastError = result;
    await delay(200);
  }
  throw new Error(`${serviceName} did not become ready: ${lastError}`);
}

function startNode(file: string, env: NodeJS.ProcessEnv) {
  return spawn(process.execPath, [path.join(__dirname, file)], {
    env: { ...env, HRM_LAUNCHER_MANAGED: '1' },
    stdio: 'inherit',
  });
}

function withoutEnv(source: NodeJS.ProcessEnv, keys: string[]) {
  const env = { ...source };
  keys.forEach((key) => { delete env[key]; });
  return env;
}

async function run() {
  require('dotenv').config();
  process.env.TZ = process.env.TZ || 'Asia/Ho_Chi_Minh';
  const internalToken = process.env.INTERNAL_SERVICE_TOKEN
    || (process.env.NODE_ENV === 'production' ? '' : 'dev-only-internal-service-token');
  if (process.env.NODE_ENV === 'production' && Buffer.byteLength(internalToken) < 32) {
    throw new Error('INTERNAL_SERVICE_TOKEN must contain at least 32 bytes in production');
  }
  process.env.INTERNAL_SERVICE_TOKEN = internalToken;
  const emailPort = Number(process.env.EMAIL_PORT ?? 3200);
  const emailHost = process.env.EMAIL_HOST ?? '127.0.0.1';
  const emailUrl = process.env.EMAIL_SERVICE_URL ?? `http://${emailHost}:${emailPort}`;
  const configPort = Number(process.env.CONFIG_PORT ?? 3300);
  const configHost = process.env.CONFIG_HOST ?? '127.0.0.1';
  const configUrl = process.env.CONFIG_SERVICE_URL ?? `http://${configHost}:${configPort}`;
  const identityPort = Number(process.env.IDENTITY_PORT ?? 3001);
  const identityHost = process.env.IDENTITY_HOST ?? '127.0.0.1';
  const identityUrl = process.env.IDENTITY_SERVICE_URL ?? `http://${identityHost}:${identityPort}`;
  const corePort = Number(process.env.CORE_PORT ?? 3100);
  const coreHost = process.env.CORE_HOST ?? '127.0.0.1';
  const coreUrl = process.env.CORE_SERVICE_URL ?? `http://${coreHost}:${corePort}`;
  const email = startNode('email-main.js', {
    ...withoutEnv(process.env, [
      'DB_FILE', 'JWT_SECRET', 'APP_URL', 'CORE_PORT', 'CORE_HOST', 'CORE_SERVICE_URL',
      'PORT', 'GATEWAY_HOST', 'GATEWAY_TRUST_PROXY', 'GATEWAY_TIMEOUT_MS',
      'CONFIG_DB_FILE', 'CONFIG_PORT', 'CONFIG_HOST', 'CONFIG_SERVICE_URL', 'CONFIG_SERVICE_TIMEOUT_MS',
      'IDENTITY_DB_FILE', 'IDENTITY_PORT', 'IDENTITY_HOST', 'IDENTITY_SERVICE_URL', 'IDENTITY_SERVICE_TIMEOUT_MS',
    ]),
    EMAIL_PORT: String(emailPort),
    EMAIL_HOST: emailHost,
    EMAIL_SERVICE_URL: emailUrl,
  });
  const emailExit = trackExit(email, 'Email Service');
  let config: ChildProcess | undefined;
  let configExit: Promise<ExitResult> | undefined;
  let identity: ChildProcess | undefined;
  let identityExit: Promise<ExitResult> | undefined;
  let core: ChildProcess | undefined;
  let coreExit: Promise<ExitResult> | undefined;
  let gateway: ChildProcess | undefined;
  let gatewayExit: Promise<ExitResult> | undefined;
  let requestedExitCode: number | undefined;
  const stop = (signal: NodeJS.Signals) => {
    if (gateway && gateway.exitCode === null) gateway.kill(signal);
    if (core && core.exitCode === null) core.kill(signal);
    if (identity && identity.exitCode === null) identity.kill(signal);
    if (config && config.exitCode === null) config.kill(signal);
    if (email.exitCode === null) email.kill(signal);
  };
  const onSignal = (signal: NodeJS.Signals) => {
    requestedExitCode = signal === 'SIGINT' ? 130 : 143;
    stop(signal);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    await waitForService(new URL('/health', emailUrl).toString(), 'Email Service', emailExit);
    config = startNode('config-main.js', {
      ...withoutEnv(process.env, [
        'DB_FILE', 'JWT_SECRET', 'APP_URL', 'CORE_PORT', 'CORE_HOST', 'CORE_SERVICE_URL',
        'EMAIL_DB_FILE', 'EMAIL_PORT', 'EMAIL_HOST', 'EMAIL_SERVICE_URL',
        'SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM',
        'PORT', 'GATEWAY_HOST', 'GATEWAY_TRUST_PROXY', 'GATEWAY_TIMEOUT_MS',
        'IDENTITY_DB_FILE', 'IDENTITY_PORT', 'IDENTITY_HOST', 'IDENTITY_SERVICE_URL', 'IDENTITY_SERVICE_TIMEOUT_MS',
      ]),
      CONFIG_PORT: String(configPort),
      CONFIG_HOST: configHost,
      CONFIG_SERVICE_URL: configUrl,
      INTERNAL_SERVICE_TOKEN: internalToken,
    });
    configExit = trackExit(config, 'Config Service');
    await waitForService(new URL('/health', configUrl).toString(), 'Config Service', configExit);
    identity = startNode('identity-main.js', {
      ...withoutEnv(process.env, [
        'DB_FILE', 'EMAIL_DB_FILE', 'CONFIG_DB_FILE', 'PORT', 'GATEWAY_HOST',
        'EMAIL_PORT', 'EMAIL_HOST', 'CONFIG_PORT', 'CONFIG_HOST',
        'SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM',
        'GATEWAY_TRUST_PROXY', 'GATEWAY_TIMEOUT_MS',
      ]),
      IDENTITY_PORT: String(identityPort),
      IDENTITY_HOST: identityHost,
      IDENTITY_SERVICE_URL: identityUrl,
      EMAIL_SERVICE_URL: emailUrl,
      CORE_SERVICE_URL: coreUrl,
      INTERNAL_SERVICE_TOKEN: internalToken,
    });
    identityExit = trackExit(identity, 'Identity Service');
    await waitForService(new URL('/health', identityUrl).toString(), 'Identity Service', identityExit);
    core = startNode('main.js', {
      ...withoutEnv(process.env, [
        'SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'EMAIL_DB_FILE',
        'EMAIL_PORT', 'EMAIL_HOST', 'GATEWAY_HOST', 'GATEWAY_TRUST_PROXY', 'GATEWAY_TIMEOUT_MS',
        'CONFIG_DB_FILE', 'CONFIG_PORT', 'CONFIG_HOST',
        'JWT_SECRET', 'IDENTITY_DB_FILE', 'IDENTITY_PORT', 'IDENTITY_HOST',
      ]),
      CORE_PORT: String(corePort),
      CORE_HOST: coreHost,
      EMAIL_SERVICE_URL: emailUrl,
      CONFIG_SERVICE_URL: configUrl,
      IDENTITY_SERVICE_URL: identityUrl,
      INTERNAL_SERVICE_TOKEN: internalToken,
    });
    coreExit = trackExit(core, 'Core Service');
    await waitForService(new URL('/health', coreUrl).toString(), 'Core Service', coreExit);
    gateway = startNode('gateway-main.js', {
      ...withoutEnv(process.env, [
        'DB_FILE', 'EMAIL_DB_FILE', 'JWT_SECRET', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE',
        'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'APP_URL', 'EMAIL_PORT', 'EMAIL_HOST',
        'EMAIL_SERVICE_URL', 'EMAIL_SERVICE_TIMEOUT_MS',
        'CONFIG_DB_FILE', 'CONFIG_PORT', 'CONFIG_HOST', 'CONFIG_SERVICE_URL', 'CONFIG_SERVICE_TIMEOUT_MS',
        'IDENTITY_DB_FILE', 'IDENTITY_PORT', 'IDENTITY_HOST',
      ]),
      CORE_SERVICE_URL: coreUrl,
      IDENTITY_SERVICE_URL: identityUrl,
      PORT: process.env.PORT ?? '3000',
    });
    gatewayExit = trackExit(gateway, 'API Gateway');
    const exits = [emailExit, configExit, identityExit, coreExit, gatewayExit];
    const result = await Promise.race(exits);
    stop('SIGTERM');
    await Promise.all(exits);
    process.exitCode = requestedExitCode ?? (result.code === 0 ? 1 : result.code ?? 1);
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    if (gateway && gateway.exitCode === null) gateway.kill('SIGTERM');
    if (core && core.exitCode === null) core.kill('SIGTERM');
    if (identity && identity.exitCode === null) identity.kill('SIGTERM');
    if (config && config.exitCode === null) config.kill('SIGTERM');
    if (email.exitCode === null) email.kill('SIGTERM');
  }
}

function trackExit(child: ChildProcess, name: string) {
  return new Promise<ExitResult>((resolve) => {
    child.once('error', (error) => {
      console.error(`Could not start ${name}: ${error.message}`);
      resolve({ code: 1, signal: null });
    });
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

if (require.main === module) {
  run().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
