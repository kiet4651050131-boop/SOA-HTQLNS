import { NestFactory } from '@nestjs/core';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { AppModule } from './app.module';
import { LEGACY_API_ROUTES, LegacyApiRoute } from './legacy-api.module';

interface LegacyNotification {
  id: number;
  user_id: number;
  title: string;
  message: string;
  href: string;
  created_at: string;
  read_at: string | null;
}

interface LegacyAuditLog {
  id: number;
  at: string;
  user_email: string;
  action: string;
}

interface LegacySetting {
  key: string;
  value: string;
}

interface LegacyHoliday {
  date: string;
  name: string;
}

interface LegacyIdentityUser {
  id: number;
  email: string;
  name: string;
  password_hash: string;
  role: string;
  must_change_password: number;
  created_at: string;
}

interface LegacyResetToken {
  token_hash: string;
  user_id: number;
  expires_at: number;
}

interface LegacyDepartment {
  id: number;
  name: string;
}

interface LegacyPosition {
  id: number;
  name: string;
}

interface LegacyEmployee {
  id: number;
  code: string;
  name: string;
  email: string;
  phone: string;
  department_id: number | null;
  position_id: number | null;
  status: string;
  start_date: string;
  created_at: string;
}

interface LegacyEmployeeHistory {
  id: number;
  employee_id: number | null;
  employee_code: string;
  employee_name: string;
  entity: string;
  actor_email: string;
  changes: string;
  created_at: string;
}

interface LegacyDb {
  prepare(sql: string): {
    get(...args: unknown[]): unknown;
    all(...args: string[]): unknown[];
    run(...args: unknown[]): { lastInsertRowid: number | bigint; changes: number };
  };
  exec(sql: string): void;
}

async function migrateCommunicationData() {
  const { db } = require('../db') as { db: LegacyDb };
  const { callService } = require('../service-client') as {
    callService: (path: string, options: { method: 'POST'; body: object }) => Promise<unknown>;
  };
  const tableExists = (name: string) => !!db.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(name);
  const hasNotifications = tableExists('notifications');
  const hasAuditLogs = tableExists('audit_logs');
  if (!hasNotifications && !hasAuditLogs) return;

  const notifications = hasNotifications
    ? db.prepare('SELECT id, user_id, title, message, href, created_at, read_at FROM notifications ORDER BY id')
      .all() as LegacyNotification[]
    : [];
  const auditLogs = hasAuditLogs
    ? db.prepare('SELECT id, at, user_email, action FROM audit_logs ORDER BY id').all() as LegacyAuditLog[]
    : [];
  const batchSize = 50;
  for (let i = 0; i < Math.max(notifications.length, auditLogs.length); i += batchSize) {
    await callService('/internal/v1/migrate', {
      method: 'POST',
      body: {
        notifications: notifications.slice(i, i + batchSize),
        audit_logs: auditLogs.slice(i, i + batchSize),
      },
    });
  }
  db.exec('DROP TABLE IF EXISTS notifications; DROP TABLE IF EXISTS audit_logs;');
}

async function migrateConfigData() {
  const { db } = require('../db') as { db: LegacyDb };
  const { callConfigService } = require('../config-client') as {
    callConfigService: (path: string, options: { method: 'POST'; body: object }) => Promise<unknown>;
  };
  const tableExists = (name: string) => !!db.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(name);
  const hasSettings = tableExists('settings');
  const hasHolidays = tableExists('holidays');
  if (!hasSettings && !hasHolidays) return;

  const settings = hasSettings
    ? db.prepare('SELECT key, value FROM settings ORDER BY key').all() as LegacySetting[]
    : [];
  const holidays = hasHolidays
    ? db.prepare('SELECT date, name FROM holidays ORDER BY date').all() as LegacyHoliday[]
    : [];
  const batchSize = 500;
  for (let i = 0; i < Math.max(settings.length, holidays.length); i += batchSize) {
    await callConfigService('/internal/v1/migrate', {
      method: 'POST',
      body: {
        settings: settings.slice(i, i + batchSize),
        holidays: holidays.slice(i, i + batchSize),
      },
    });
  }
  db.exec('DROP TABLE IF EXISTS settings; DROP TABLE IF EXISTS holidays;');
}

async function migrateIdentityData() {
  const { db } = require('../db') as { db: LegacyDb };
  const { callIdentityService } = require('../identity-client') as {
    callIdentityService: (path: string, options: { method: 'POST'; body: object }) => Promise<unknown>;
  };
  const tableExists = (name: string) => !!db.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(name);
  const hasUsers = tableExists('users');
  const hasResetTokens = tableExists('password_reset_tokens');
  if (!hasUsers && !hasResetTokens) return;

  if (hasUsers) {
    const columns = db.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'must_change_password')) {
      db.exec('ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 1 CHECK (must_change_password IN (0,1))');
    }
  }

  const users = hasUsers
    ? db.prepare(`SELECT id, email, name, password_hash, role, must_change_password, created_at
      FROM users ORDER BY id`).all() as LegacyIdentityUser[]
    : [];
  const resetTokens = hasUsers && hasResetTokens
    ? db.prepare(`SELECT t.token_hash, t.user_id, t.expires_at FROM password_reset_tokens t
      JOIN users u ON u.id = t.user_id ORDER BY t.token_hash`).all() as LegacyResetToken[]
    : [];
  const batchSize = 500;
  for (let i = 0; i < users.length; i += batchSize) {
    await callIdentityService('/internal/v1/migrate', {
      method: 'POST',
      body: {
        users: users.slice(i, i + batchSize),
        password_reset_tokens: [],
      },
    });
  }
  for (let i = 0; i < resetTokens.length; i += batchSize) {
    await callIdentityService('/internal/v1/migrate', {
      method: 'POST',
      body: {
        users: [],
        password_reset_tokens: resetTokens.slice(i, i + batchSize),
      },
    });
  }
  db.exec('DROP TABLE IF EXISTS password_reset_tokens; DROP TABLE IF EXISTS users;');
}

async function migrateEmployeeData() {
  const { db } = require('../db') as { db: LegacyDb };
  const { callEmployeeService } = require('../employee-client') as {
    callEmployeeService: (path: string, options: { method: 'POST'; body: object }) => Promise<unknown>;
  };
  const tableExists = (name: string) => !!db.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(name);
  const departments = tableExists('departments')
    ? db.prepare('SELECT id, name FROM departments ORDER BY id').all() as LegacyDepartment[]
    : [];
  const positions = tableExists('positions')
    ? db.prepare('SELECT id, name FROM positions ORDER BY id').all() as LegacyPosition[]
    : [];
  const employees = tableExists('employees')
    ? db.prepare(`SELECT id, code, name, email, phone, department_id, position_id, status, start_date, created_at
      FROM employees ORDER BY id`).all() as LegacyEmployee[]
    : [];
  const history = tableExists('employee_history')
    ? db.prepare(`SELECT id, employee_id, employee_code, employee_name, entity, actor_email, changes, created_at
      FROM employee_history ORDER BY id`).all() as LegacyEmployeeHistory[]
    : [];
  const batchSize = 500;
  const batches = Math.max(1, Math.ceil(Math.max(departments.length, positions.length, employees.length, history.length) / batchSize));
  for (let batch = 0; batch < batches; batch++) {
    const start = batch * batchSize;
    await callEmployeeService('/internal/v1/migrate', {
      method: 'POST',
      body: {
        departments: departments.slice(start, start + batchSize),
        positions: positions.slice(start, start + batchSize),
        employees: employees.slice(start, start + batchSize),
        employee_history: history.slice(start, start + batchSize),
      },
    });
  }
}

export async function createApp() {
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  const server = app.getHttpAdapter().getInstance();

  server.disable('x-powered-by');
  server.set('trust proxy', 'loopback');
  server.use(express.json({ limit: '1mb' }));
  server.use((_req: Request, res: Response, next: NextFunction) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
    });
    next();
  });
  server.get('/health', (_req: Request, res: Response) => res.json({ status: 'ok', service: 'hrm-core' }));
  server.post('/internal/v1/employees/ensure', (req: Request, res: Response) => {
    const expected = process.env.INTERNAL_SERVICE_TOKEN
      || (process.env.NODE_ENV === 'production' ? '' : 'dev-only-internal-service-token');
    const provided = req.headers['x-internal-service-token'];
    const authorized = typeof provided === 'string' && expected.length > 0
      && Buffer.byteLength(expected) === Buffer.byteLength(provided)
      && timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
    if (!authorized) return res.status(401).json({ error: 'Invalid service credentials' });

    const name = String(req.body?.name || '').trim();
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.status(400).json({ error: 'Employee name and email are required' });
    }
    const { db } = require('../db') as { db: LegacyDb };
    const existing = db.prepare('SELECT id FROM employees WHERE email = ?').get(email) as { id: number } | undefined;
    if (existing) return res.json({ id: existing.id, created: false });

    const { nextEmployeeCode } = require('../lib') as { nextEmployeeCode: () => string };
    const result = db.prepare(`INSERT INTO employees(code, name, email, status, start_date)
      VALUES (?, ?, ?, 'Chờ cập nhật', '')`).run(nextEmployeeCode(), name, email);
    return res.status(201).json({ id: Number(result.lastInsertRowid), created: true });
  });
  const routes = app.get<LegacyApiRoute[]>(LEGACY_API_ROUTES, { strict: false });
  routes.forEach(({ path: routePath, handler }) => server.use(routePath, handler));
  server.use('/api', (_req: Request, res: Response) => res.status(404).json({ error: 'Không tìm thấy API' }));
  server.use(express.static(path.join(__dirname, '..', 'public')));
  server.use((err: Error & { type?: string; statusCode?: number; code?: string }, _req: Request, res: Response, _next: NextFunction) => {
    if (err.type === 'entity.parse.failed') {
      console.error(err);
      return res.status(400).json({ error: 'Dữ liệu gửi lên không hợp lệ' });
    }
    if (err.statusCode === 503) {
      console.error(err.message);
      return res.status(503).json({ error: err.message, code: err.code || 'DEPENDENCY_UNAVAILABLE' });
    }
    if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
      return res.status(err.statusCode).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
    }
    console.error(err);
    return res.status(500).json({ error: 'Lỗi hệ thống, vui lòng thử lại' });
  });

  await app.init();
  await migrateCommunicationData();
  await migrateConfigData();
  await migrateIdentityData();
  await migrateEmployeeData();
  const { refreshConfigCache, startConfigCacheRefresh } = require('../config-cache') as {
    refreshConfigCache: () => Promise<void>;
    startConfigCacheRefresh: () => void;
  };
  await refreshConfigCache();
  startConfigCacheRefresh();
  return app;
}
