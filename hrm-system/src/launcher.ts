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
  const employeePort = Number(process.env.EMPLOYEE_PORT ?? 3002);
  const employeeHost = process.env.EMPLOYEE_HOST ?? '127.0.0.1';
  const employeeUrl = process.env.EMPLOYEE_SERVICE_URL ?? `http://${employeeHost}:${employeePort}`;
  const leavePort = Number(process.env.LEAVE_PORT ?? 3004);
  const leaveHost = process.env.LEAVE_HOST ?? '127.0.0.1';
  const leaveUrl = process.env.LEAVE_SERVICE_URL ?? `http://${leaveHost}:${leavePort}`;
  const attendancePort = Number(process.env.ATTENDANCE_PORT ?? 3003);
  const attendanceHost = process.env.ATTENDANCE_HOST ?? '127.0.0.1';
  const attendanceUrl = process.env.ATTENDANCE_SERVICE_URL ?? `http://${attendanceHost}:${attendancePort}`;
  const payrollPort = Number(process.env.PAYROLL_PORT ?? 3005);
  const payrollHost = process.env.PAYROLL_HOST ?? '127.0.0.1';
  const payrollUrl = process.env.PAYROLL_SERVICE_URL ?? `http://${payrollHost}:${payrollPort}`;
  const corePort = Number(process.env.CORE_PORT ?? 3100);
  const coreHost = process.env.CORE_HOST ?? '127.0.0.1';
  const coreUrl = process.env.CORE_SERVICE_URL ?? `http://${coreHost}:${corePort}`;
  const email = startNode('email-main.js', {
    ...withoutEnv(process.env, [
      'DB_FILE', 'JWT_SECRET', 'APP_URL', 'CORE_PORT', 'CORE_HOST', 'CORE_SERVICE_URL',
      'PORT', 'GATEWAY_HOST', 'GATEWAY_TRUST_PROXY', 'GATEWAY_TIMEOUT_MS',
      'CONFIG_DB_FILE', 'CONFIG_PORT', 'CONFIG_HOST', 'CONFIG_SERVICE_URL', 'CONFIG_SERVICE_TIMEOUT_MS',
      'IDENTITY_DB_FILE', 'IDENTITY_PORT', 'IDENTITY_HOST', 'IDENTITY_SERVICE_URL', 'IDENTITY_SERVICE_TIMEOUT_MS',
      'EMPLOYEE_DB_FILE', 'EMPLOYEE_PORT', 'EMPLOYEE_HOST', 'EMPLOYEE_SERVICE_URL', 'EMPLOYEE_SERVICE_TIMEOUT_MS',
      'LEAVE_DB_FILE', 'LEAVE_PORT', 'LEAVE_HOST', 'LEAVE_SERVICE_URL', 'LEAVE_SERVICE_TIMEOUT_MS',
      'ATTENDANCE_DB_FILE', 'ATTENDANCE_PORT', 'ATTENDANCE_HOST', 'ATTENDANCE_SERVICE_URL', 'ATTENDANCE_SERVICE_TIMEOUT_MS',
      'PAYROLL_DB_FILE', 'PAYROLL_PORT', 'PAYROLL_HOST', 'PAYROLL_SERVICE_URL', 'PAYROLL_SERVICE_TIMEOUT_MS',
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
  let employee: ChildProcess | undefined;
  let employeeExit: Promise<ExitResult> | undefined;
  let leave: ChildProcess | undefined;
  let leaveExit: Promise<ExitResult> | undefined;
  let attendance: ChildProcess | undefined;
  let attendanceExit: Promise<ExitResult> | undefined;
  let payroll: ChildProcess | undefined;
  let payrollExit: Promise<ExitResult> | undefined;
  let core: ChildProcess | undefined;
  let coreExit: Promise<ExitResult> | undefined;
  let gateway: ChildProcess | undefined;
  let gatewayExit: Promise<ExitResult> | undefined;
  let requestedExitCode: number | undefined;
  const stop = (signal: NodeJS.Signals) => {
    if (gateway && gateway.exitCode === null) gateway.kill(signal);
    if (core && core.exitCode === null) core.kill(signal);
    if (identity && identity.exitCode === null) identity.kill(signal);
    if (employee && employee.exitCode === null) employee.kill(signal);
    if (leave && leave.exitCode === null) leave.kill(signal);
    if (attendance && attendance.exitCode === null) attendance.kill(signal);
    if (payroll && payroll.exitCode === null) payroll.kill(signal);
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
        'EMPLOYEE_DB_FILE', 'EMPLOYEE_PORT', 'EMPLOYEE_HOST', 'EMPLOYEE_SERVICE_URL', 'EMPLOYEE_SERVICE_TIMEOUT_MS',
        'LEAVE_DB_FILE', 'LEAVE_PORT', 'LEAVE_HOST', 'LEAVE_SERVICE_URL', 'LEAVE_SERVICE_TIMEOUT_MS',
        'ATTENDANCE_DB_FILE', 'ATTENDANCE_PORT', 'ATTENDANCE_HOST', 'ATTENDANCE_SERVICE_URL', 'ATTENDANCE_SERVICE_TIMEOUT_MS',
        'PAYROLL_DB_FILE', 'PAYROLL_PORT', 'PAYROLL_HOST', 'PAYROLL_SERVICE_URL', 'PAYROLL_SERVICE_TIMEOUT_MS',
      ]),
      CONFIG_PORT: String(configPort),
      CONFIG_HOST: configHost,
      CONFIG_SERVICE_URL: configUrl,
      INTERNAL_SERVICE_TOKEN: internalToken,
    });
    configExit = trackExit(config, 'Config Service');
    await waitForService(new URL('/health', configUrl).toString(), 'Config Service', configExit);
    employee = startNode('employee-main.js', {
      ...withoutEnv(process.env, [
        'DB_FILE', 'JWT_SECRET', 'APP_URL', 'CORE_PORT', 'CORE_HOST', 'CORE_SERVICE_URL',
        'EMAIL_DB_FILE', 'EMAIL_PORT', 'EMAIL_HOST', 'EMAIL_SERVICE_URL',
        'CONFIG_DB_FILE', 'CONFIG_PORT', 'CONFIG_HOST', 'CONFIG_SERVICE_URL',
        'IDENTITY_DB_FILE', 'IDENTITY_PORT', 'IDENTITY_HOST', 'IDENTITY_SERVICE_URL',
        'PORT', 'GATEWAY_HOST', 'GATEWAY_TRUST_PROXY', 'GATEWAY_TIMEOUT_MS',
        'SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM',
        'ATTENDANCE_DB_FILE', 'ATTENDANCE_PORT', 'ATTENDANCE_HOST', 'ATTENDANCE_SERVICE_URL', 'ATTENDANCE_SERVICE_TIMEOUT_MS',
        'LEAVE_DB_FILE', 'LEAVE_PORT', 'LEAVE_HOST', 'LEAVE_SERVICE_URL', 'LEAVE_SERVICE_TIMEOUT_MS',
        'PAYROLL_DB_FILE', 'PAYROLL_PORT', 'PAYROLL_HOST', 'PAYROLL_SERVICE_URL', 'PAYROLL_SERVICE_TIMEOUT_MS',
      ]),
      EMPLOYEE_PORT: String(employeePort),
      EMPLOYEE_HOST: employeeHost,
      INTERNAL_SERVICE_TOKEN: internalToken,
    });
    employeeExit = trackExit(employee, 'Employee Service');
    await waitForService(new URL('/health', employeeUrl).toString(), 'Employee Service', employeeExit);
    leave = startNode('leave-main.js', {
      ...withoutEnv(process.env, [
        'DB_FILE', 'JWT_SECRET', 'APP_URL', 'CORE_PORT', 'CORE_HOST', 'CORE_SERVICE_URL',
        'EMAIL_DB_FILE', 'EMAIL_PORT', 'EMAIL_HOST', 'EMAIL_SERVICE_URL',
        'CONFIG_DB_FILE', 'CONFIG_PORT', 'CONFIG_HOST', 'CONFIG_SERVICE_URL', 'CONFIG_SERVICE_TIMEOUT_MS',
        'IDENTITY_DB_FILE', 'IDENTITY_PORT', 'IDENTITY_HOST', 'IDENTITY_SERVICE_URL',
        'EMPLOYEE_DB_FILE', 'EMPLOYEE_PORT', 'EMPLOYEE_HOST', 'EMPLOYEE_SERVICE_URL',
        'ATTENDANCE_DB_FILE', 'ATTENDANCE_PORT', 'ATTENDANCE_HOST', 'ATTENDANCE_SERVICE_URL',
        'LEAVE_DB_FILE', 'LEAVE_PORT', 'LEAVE_HOST', 'LEAVE_SERVICE_URL', 'LEAVE_SERVICE_TIMEOUT_MS',
        'PAYROLL_DB_FILE', 'PAYROLL_PORT', 'PAYROLL_HOST', 'PAYROLL_SERVICE_URL', 'PAYROLL_SERVICE_TIMEOUT_MS',
        'PORT', 'GATEWAY_HOST', 'GATEWAY_TRUST_PROXY', 'GATEWAY_TIMEOUT_MS',
        'SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM',
      ]),
      LEAVE_PORT: String(leavePort),
      LEAVE_HOST: leaveHost,
      LEAVE_SERVICE_URL: leaveUrl,
      LEAVE_SERVICE_TIMEOUT_MS: process.env.LEAVE_SERVICE_TIMEOUT_MS ?? '3000',
      INTERNAL_SERVICE_TOKEN: internalToken,
    });
    leaveExit = trackExit(leave, 'Leave Service');
    await waitForService(new URL('/health', leaveUrl).toString(), 'Leave Service', leaveExit);
    attendance = startNode('attendance-main.js', {
      ...withoutEnv(process.env, [
        'DB_FILE', 'JWT_SECRET', 'APP_URL', 'CORE_PORT', 'CORE_HOST', 'CORE_SERVICE_URL',
        'PORT', 'GATEWAY_HOST', 'GATEWAY_TRUST_PROXY',
        'GATEWAY_TIMEOUT_MS', 'EMAIL_DB_FILE', 'EMAIL_PORT', 'EMAIL_HOST', 'EMAIL_SERVICE_URL',
        'CONFIG_DB_FILE', 'CONFIG_PORT', 'CONFIG_HOST', 'IDENTITY_DB_FILE', 'IDENTITY_PORT',
        'IDENTITY_HOST', 'IDENTITY_SERVICE_URL', 'EMPLOYEE_DB_FILE', 'EMPLOYEE_PORT',
        'EMPLOYEE_HOST', 'EMPLOYEE_SERVICE_URL', 'ATTENDANCE_DB_FILE', 'ATTENDANCE_PORT',
        'ATTENDANCE_HOST', 'ATTENDANCE_SERVICE_URL', 'ATTENDANCE_SERVICE_TIMEOUT_MS',
        'LEAVE_DB_FILE', 'LEAVE_PORT', 'LEAVE_HOST', 'LEAVE_SERVICE_URL', 'LEAVE_SERVICE_TIMEOUT_MS',
        'PAYROLL_DB_FILE', 'PAYROLL_PORT', 'PAYROLL_HOST', 'PAYROLL_SERVICE_URL', 'PAYROLL_SERVICE_TIMEOUT_MS',
        'SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM',
      ]),
      ATTENDANCE_PORT: String(attendancePort),
      ATTENDANCE_HOST: attendanceHost,
      ATTENDANCE_SERVICE_URL: attendanceUrl,
      ATTENDANCE_SERVICE_TIMEOUT_MS: process.env.ATTENDANCE_SERVICE_TIMEOUT_MS ?? '3000',
      CONFIG_SERVICE_URL: configUrl,
      LEAVE_SERVICE_URL: leaveUrl,
      LEAVE_SERVICE_TIMEOUT_MS: process.env.LEAVE_SERVICE_TIMEOUT_MS ?? '3000',
      INTERNAL_SERVICE_TOKEN: internalToken,
    });
    attendanceExit = trackExit(attendance, 'Attendance Service');
    await waitForService(new URL('/health', attendanceUrl).toString(), 'Attendance Service', attendanceExit);
    payroll = startNode('payroll-main.js', {
      ...withoutEnv(process.env, [
        'DB_FILE', 'JWT_SECRET', 'APP_URL', 'CORE_PORT', 'CORE_HOST', 'CORE_SERVICE_URL',
        'PORT', 'GATEWAY_HOST', 'GATEWAY_TRUST_PROXY', 'GATEWAY_TIMEOUT_MS',
        'EMAIL_DB_FILE', 'EMAIL_PORT', 'EMAIL_HOST', 'EMAIL_SERVICE_URL', 'EMAIL_SERVICE_TIMEOUT_MS',
        'NOTIFICATION_SERVICE_TIMEOUT_MS', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM',
        'CONFIG_DB_FILE', 'CONFIG_PORT', 'CONFIG_HOST', 'IDENTITY_DB_FILE', 'IDENTITY_PORT', 'IDENTITY_HOST',
        'IDENTITY_SERVICE_URL', 'IDENTITY_SERVICE_TIMEOUT_MS',
        'LEAVE_DB_FILE', 'LEAVE_PORT', 'LEAVE_HOST', 'LEAVE_SERVICE_URL',
        'ATTENDANCE_DB_FILE', 'ATTENDANCE_PORT', 'ATTENDANCE_HOST', 'ATTENDANCE_SERVICE_URL',
      ]),
      PAYROLL_PORT: String(payrollPort),
      PAYROLL_HOST: payrollHost,
      PAYROLL_SERVICE_URL: payrollUrl,
      PAYROLL_SERVICE_TIMEOUT_MS: process.env.PAYROLL_SERVICE_TIMEOUT_MS ?? '3000',
      CONFIG_SERVICE_URL: configUrl,
      EMPLOYEE_SERVICE_URL: employeeUrl,
      ATTENDANCE_SERVICE_URL: attendanceUrl,
      LEAVE_SERVICE_URL: leaveUrl,
      INTERNAL_SERVICE_TOKEN: internalToken,
    });
    payrollExit = trackExit(payroll, 'Payroll Service');
    await waitForService(new URL('/health', payrollUrl).toString(), 'Payroll Service', payrollExit);
    identity = startNode('identity-main.js', {
      ...withoutEnv(process.env, [
        'DB_FILE', 'EMAIL_DB_FILE', 'CONFIG_DB_FILE', 'PORT', 'GATEWAY_HOST',
        'EMAIL_PORT', 'EMAIL_HOST', 'CONFIG_PORT', 'CONFIG_HOST',
        'SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM',
        'GATEWAY_TRUST_PROXY', 'GATEWAY_TIMEOUT_MS',
        'EMPLOYEE_DB_FILE', 'EMPLOYEE_PORT', 'EMPLOYEE_HOST', 'EMPLOYEE_SERVICE_URL', 'EMPLOYEE_SERVICE_TIMEOUT_MS',
        'ATTENDANCE_DB_FILE', 'ATTENDANCE_PORT', 'ATTENDANCE_HOST', 'ATTENDANCE_SERVICE_URL', 'ATTENDANCE_SERVICE_TIMEOUT_MS',
        'LEAVE_DB_FILE', 'LEAVE_PORT', 'LEAVE_HOST', 'LEAVE_SERVICE_URL', 'LEAVE_SERVICE_TIMEOUT_MS',
        'PAYROLL_DB_FILE', 'PAYROLL_PORT', 'PAYROLL_HOST', 'PAYROLL_SERVICE_URL', 'PAYROLL_SERVICE_TIMEOUT_MS',
      ]),
      IDENTITY_PORT: String(identityPort),
      IDENTITY_HOST: identityHost,
      IDENTITY_SERVICE_URL: identityUrl,
      EMAIL_SERVICE_URL: emailUrl,
      CORE_SERVICE_URL: coreUrl,
      INTERNAL_SERVICE_TOKEN: internalToken,
      EMPLOYEE_SERVICE_URL: employeeUrl,
    });
    identityExit = trackExit(identity, 'Identity Service');
    await waitForService(new URL('/health', identityUrl).toString(), 'Identity Service', identityExit);
    core = startNode('main.js', {
      ...withoutEnv(process.env, [
        'SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'EMAIL_DB_FILE',
        'EMAIL_PORT', 'EMAIL_HOST', 'GATEWAY_HOST', 'GATEWAY_TRUST_PROXY', 'GATEWAY_TIMEOUT_MS',
        'CONFIG_DB_FILE', 'CONFIG_PORT', 'CONFIG_HOST',
        'JWT_SECRET', 'IDENTITY_DB_FILE', 'IDENTITY_PORT', 'IDENTITY_HOST',
        'EMPLOYEE_DB_FILE', 'EMPLOYEE_PORT', 'EMPLOYEE_HOST',
        'ATTENDANCE_DB_FILE', 'ATTENDANCE_PORT', 'ATTENDANCE_HOST',
        'LEAVE_DB_FILE', 'LEAVE_PORT', 'LEAVE_HOST',
        'PAYROLL_DB_FILE', 'PAYROLL_PORT', 'PAYROLL_HOST',
      ]),
      CORE_PORT: String(corePort),
      CORE_HOST: coreHost,
      EMAIL_SERVICE_URL: emailUrl,
      CONFIG_SERVICE_URL: configUrl,
      IDENTITY_SERVICE_URL: identityUrl,
      EMPLOYEE_SERVICE_URL: employeeUrl,
      LEAVE_SERVICE_URL: leaveUrl,
      ATTENDANCE_SERVICE_URL: attendanceUrl,
      PAYROLL_SERVICE_URL: payrollUrl,
      PAYROLL_SERVICE_TIMEOUT_MS: process.env.PAYROLL_SERVICE_TIMEOUT_MS ?? '3000',
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
        'EMPLOYEE_DB_FILE', 'EMPLOYEE_PORT', 'EMPLOYEE_HOST', 'EMPLOYEE_SERVICE_URL', 'EMPLOYEE_SERVICE_TIMEOUT_MS',
        'ATTENDANCE_DB_FILE', 'ATTENDANCE_PORT', 'ATTENDANCE_HOST', 'ATTENDANCE_SERVICE_URL', 'ATTENDANCE_SERVICE_TIMEOUT_MS',
        'LEAVE_DB_FILE', 'LEAVE_PORT', 'LEAVE_HOST', 'LEAVE_SERVICE_URL', 'LEAVE_SERVICE_TIMEOUT_MS',
        'PAYROLL_DB_FILE', 'PAYROLL_PORT', 'PAYROLL_HOST', 'PAYROLL_SERVICE_URL', 'PAYROLL_SERVICE_TIMEOUT_MS',
      ]),
      CORE_SERVICE_URL: coreUrl,
      IDENTITY_SERVICE_URL: identityUrl,
      PORT: process.env.PORT ?? '3000',
    });
    gatewayExit = trackExit(gateway, 'API Gateway');
    const exits = [emailExit, configExit, employeeExit, leaveExit, attendanceExit, payrollExit, identityExit, coreExit, gatewayExit];
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
    if (employee && employee.exitCode === null) employee.kill('SIGTERM');
    if (leave && leave.exitCode === null) leave.kill('SIGTERM');
    if (attendance && attendance.exitCode === null) attendance.kill('SIGTERM');
    if (payroll && payroll.exitCode === null) payroll.kill('SIGTERM');
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
