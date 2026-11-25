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

interface LegacyAttendance {
  id: number;
  employee_id: number;
  date: string;
  check_in: string | null;
  check_out: string | null;
  note: string;
  source: string;
}

interface LegacyLeaveType {
  id: number;
  name: string;
  paid: number;
  uses_quota: number;
}

interface LegacyLeaveRequest {
  id: number;
  employee_id: number;
  type_id: number;
  from_date: string;
  to_date: string;
  half: number;
  days: number;
  reason: string;
  status: string;
  manager_note: string;
  decided_by: string;
  created_at: string;
}

interface LegacyOvertimeRequest {
  id: number;
  employee_id: number;
  date: string;
  hours: number;
  reason: string;
  status: string;
  manager_note: string;
  decided_by: string;
  created_at: string;
}

interface LegacyPayrollRow {
  [key: string]: string | number | null;
}

interface LegacyDb {
  prepare(sql: string): {
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
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
    callEmployeeService: (path: string, options: { method: 'GET' | 'POST'; body?: object }) => Promise<unknown>;
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
    const result = await callEmployeeService('/internal/v1/migrate', {
      method: 'POST',
      body: {
        departments: departments.slice(start, start + batchSize),
        positions: positions.slice(start, start + batchSize),
        employees: employees.slice(start, start + batchSize),
        employee_history: history.slice(start, start + batchSize),
      },
    }) as { migrated_departments: number; migrated_positions: number; migrated_employees: number; migrated_history: number };
    const expected = {
      migrated_departments: departments.slice(start, start + batchSize).length,
      migrated_positions: positions.slice(start, start + batchSize).length,
      migrated_employees: employees.slice(start, start + batchSize).length,
      migrated_history: history.slice(start, start + batchSize).length,
    };
    if (Object.entries(expected).some(([key, count]) => result[key as keyof typeof expected] !== count)) {
      throw new Error('Employee migration batch verification failed; Core data was retained');
    }
  }

  const serviceEmployees = await callEmployeeService('/internal/v1/employees', { method: 'GET' }) as LegacyEmployee[];
  const serviceById = new Map(serviceEmployees.map((employee) => [employee.id, employee]));
  for (const employee of employees) {
    const migrated = serviceById.get(employee.id);
    if (!migrated || migrated.code !== employee.code || migrated.email.toLowerCase() !== employee.email.toLowerCase()) {
      throw new Error(`Employee migration verification failed for legacy employee ID ${employee.id}; Core data was retained`);
    }
  }
  const serviceDepartments = await callEmployeeService('/internal/v1/departments', { method: 'GET' }) as LegacyDepartment[];
  const serviceDepartmentById = new Map(serviceDepartments.map((department) => [department.id, department]));
  for (const department of departments) {
    const migrated = serviceDepartmentById.get(department.id);
    if (!migrated || migrated.name !== department.name) {
      throw new Error(`Department migration verification failed for legacy department ID ${department.id}; Core data was retained`);
    }
  }
  const servicePositions = await callEmployeeService('/internal/v1/positions', { method: 'GET' }) as LegacyPosition[];
  const servicePositionById = new Map(servicePositions.map((position) => [position.id, position]));
  for (const position of positions) {
    const migrated = servicePositionById.get(position.id);
    if (!migrated || migrated.name !== position.name) {
      throw new Error(`Position migration verification failed for legacy position ID ${position.id}; Core data was retained`);
    }
  }
  dropLegacyEmployeeData(db);
}

async function migrateAttendanceData() {
  const { db } = require('../db') as { db: LegacyDb };
  const { callAttendanceService } = require('../attendance-client') as {
    callAttendanceService: (path: string, options: { method: 'GET' | 'POST'; body?: object }) => Promise<unknown>;
  };
  const tableExists = !!db.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'attendances'",
  ).get();
  if (!tableExists) return;

  const records = db.prepare(`SELECT id, employee_id, date, check_in, check_out, note, source
    FROM attendances ORDER BY id`).all() as LegacyAttendance[];
  for (let index = 0; index < records.length; index += 500) {
    const batch = records.slice(index, index + 500);
    const result = await callAttendanceService('/internal/v1/migrate', {
      method: 'POST',
      body: { records: batch },
    }) as { migrated_records: number };
    if (result.migrated_records !== batch.length) {
      throw new Error('Attendance migration batch verification failed; Core data was retained');
    }
  }

  for (let index = 0; index < records.length; index += 100) {
    const batch = records.slice(index, index + 100);
    const query = new URLSearchParams({ ids: batch.map((record) => String(record.id)).join(',') });
    const imported = await callAttendanceService(`/internal/v1/attendance?${query}`, { method: 'GET' }) as LegacyAttendance[];
    const importedById = new Map(imported.map((record) => [record.id, record]));
    for (const record of batch) {
      const saved = importedById.get(record.id);
      if (!saved || saved.employee_id !== record.employee_id || saved.date !== record.date
        || saved.check_in !== record.check_in || saved.check_out !== record.check_out
        || saved.note !== record.note || saved.source !== record.source) {
        throw new Error(`Attendance migration verification failed for row ${record.id}; Core data was retained`);
      }
    }
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('DROP TABLE attendances;');
    db.exec('COMMIT;');
  } catch (error) {
    db.exec('ROLLBACK;');
    throw error;
  }
}

async function migrateLeaveData() {
  const { db } = require('../db') as { db: LegacyDb };
  const { callLeaveService } = require('../leave-client') as {
    callLeaveService: (path: string, options?: { method?: 'GET' | 'POST'; body?: object }) => Promise<unknown>;
  };
  const tableExists = (name: string) => !!db.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(name);
  const hasTypes = tableExists('leave_types');
  const hasLeave = tableExists('leave_requests');
  const hasOvertime = tableExists('overtime_requests');
  const types = hasTypes
    ? db.prepare('SELECT id, name, paid, uses_quota FROM leave_types ORDER BY id').all() as LegacyLeaveType[]
    : [];
  const leaveRequests = hasLeave
    ? db.prepare(`SELECT id, employee_id, type_id, from_date, to_date, half, days, reason, status,
      manager_note, decided_by, created_at FROM leave_requests ORDER BY id`).all() as LegacyLeaveRequest[]
    : [];
  const overtimeRequests = hasOvertime
    ? db.prepare(`SELECT id, employee_id, date, hours, reason, status, manager_note, decided_by, created_at
      FROM overtime_requests ORDER BY id`).all() as LegacyOvertimeRequest[]
    : [];

  const batchSize = 500;
  const batchCount = Math.max(1, Math.ceil(Math.max(types.length, leaveRequests.length, overtimeRequests.length) / batchSize));
  for (let batch = 0; batch < batchCount; batch++) {
    const start = batch * batchSize;
    const typeBatch = types.slice(start, start + batchSize);
    const leaveBatch = leaveRequests.slice(start, start + batchSize);
    const overtimeBatch = overtimeRequests.slice(start, start + batchSize);
    const result = await callLeaveService('/internal/v1/migrate', {
      method: 'POST',
      body: {
        leave_types: typeBatch,
        leave_requests: leaveBatch,
        overtime_requests: overtimeBatch,
      },
    }) as {
      migrated_types: number;
      migrated_leave_requests: number;
      migrated_overtime_requests: number;
    };
    if ((typeBatch.length && result.migrated_types !== typeBatch.length)
      || result.migrated_leave_requests !== leaveBatch.length
      || result.migrated_overtime_requests !== overtimeBatch.length) {
      throw new Error('Leave and Overtime migration batch verification failed; Core data was retained');
    }
  }

  const serviceTypes = await callLeaveService('/internal/v1/leave/types') as LegacyLeaveType[];
  const serviceTypesById = new Map(serviceTypes.map((type) => [type.id, type]));
  for (const type of types) {
    const migrated = serviceTypesById.get(type.id);
    if (!migrated || migrated.name !== type.name || migrated.paid !== type.paid
      || migrated.uses_quota !== type.uses_quota) {
      throw new Error(`Leave type migration verification failed for ID ${type.id}; Core data was retained`);
    }
  }

  for (let index = 0; index < leaveRequests.length; index += 100) {
    const batch = leaveRequests.slice(index, index + 100);
    const query = new URLSearchParams({ ids: batch.map((request) => String(request.id)).join(',') });
    const imported = await callLeaveService(`/internal/v1/leave/requests/by-record-ids?${query}`) as LegacyLeaveRequest[];
    const importedById = new Map(imported.map((request) => [request.id, request]));
    for (const request of batch) {
      const saved = importedById.get(request.id);
      if (!saved || saved.employee_id !== request.employee_id || saved.type_id !== request.type_id
        || saved.from_date !== request.from_date || saved.to_date !== request.to_date
        || saved.half !== request.half || saved.days !== request.days || saved.reason !== request.reason
        || saved.status !== request.status || saved.manager_note !== request.manager_note
        || saved.decided_by !== request.decided_by || saved.created_at !== request.created_at) {
        throw new Error(`Leave migration verification failed for row ${request.id}; Core data was retained`);
      }
    }
  }
  for (let index = 0; index < overtimeRequests.length; index += 100) {
    const batch = overtimeRequests.slice(index, index + 100);
    const query = new URLSearchParams({ ids: batch.map((request) => String(request.id)).join(',') });
    const imported = await callLeaveService(`/internal/v1/overtime/requests/by-record-ids?${query}`) as LegacyOvertimeRequest[];
    const importedById = new Map(imported.map((request) => [request.id, request]));
    for (const request of batch) {
      const saved = importedById.get(request.id);
      if (!saved || saved.employee_id !== request.employee_id || saved.date !== request.date
        || saved.hours !== request.hours || saved.reason !== request.reason || saved.status !== request.status
        || saved.manager_note !== request.manager_note || saved.decided_by !== request.decided_by
        || saved.created_at !== request.created_at) {
        throw new Error(`Overtime migration verification failed for row ${request.id}; Core data was retained`);
      }
    }
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('DROP TABLE IF EXISTS leave_requests; DROP TABLE IF EXISTS overtime_requests; DROP TABLE IF EXISTS leave_types;');
    db.exec('COMMIT;');
  } catch (error) {
    db.exec('ROLLBACK;');
    throw error;
  }
}

async function migratePayrollData() {
  const { db } = require('../db') as { db: LegacyDb };
  const { callPayrollService } = require('../payroll-client') as {
    callPayrollService: (path: string, options?: { method?: 'GET' | 'POST'; body?: object }) => Promise<unknown>;
  };
  const tableExists = (name: string) => !!db.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(name);
  const tables = ['employee_salary', 'payroll_periods', 'payslips', 'payroll_adjustments', 'advance_requests'];
  if (!tables.some(tableExists)) return;

  if (tableExists('payslips')) {
    const columns = db.prepare('PRAGMA table_info(payslips)').all() as Array<{ name: string }>;
    ['bonus', 'penalty', 'advance', 'overtime_hours', 'overtime_pay'].forEach((column) => {
      if (!columns.some((item) => item.name === column)) {
        db.exec(`ALTER TABLE payslips ADD COLUMN ${column} ${column === 'overtime_hours' ? 'REAL' : 'INTEGER'} NOT NULL DEFAULT 0`);
      }
    });
  }

  const records: Record<string, LegacyPayrollRow[]> = {
    salaries: tableExists('employee_salary')
      ? db.prepare('SELECT * FROM employee_salary ORDER BY employee_id').all() as LegacyPayrollRow[]
      : [],
    periods: tableExists('payroll_periods')
      ? db.prepare('SELECT * FROM payroll_periods ORDER BY id').all() as LegacyPayrollRow[]
      : [],
    payslips: tableExists('payslips')
      ? db.prepare('SELECT * FROM payslips ORDER BY id').all() as LegacyPayrollRow[]
      : [],
    adjustments: tableExists('payroll_adjustments')
      ? db.prepare('SELECT * FROM payroll_adjustments ORDER BY id').all() as LegacyPayrollRow[]
      : [],
    advances: tableExists('advance_requests')
      ? db.prepare('SELECT * FROM advance_requests ORDER BY id').all() as LegacyPayrollRow[]
      : [],
  };
  const resultKeys: Record<string, string> = {
    salaries: 'migrated_salaries',
    periods: 'migrated_periods',
    payslips: 'migrated_payslips',
    adjustments: 'migrated_adjustments',
    advances: 'migrated_advances',
  };
  for (const collection of Object.keys(records)) {
    const rows = records[collection];
    for (let index = 0; index < rows.length; index += 250) {
      const batch = rows.slice(index, index + 250);
      const result = await callPayrollService('/internal/v1/migrate', {
        method: 'POST',
        body: { [collection]: batch },
      }) as Record<string, number>;
      if (result[resultKeys[collection]] !== batch.length) {
        throw new Error(`Payroll ${collection} migration batch verification failed; Core data was retained`);
      }
    }
  }

  for (const collection of Object.keys(records)) {
    const rows = records[collection];
    for (let index = 0; index < rows.length; index += 100) {
      const batch = rows.slice(index, index + 100);
      const idColumn = collection === 'salaries' ? 'employee_id' : 'id';
      const query = new URLSearchParams({ ids: batch.map((row) => String(row[idColumn])).join(',') });
      const imported = await callPayrollService(
        `/internal/v1/migration-records/${collection}?${query}`,
      ) as LegacyPayrollRow[];
      const importedById = new Map(imported.map((row) => [row[idColumn], row]));
      for (const row of batch) {
        const id = row[idColumn];
        const saved = importedById.get(id);
        if (!saved || Object.keys(row).some((key) => saved[key] !== row[key])) {
          throw new Error(`Payroll ${collection} migration verification failed for record ${id}; Core data was retained`);
        }
      }
    }
  }

  db.exec('BEGIN IMMEDIATE;');
  try {
    db.exec(`DROP TABLE IF EXISTS advance_requests;
      DROP TABLE IF EXISTS payslips;
      DROP TABLE IF EXISTS payroll_adjustments;
      DROP TABLE IF EXISTS payroll_periods;
      DROP TABLE IF EXISTS employee_salary;`);
    db.exec('COMMIT;');
  } catch (error) {
    db.exec('ROLLBACK;');
    throw error;
  }
}

function dropLegacyEmployeeData(db: LegacyDb) {
  const employeeTables = [
    'attendances', 'leave_requests', 'overtime_requests',
    'employee_salary', 'payslips', 'payroll_adjustments', 'advance_requests',
  ];
  const legacyParents = ['employees', 'employee_history', 'departments', 'positions'];
  const tableExists = (name: string) => !!db.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(name);
  const rebuild = employeeTables.flatMap((table) => {
    if (!tableExists(table)) return [];
    const definition = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql: string } | undefined;
    if (!definition?.sql || !/REFERENCES\s+employees\s*\(\s*id\s*\)/i.test(definition.sql)) return [];
    const indexes = db.prepare("SELECT sql FROM sqlite_master WHERE tbl_name = ? AND type IN ('index','trigger') AND sql IS NOT NULL")
      .all(table) as Array<{ sql: string }>;
    const temporary = `__employee_cutover_${table}`;
    const tableNamePattern = new RegExp(`^(CREATE TABLE(?: IF NOT EXISTS)?\\s+)"?${table}"?`, 'i');
    const createTable = definition.sql
      .replace(tableNamePattern, `$1"${temporary}"`)
      .replace(/\s+REFERENCES\s+employees\s*\(\s*id\s*\)(?:\s+ON\s+DELETE\s+(?:CASCADE|RESTRICT|SET NULL))?/gi, '');
    if (createTable === definition.sql || !createTable.includes(`"${temporary}"`)) {
      throw new Error(`Could not safely rebuild Core table ${table} without the Employee foreign key`);
    }
    return [{ table, temporary, createTable, indexes }];
  });

  db.exec('PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE;');
  try {
    for (const { table, temporary, createTable, indexes } of rebuild) {
      db.exec(`DROP TABLE IF EXISTS "${temporary}"; ${createTable};`);
      db.exec(`INSERT INTO "${temporary}" SELECT * FROM "${table}"; DROP TABLE "${table}"; ALTER TABLE "${temporary}" RENAME TO "${table}";`);
      indexes.forEach(({ sql }) => db.exec(sql));
    }
    legacyParents.forEach((table) => db.exec(`DROP TABLE IF EXISTS "${table}";`));
    const violations = db.prepare('PRAGMA foreign_key_check').all();
    if (violations.length) throw new Error('Foreign key check failed after Employee cutover');
    db.exec('COMMIT; PRAGMA foreign_keys = ON;');
  } catch (error) {
    db.exec('ROLLBACK; PRAGMA foreign_keys = ON;');
    throw error;
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
    const { callEmployeeService } = require('../employee-client') as {
      callEmployeeService: (path: string, options: { method: 'POST'; body: object }) => Promise<{ id: number; created: boolean }>;
    };
    return callEmployeeService('/internal/v1/employees/ensure', {
      method: 'POST',
      body: { name, email },
    }).then((result) => res.status(result.created ? 201 : 200).json(result));
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
  await migrateLeaveData();
  await migrateAttendanceData();
  await migratePayrollData();
  const { refreshConfigCache, startConfigCacheRefresh } = require('../config-cache') as {
    refreshConfigCache: () => Promise<void>;
    startConfigCacheRefresh: () => void;
  };
  await refreshConfigCache();
  startConfigCacheRefresh();
  return app;
}
