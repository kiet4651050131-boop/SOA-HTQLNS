// Kiem thu nhanh toan bo API (dung CSDL tam trong bo nho): npm test
process.env.DB_FILE = ':memory:';
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-123';
process.env.EMAIL_DB_FILE = ':memory:';
process.env.CONFIG_DB_FILE = ':memory:';
process.env.IDENTITY_DB_FILE = ':memory:';
process.env.EMPLOYEE_DB_FILE = ':memory:';
process.env.ATTENDANCE_DB_FILE = ':memory:';
process.env.LEAVE_DB_FILE = ':memory:';
process.env.PAYROLL_DB_FILE = ':memory:';
process.env.INTERNAL_SERVICE_TOKEN = 'test-internal-service-token';
process.env.NOTIFICATION_SERVICE_TIMEOUT_MS = '200';
process.env.CONFIG_SERVICE_TIMEOUT_MS = '200';
process.env.IDENTITY_SERVICE_TIMEOUT_MS = '3000';
process.env.EMPLOYEE_SERVICE_TIMEOUT_MS = '200';
process.env.ATTENDANCE_SERVICE_TIMEOUT_MS = '200';
process.env.LEAVE_SERVICE_TIMEOUT_MS = '200';
process.env.PAYROLL_SERVICE_TIMEOUT_MS = '200';
for (const key of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'APP_URL']) {
  process.env[key] = '';
}
const assert = require('assert');
const { createHash } = require('node:crypto');
const bcrypt = require('bcryptjs');
const net = require('node:net');
const http = require('node:http');
const { createApp } = require('./dist/app');
const { createGateway } = require('./dist/gateway');
const { createEmailApp } = require('./dist/email-main');
const { createConfigApp } = require('./dist/config-main');
const { createIdentityApp } = require('./dist/identity-main');
const { createEmployeeApp } = require('./dist/employee-main');
const { createAttendanceApp } = require('./dist/attendance-main');
const { createLeaveApp } = require('./dist/leave-main');
const { createPayrollApp } = require('./dist/payroll-main');
const { payrollPeriod, payrollPayslips, payrollAdjustments, payrollAdvances, payrollSalaries } = require('./payroll-client');
const L = require('./lib');

(async () => {
  const { db } = require('./db');
  const legacyResetToken = 'a'.repeat(64);
  const passwordHash = await bcrypt.hash('secret1234', 10);
  db.exec(`CREATE TABLE departments (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE COLLATE NOCASE
  );
  CREATE TABLE positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE COLLATE NOCASE
  );
  CREATE TABLE employees (
    id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE, phone TEXT NOT NULL DEFAULT '',
    department_id INTEGER REFERENCES departments(id) ON DELETE RESTRICT,
    position_id INTEGER REFERENCES positions(id) ON DELETE RESTRICT,
    status TEXT NOT NULL DEFAULT 'Thử việc', start_date TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE employee_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT, employee_id INTEGER, employee_code TEXT NOT NULL,
    employee_name TEXT NOT NULL, entity TEXT NOT NULL, actor_email TEXT NOT NULL,
    changes TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );
  INSERT INTO departments(id, name) VALUES (1, 'Kinh doanh'), (2, 'Kỹ thuật'), (3, 'Hành chính');
  INSERT INTO positions(id, name) VALUES (1, 'Nhân viên'), (2, 'Trưởng nhóm'), (3, 'Giám đốc');`);
  db.exec(`CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'employee',
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE password_reset_tokens (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );`);
  db.prepare('INSERT INTO users(id, email, name, password_hash, role) VALUES (?, ?, ?, ?, ?)')
    .run(1, 'admin@cty.vn', 'Admin', passwordHash, 'admin');
  db.prepare('INSERT INTO password_reset_tokens(token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .run(createHash('sha256').update(legacyResetToken).digest('hex'), 1, Date.now() + 60 * 60 * 1000);
  db.prepare(`INSERT INTO employees(code, name, email, status, start_date)
    VALUES ('NV001', 'Admin', 'admin@cty.vn', 'Chờ cập nhật', '')`).run();
  db.exec(`CREATE TABLE attendances (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      date TEXT NOT NULL, check_in TEXT, check_out TEXT, note TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'web', UNIQUE (employee_id, date)
    );
    CREATE INDEX idx_att_date ON attendances(date);`);
  db.prepare('INSERT INTO attendances(employee_id, date, check_in) VALUES (?, ?, ?)')
    .run(1, '2019-01-01', '09:00');
  db.exec(`CREATE TABLE leave_types (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE,
    paid INTEGER NOT NULL DEFAULT 1, uses_quota INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE leave_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT, employee_id INTEGER NOT NULL,
    type_id INTEGER NOT NULL REFERENCES leave_types(id), from_date TEXT NOT NULL, to_date TEXT NOT NULL,
    half INTEGER NOT NULL DEFAULT 0, days REAL NOT NULL, reason TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'Chờ HR', manager_note TEXT NOT NULL DEFAULT '',
    decided_by TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE overtime_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT, employee_id INTEGER NOT NULL, date TEXT NOT NULL,
    hours REAL NOT NULL, reason TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'Chờ HR',
    manager_note TEXT NOT NULL DEFAULT '', decided_by TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );
  INSERT INTO leave_types(id, name, paid, uses_quota)
    VALUES (1, 'Phép năm', 1, 1), (2, 'Nghỉ ốm', 1, 0), (3, 'Nghỉ không lương', 0, 0);
  INSERT INTO leave_requests(id, employee_id, type_id, from_date, to_date, half, days, reason, status,
    manager_note, decided_by, created_at)
    VALUES (9000, 1, 1, '2020-01-02', '2020-01-02', 0, 1, 'legacy-leave-migration',
      'Đã duyệt', '', 'admin@cty.vn', '2020-01-01 08:00:00');
  INSERT INTO overtime_requests(id, employee_id, date, hours, reason, status, manager_note, decided_by, created_at)
    VALUES (9000, 1, '2020-01-03', 2, 'legacy-overtime-migration', 'Đã duyệt', '',
      'admin@cty.vn', '2020-01-02 08:00:00');`);
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec(`CREATE TABLE employee_salary (
    employee_id INTEGER PRIMARY KEY REFERENCES employees(id) ON DELETE CASCADE,
    base_salary INTEGER NOT NULL DEFAULT 0,
    allowance INTEGER NOT NULL DEFAULT 0, exempt_allowance INTEGER NOT NULL DEFAULT 0,
    dependents INTEGER NOT NULL DEFAULT 0, insured INTEGER NOT NULL DEFAULT 1,
    insured_salary INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE payroll_periods (
    id INTEGER PRIMARY KEY AUTOINCREMENT, month TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'Nháp', created_by TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')), locked_at TEXT
  );
  CREATE TABLE payslips (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    period_id INTEGER NOT NULL REFERENCES payroll_periods(id) ON DELETE CASCADE,
    employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
    employee_code TEXT NOT NULL, employee_name TEXT NOT NULL,
    department TEXT NOT NULL DEFAULT '', std_days REAL NOT NULL, paid_days REAL NOT NULL,
    present_days REAL NOT NULL, paid_leave_days REAL NOT NULL, unpaid_leave_days REAL NOT NULL,
    absent_days REAL NOT NULL,
    base_salary INTEGER NOT NULL, allowance INTEGER NOT NULL,
    gross INTEGER NOT NULL, insurance INTEGER NOT NULL, dependents INTEGER NOT NULL,
    taxable INTEGER NOT NULL, tax INTEGER NOT NULL, net INTEGER NOT NULL,
    bonus INTEGER NOT NULL DEFAULT 0, penalty INTEGER NOT NULL DEFAULT 0, advance INTEGER NOT NULL DEFAULT 0,
    overtime_hours REAL NOT NULL DEFAULT 0, overtime_pay INTEGER NOT NULL DEFAULT 0,
    UNIQUE (period_id, employee_id)
  );
  CREATE TABLE payroll_adjustments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    period_id INTEGER NOT NULL REFERENCES payroll_periods(id) ON DELETE CASCADE,
    employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    type TEXT NOT NULL, amount INTEGER NOT NULL CHECK (amount > 0),
    note TEXT NOT NULL DEFAULT '', created_by TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE advance_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE, month TEXT NOT NULL,
    amount INTEGER NOT NULL CHECK (amount > 0), note TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'Chờ duyệt', reviewed_by TEXT NOT NULL DEFAULT '',
    review_note TEXT NOT NULL DEFAULT '',
    adjustment_id INTEGER REFERENCES payroll_adjustments(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')), decided_at TEXT
  );
  INSERT INTO employee_salary(employee_id, base_salary, allowance, exempt_allowance, dependents, insured, insured_salary)
    VALUES (9000, 1000000, 100000, 0, 0, 1, 1000000);
  INSERT INTO payroll_periods(id, month, status, created_by, created_at)
    VALUES (9000, '2020-01', 'Nháp', 'admin@cty.vn', '2020-01-01 08:00:00');
  INSERT INTO payslips(id, period_id, employee_id, employee_code, employee_name, department, std_days, paid_days,
    present_days, paid_leave_days, unpaid_leave_days, absent_days, base_salary, allowance, gross, insurance,
    dependents, taxable, tax, net, bonus, penalty, advance, overtime_hours, overtime_pay)
    VALUES (9000, 9000, 9000, 'LEGACY9000', 'Legacy Payroll Fixture', '', 23, 23, 23, 0, 0, 0, 1000000, 100000,
      1100000, 100000, 0, 0, 0, 1000000, 0, 0, 0, 0, 0);
  INSERT INTO payroll_adjustments(id, period_id, employee_id, type, amount, note, created_by, created_at)
    VALUES (9000, 9000, 9000, 'bonus', 5000, 'legacy-adjustment', 'admin@cty.vn', '2020-01-01 09:00:00');
  INSERT INTO advance_requests(id, employee_id, month, amount, note, status, reviewed_by, review_note, created_at)
    VALUES (9000, 9000, '2020-01', 1000, 'legacy-advance', 'Từ chối', 'admin@cty.vn', 'legacy-review',
      '2020-01-02 09:00:00');`);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`CREATE TABLE audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    user_email TEXT NOT NULL,
    action TEXT NOT NULL
  );
  CREATE TABLE notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    message TEXT NOT NULL DEFAULT '',
    href TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    read_at TEXT
  );
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE holidays (
    date TEXT PRIMARY KEY,
    name TEXT NOT NULL
  );`);
  db.prepare('INSERT INTO audit_logs(id, user_email, action) VALUES (?, ?, ?)')
    .run(9000, 'migration@example.com', 'legacy-audit-migration');
  db.prepare('INSERT INTO notifications(id, user_id, title, message, href) VALUES (?, ?, ?, ?, ?)')
    .run(9000, 1, 'legacy-notification-migration', 'old notification', '/');
  db.prepare('INSERT INTO settings(key, value) VALUES (?, ?)').run('work_start', '09:00');
  db.prepare('INSERT INTO holidays(date, name) VALUES (?, ?)').run('2020-05-01', 'legacy-holiday-migration');

  const emailApp = await createEmailApp();
  await emailApp.listen(0, '127.0.0.1');
  const emailServer = emailApp.getHttpServer();
  process.env.EMAIL_SERVICE_URL = `http://127.0.0.1:${emailServer.address().port}`;
  const configApp = await createConfigApp();
  await configApp.listen(0, '127.0.0.1');
  const configServer = configApp.getHttpServer();
  process.env.CONFIG_SERVICE_URL = `http://127.0.0.1:${configServer.address().port}`;
  const identityApp = await createIdentityApp();
  await identityApp.listen(0, '127.0.0.1');
  const identityServer = identityApp.getHttpServer();
  process.env.IDENTITY_SERVICE_URL = `http://127.0.0.1:${identityServer.address().port}`;
  const employeeApp = await createEmployeeApp();
  await employeeApp.listen(0, '127.0.0.1');
  const employeeServer = employeeApp.getHttpServer();
  process.env.EMPLOYEE_SERVICE_URL = `http://127.0.0.1:${employeeServer.address().port}`;
  const leaveApp = await createLeaveApp();
  await leaveApp.listen(0, '127.0.0.1');
  const leaveServer = leaveApp.getHttpServer();
  process.env.LEAVE_SERVICE_URL = `http://127.0.0.1:${leaveServer.address().port}`;
  const attendanceApp = await createAttendanceApp();
  await attendanceApp.listen(0, '127.0.0.1');
  const attendanceServer = attendanceApp.getHttpServer();
  process.env.ATTENDANCE_SERVICE_URL = `http://127.0.0.1:${attendanceServer.address().port}`;
  const payrollApp = await createPayrollApp();
  await payrollApp.listen(0, '127.0.0.1');
  const payrollServer = payrollApp.getHttpServer();
  process.env.PAYROLL_SERVICE_URL = `http://127.0.0.1:${payrollServer.address().port}`;
  const nestApp = await createApp();
  await nestApp.listen(0);
  const srv = nestApp.getHttpServer();
  process.env.CORE_SERVICE_URL = `http://127.0.0.1:${srv.address().port}`;
  const gatewayServer = createGateway({
    coreServiceUrl: `http://127.0.0.1:${srv.address().port}`,
    identityServiceUrl: process.env.IDENTITY_SERVICE_URL,
    timeoutMs: 1000,
  }).listen(0);
  await new Promise((resolve) => gatewayServer.once('listening', resolve));
  const gatewayBase = `http://127.0.0.1:${gatewayServer.address().port}`;
  const base = `${gatewayBase}/api`;
  const call = async (m, p, b, t) => {
    const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: b ? JSON.stringify(b) : undefined });
    return { s: r.status, d: await r.json().catch(() => ({})) };
  };
  let n = 0; const ok = (c, m) => { assert(c, m); n++; };
  ok(!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table'
    AND name IN ('audit_logs', 'notifications', 'settings', 'holidays', 'users', 'password_reset_tokens',
      'employees', 'employee_history', 'departments', 'positions')`).get(),
  'legacy communication, configuration, identity, and Employee tables are dropped after migration');
  ok(!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'attendances'").get(),
    'legacy Attendance table is removed from Core after migration');
  ok(!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name IN ('leave_types', 'leave_requests', 'overtime_requests')").get(),
    'legacy Leave and Overtime tables are removed from Core after migration');
  ok(!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table'
    AND name IN ('employee_salary', 'payroll_periods', 'payslips', 'payroll_adjustments', 'advance_requests')`).get(),
  'legacy Payroll tables are removed from Core after verified migration');
  const migratedLeave = await fetch(`${process.env.LEAVE_SERVICE_URL}/internal/v1/leave/requests/by-record-ids?ids=9000`, {
    headers: { 'X-Internal-Service-Token': process.env.INTERNAL_SERVICE_TOKEN },
  });
  const migratedLeaveRows = await migratedLeave.json();
  ok(migratedLeave.status === 200 && migratedLeaveRows[0]?.reason === 'legacy-leave-migration',
    'leave data migrates into the independent Leave database');
  const migratedOvertime = await fetch(`${process.env.LEAVE_SERVICE_URL}/internal/v1/overtime/requests/by-record-ids?ids=9000`, {
    headers: { 'X-Internal-Service-Token': process.env.INTERNAL_SERVICE_TOKEN },
  });
  const migratedOvertimeRows = await migratedOvertime.json();
  ok(migratedOvertime.status === 200 && migratedOvertimeRows[0]?.reason === 'legacy-overtime-migration',
    'overtime data migrates into the independent Leave database');
  const migratedAttendance = await fetch(`${process.env.ATTENDANCE_SERVICE_URL}/internal/v1/attendance?employee_id=1&from=2019-01-01&to=2019-01-01`, {
    headers: { 'X-Internal-Service-Token': process.env.INTERNAL_SERVICE_TOKEN },
  });
  ok(migratedAttendance.status === 200 && (await migratedAttendance.json())[0]?.check_in === '09:00',
    'attendance data survives Employee foreign-key rebuild and migrates to its own service database');
  const migratedPeriod = await payrollPeriod(9000);
  const migratedSlips = await payrollPayslips(9000);
  const migratedAdjustments = await payrollAdjustments(9000);
  const migratedAdvances = await payrollAdvances(9000);
  const migratedSalaries = await payrollSalaries([9000]);
  ok(migratedPeriod.month === '2020-01' && migratedSlips[0]?.employee_code === 'LEGACY9000'
    && migratedAdjustments[0]?.note === 'legacy-adjustment'
    && migratedAdvances[0]?.note === 'legacy-advance'
    && migratedSalaries[0]?.base_salary === 1000000,
  'salary, period, payslip, adjustment, and advance records migrate intact to Payroll Service');
  const page = await fetch(`http://127.0.0.1:${srv.address().port}/`);
  ok(page.status === 200 && page.headers.get('content-type').includes('text/html'), 'NestJS host serves frontend');
  const gatewayPage = await fetch(gatewayBase + '/');
  ok(gatewayPage.status === 200 && gatewayPage.headers.get('content-type').includes('text/html'), 'Gateway serves frontend');
  const gatewayHealth = await fetch(gatewayBase + '/health');
  ok(gatewayHealth.status === 200 && (await gatewayHealth.json()).service === 'hrm-api-gateway', 'Gateway has independent health endpoint');
  const gatewayInternal = await fetch(gatewayBase + '/internal/v1/audit');
  ok(gatewayInternal.status === 404, 'Gateway does not expose internal service endpoints');
  const emailHealth = await fetch(process.env.EMAIL_SERVICE_URL + '/health');
  ok(emailHealth.status === 200 && (await emailHealth.json()).service === 'hrm-email-service', 'Email service has independent health endpoint');
  const configHealth = await fetch(process.env.CONFIG_SERVICE_URL + '/health');
  ok(configHealth.status === 200 && (await configHealth.json()).service === 'hrm-config-service', 'Config service has independent health endpoint');
  const identityHealth = await fetch(process.env.IDENTITY_SERVICE_URL + '/health');
  ok(identityHealth.status === 200 && (await identityHealth.json()).service === 'hrm-identity-service', 'Identity service has independent health endpoint');
  const employeeHealth = await fetch(process.env.EMPLOYEE_SERVICE_URL + '/health');
  ok(employeeHealth.status === 200 && (await employeeHealth.json()).service === 'hrm-employee-service', 'Employee service has independent health endpoint');
  const attendanceHealth = await fetch(process.env.ATTENDANCE_SERVICE_URL + '/health');
  ok(attendanceHealth.status === 200 && (await attendanceHealth.json()).service === 'hrm-attendance-service', 'Attendance service has independent health endpoint');
  const leaveHealth = await fetch(process.env.LEAVE_SERVICE_URL + '/health');
  ok(leaveHealth.status === 200 && (await leaveHealth.json()).service === 'hrm-leave-service', 'Leave service has independent health endpoint');
  const payrollHealth = await fetch(process.env.PAYROLL_SERVICE_URL + '/health');
  ok(payrollHealth.status === 200 && (await payrollHealth.json()).service === 'hrm-payroll-service', 'Payroll service has independent health endpoint');
  const unauthorizedEmail = await fetch(process.env.EMAIL_SERVICE_URL + '/internal/v1/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to: 'nobody@example.com', subject: 'test', text: 'test' }),
  });
  ok(unauthorizedEmail.status === 401, 'Email service rejects unauthenticated internal calls');
  const unauthorizedNotification = await fetch(process.env.EMAIL_SERVICE_URL + '/internal/v1/notifications?userId=1');
  ok(unauthorizedNotification.status === 401, 'Notification service rejects unauthenticated internal calls');
  const unauthorizedConfig = await fetch(process.env.CONFIG_SERVICE_URL + '/internal/v1/settings');
  ok(unauthorizedConfig.status === 401, 'Config service rejects unauthenticated internal calls');
  const unauthorizedIdentity = await fetch(process.env.IDENTITY_SERVICE_URL + '/internal/v1/users');
  ok(unauthorizedIdentity.status === 401, 'Identity service rejects unauthenticated internal calls');
  const unauthorizedEmployee = await fetch(process.env.EMPLOYEE_SERVICE_URL + '/internal/v1/employees');
  ok(unauthorizedEmployee.status === 401, 'Employee service rejects unauthenticated internal calls');
  const unauthorizedAttendance = await fetch(process.env.ATTENDANCE_SERVICE_URL + '/internal/v1/attendance');
  ok(unauthorizedAttendance.status === 401, 'Attendance service rejects unauthenticated internal calls');
  const unauthorizedLeave = await fetch(process.env.LEAVE_SERVICE_URL + '/internal/v1/leave/types');
  ok(unauthorizedLeave.status === 401, 'Leave service rejects unauthenticated internal calls');
  const unauthorizedPayroll = await fetch(process.env.PAYROLL_SERVICE_URL + '/internal/v1/payroll/periods');
  ok(unauthorizedPayroll.status === 401, 'Payroll service rejects unauthenticated internal calls');
  const migratedEmployee = await fetch(`${process.env.EMPLOYEE_SERVICE_URL}/internal/v1/employees?email=admin%40cty.vn`, {
    headers: { 'X-Internal-Service-Token': process.env.INTERNAL_SERVICE_TOKEN },
  });
  ok(migratedEmployee.status === 200 && (await migratedEmployee.json()).length === 1,
    'legacy employee data is copied into Employee Service before Core starts');
  const employeeInternalHeaders = {
    'Content-Type': 'application/json',
    'X-Internal-Service-Token': process.env.INTERNAL_SERVICE_TOKEN,
  };
  const employeeCreated = await fetch(`${process.env.EMPLOYEE_SERVICE_URL}/internal/v1/employees`, {
    method: 'POST',
    headers: employeeInternalHeaders,
    body: JSON.stringify({ code: 'SVC001', name: 'Service Employee', email: 'service-employee@cty.vn' }),
  });
  const employeeCreatedBody = await employeeCreated.json();
  ok(employeeCreated.status === 201 && employeeCreatedBody.id,
    'Employee Service creates employee records in its own database');
  const employeeRead = await fetch(`${process.env.EMPLOYEE_SERVICE_URL}/internal/v1/employees/${employeeCreatedBody.id}`, {
    headers: employeeInternalHeaders,
  });
  ok(employeeRead.status === 200 && (await employeeRead.json()).email === 'service-employee@cty.vn',
    'Employee Service returns records by employee ID');
  const duplicateEmployee = await fetch(`${process.env.EMPLOYEE_SERVICE_URL}/internal/v1/employees`, {
    method: 'POST',
    headers: employeeInternalHeaders,
    body: JSON.stringify({ code: 'SVC001', name: 'Duplicate', email: 'duplicate@cty.vn' }),
  });
  ok(duplicateEmployee.status === 409, 'Employee Service rejects duplicate employee codes');
  const employeeDeleted = await fetch(`${process.env.EMPLOYEE_SERVICE_URL}/internal/v1/employees/${employeeCreatedBody.id}`, {
    method: 'DELETE',
    headers: employeeInternalHeaders,
  });
  ok(employeeDeleted.status === 200, 'Employee Service removes isolated integration-test employee');
  const unauthorizedEmployeeEnsure = await fetch(`${process.env.CORE_SERVICE_URL}/internal/v1/employees/ensure`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'No Key', email: 'no-key@example.com' }),
  });
  ok(unauthorizedEmployeeEnsure.status === 401, 'Core employee ensure rejects unauthenticated internal calls');
  const removedCoreLeaveQuery = await fetch(`${process.env.CORE_SERVICE_URL}/internal/v1/leave/approved?ids=1&from=2020-01-01&to=2020-01-31`);
  ok(removedCoreLeaveQuery.status === 404, 'Core no longer owns an internal Leave API after the service cutover');
  const gatewayStatus = await fetch(gatewayBase + '/api/auth/status');
  const gatewayStatusBody = await gatewayStatus.json();
  ok(gatewayStatus.status === 200 && gatewayStatusBody.registrationOpen === false,
    `Gateway forwards API requests to core: ${gatewayStatus.status} ${JSON.stringify(gatewayStatusBody)}`);
  const gatewayInvalidJson = await fetch(gatewayBase + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{',
  });
  ok(gatewayInvalidJson.status === 400, 'Gateway preserves core request validation errors');
  const gatewayMissing = await fetch(gatewayBase + '/api/missing');
  ok(gatewayMissing.status === 401 && (await gatewayMissing.json()).error, 'Gateway preserves core API errors');

  const slowCore = http.createServer((_req, res) => {
    setTimeout(() => res.end('late'), 200);
  });
  slowCore.listen(0);
  await new Promise((resolve) => slowCore.once('listening', resolve));
  const timeoutGateway = createGateway({
    coreServiceUrl: `http://127.0.0.1:${slowCore.address().port}`,
    timeoutMs: 25,
  }).listen(0);
  await new Promise((resolve) => timeoutGateway.once('listening', resolve));
  const timedOut = await fetch(`http://127.0.0.1:${timeoutGateway.address().port}/api/auth/status`);
  const timeoutBody = await timedOut.json();
  ok(timedOut.status === 503 && timeoutBody.code === 'CORE_SERVICE_UNAVAILABLE', 'Gateway returns explicit 503 on service timeout');
  await new Promise((resolve) => timeoutGateway.close(resolve));
  await new Promise((resolve) => slowCore.close(resolve));
  const invalidJson = await fetch(base + '/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{',
  });
  ok(invalidJson.status === 400, 'invalid JSON stays a 400 response');
  const login = async (e) => {
    const result = await call('POST', '/auth/login', { email: e, password: 'secret1234' });
    if (result.d.user.must_change_password) {
      await call('POST', '/auth/change-password', { current: 'secret1234', next: 'secret1234' }, result.d.token);
    }
    return result.d.token;
  };
  ok(L.csvCell('=1+1') === "'=1+1", 'CSV escape cong thuc spreadsheet');

  // Identity migrates existing credentials and owns subsequent account changes.
  ok((await call('GET', '/auth/status')).d.registrationOpen === false, 'tai khoan cu duoc migrate sang Identity Service');
  ok((await call('POST', '/auth/register', { name: 'X', email: 'bad', password: '123456' })).s === 400, 'email sai');
  ok((await call('POST', '/auth/register', { name: 'Admin', email: 'admin@cty.vn', password: 'secret1' })).s === 400, 'tu choi mat khau duoi 8 ky tu');
  ok((await call('POST', '/auth/register', { name: 'Admin', email: 'admin@cty.vn', password: 'secret1234' })).s === 403,
    'khong mo dang ky Admin khi Identity da co tai khoan');
  const A = await login('admin@cty.vn');
  ok((await call('POST', '/auth/reset-password', { token: legacyResetToken, password: 'secret1234' })).s === 200,
    'legacy password reset token is migrated to Identity Service');
  const identityUsers = await fetch(`${process.env.IDENTITY_SERVICE_URL}/internal/v1/users`, {
    headers: { 'X-Internal-Service-Token': process.env.INTERNAL_SERVICE_TOKEN },
  });
  ok(identityUsers.status === 200 && (await identityUsers.json()).some((user) => user.email === 'admin@cty.vn'),
    'legacy credentials are copied to Identity database');
  const migratedNotification = await call('GET', '/notifications', null, A);
  ok(migratedNotification.s === 200
    && migratedNotification.d.notifications.some((item) => item.title === 'legacy-notification-migration'),
  'legacy notifications are copied into the owned service database');
  const migratedAudit = await call('GET', '/logs', null, A);
  ok(migratedAudit.s === 200 && migratedAudit.d.some((item) => item.action === 'legacy-audit-migration'),
    'legacy audit history is copied into the owned service database');
  const migratedSettings = await call('GET', '/settings', null, A);
  ok(migratedSettings.s === 200 && migratedSettings.d.work_start === '09:00',
    'legacy settings are copied into the owned Config Service database');
  const migratedHolidays = await call('GET', '/holidays?year=2020', null, A);
  ok(migratedHolidays.s === 200
    && migratedHolidays.d.some((item) => item.date === '2020-05-01' && item.name === 'legacy-holiday-migration'),
  'legacy holidays are copied into the owned Config Service database');
  ok((await call('PUT', '/settings', { work_start: '08:30' }, A)).s === 200,
    'configuration updates are saved through Config Service');
  ok((await call('DELETE', '/holidays/2020-05-01', null, A)).s === 200,
    'holiday deletion is handled by Config Service');
  ok((await call('GET', '/missing', null, A)).s === 404, 'unknown API stays a JSON 404');

  // Admin / HR tao tai khoan
  const mk = (b, t = A) => call('POST', '/users', { password: 'secret1234', ...b }, t);
  ok((await mk({ name: 'An', email: 'an@cty.vn' })).s === 201, 'admin tao tai khoan nhan vien');
  ok((await mk({ name: 'Binh', email: 'binh@cty.vn' })).s === 201, 'admin tao tai khoan thu hai');
  ok((await mk({ name: 'Trung', email: 'an@cty.vn' })).s === 409, 'trung email');
  ok((await mk({ name: 'X', email: 'bad' })).s === 400, 'email tao tai khoan sai');
  ok((await mk({ name: 'X', email: 'x@cty.vn', role: 'boss' })).s === 400, 'vai tro sai');
  ok((await mk({ name: 'X', email: 'x@cty.vn', password: '1234567' })).s === 400, 'mat khau ngan');
  const gen = (await call('POST', '/users', { name: 'Gen', email: 'gen@cty.vn' }, A)).d;
  ok(gen.temporaryPassword && gen.temporaryPassword.length >= 8, 'khong gui mat khau thi sinh mat khau tam');
  const genLogin = await call('POST', '/auth/login', { email: 'gen@cty.vn', password: gen.temporaryPassword });
  ok(genLogin.s === 200 && genLogin.d.user.must_change_password === 1, 'dang nhap bang mat khau tam bat buoc doi');
  ok((await call('GET', '/employees', null, genLogin.d.token)).s === 403, 'bat buoc doi mat khau truoc khi dung API');
  ok((await call('POST', '/auth/change-password', { current: gen.temporaryPassword, next: 'short7' }, genLogin.d.token)).s === 400, 'khong cho doi mat khau ngan');
  ok((await call('POST', '/auth/change-password', { current: gen.temporaryPassword, next: 'private123' }, genLogin.d.token)).s === 200, 'doi duoc mat khau tam');
  ok((await call('GET', '/employees', null, genLogin.d.token)).s === 200, 'mo khoa API sau khi doi mat khau');
  await call('DELETE', '/users/' + gen.id, null, A);
  const hrAcc = (await mk({ name: 'Hoa', email: 'hoa@cty.vn', role: 'hr' })).d;
  ok(hrAcc.id, 'admin tao duoc tai khoan HR');
  const H = await login('hoa@cty.vn');
  ok((await mk({ name: 'Nhan vien moi', email: 'moi@cty.vn' }, H)).s === 201, 'HR tao tai khoan nhan vien');
  ok((await mk({ name: 'Admin 2', email: 'a2@cty.vn', role: 'admin' }, H)).s === 403, 'HR khong tao admin');
  ok((await mk({ name: 'Y', email: 'y@cty.vn' }, await login('an@cty.vn'))).s === 403, 'nhan vien khong tao tai khoan');
  // don dep de cac kiem tra phia duoi giu nguyen so luong: xoa tai khoan va ho so phat sinh them
  for (const em of ['hoa@cty.vn', 'moi@cty.vn']) {
    const u = (await call('GET', '/users', null, A)).d.find((x) => x.email === em);
    await call('DELETE', '/users/' + u.id, null, A);
    const emp = (await call('GET', '/employees?q=' + em, null, A)).d[0];
    await call('DELETE', '/employees/' + emp.id, null, A);
  }
  {
    const emp = (await call('GET', '/employees?q=gen@cty.vn', null, A)).d[0];
    if (emp) await call('DELETE', '/employees/' + emp.id, null, A);
  }
  ok((await call('POST', '/auth/login', { email: 'an@cty.vn', password: 'sai' })).s === 401, 'sai mat khau');
  ok((await call('GET', '/employees')).s === 401, 'khong token');
  const U1 = await login('an@cty.vn'), U2 = await login('binh@cty.vn');
  const spoofedIdentity = await fetch(`${gatewayBase}/api/users`, {
    headers: {
      Authorization: `Bearer ${U1}`,
      'X-Internal-Service-Token': process.env.INTERNAL_SERVICE_TOKEN,
      'X-User-Role': 'admin',
      'X-User-Id': String(A),
    },
  });
  ok(spoofedIdentity.status === 403, 'Gateway overwrites forged identity headers with introspected claims');

  // Phan quyen xem ho so
  const adminEmployees = await call('GET', '/employees', null, A);
  ok(adminEmployees.s === 200 && adminEmployees.d.length === 3,
    'admin thay tat ca');
  const mine = (await call('GET', '/employees', null, U1)).d;
  ok(mine.length === 1 && mine[0].email === 'an@cty.vn', 'nhan vien chi thay minh');
  ok((await call('GET', '/users', null, U1)).s === 403, 'employee khong xem tai khoan');
  ok((await call('GET', '/logs', null, U1)).s === 403, 'employee khong xem nhat ky');
  ok((await call('POST', '/employees', { code: 'X', name: 'X', email: 'x@x.vn' }, U1)).s === 403, 'employee khong them');
  ok((await call('POST', '/employees', { code: 'BADPHONE', name: 'Test', email: 'badphone@cty.vn', phone: '123' }, A)).s === 400, 'tu choi SDT khong hop le');
  ok((await call('POST', '/employees', { code: 'BADDATE', name: 'Test', email: 'baddate@cty.vn', start_date: '2026-02-31' }, A)).s === 400, 'tu choi ngay vao lam khong hop le');

  // Co cau to chuc
  const dept = (await call('POST', '/departments', { name: 'Ke toan' }, A)).d;
  ok(dept.id, 'them phong ban');
  ok((await call('POST', '/departments', { name: 'ke toan' }, A)).s === 409, 'trung ten khong phan biet hoa thuong');
  ok((await call('POST', '/departments', { name: 'Y' }, U1)).s === 403, 'employee khong them phong ban');

  // CRUD nhan vien
  const add = await call('POST', '/employees', { code: 'NV100', name: 'Chau', email: 'chau@cty.vn', department_id: dept.id, status: 'Chính thức' }, A);
  ok(add.s === 201, 'them nhan vien');
  ok((await call('POST', '/employees', { code: 'NV100', name: 'D', email: 'd@cty.vn' }, A)).s === 400, 'trung ma');
  ok((await call('DELETE', '/departments/' + dept.id, null, A)).s === 409, 'khong xoa phong ban dang dung');
  ok((await call('PUT', '/employees/' + add.d.id, { name: 'Chau Nguyen' }, A)).s === 200, 'sua nhan vien');
  ok((await call('GET', '/employees?q=chau', null, A)).d[0].name === 'Chau Nguyen', 'tim kiem');
  ok((await call('GET', '/employees?department_id=' + dept.id, null, A)).d.length === 1, 'loc phong ban');
  const protectedEmployee = await call('POST', '/employees', {
    code: 'NVDEL', name: 'Delete Guard', email: 'delete-guard@cty.vn',
  }, A);
  ok(protectedEmployee.s === 201, 'employee for related-data deletion guard is created');
  const attendanceForGuard = await fetch(`${process.env.ATTENDANCE_SERVICE_URL}/internal/v1/attendance`, {
    method: 'POST',
    headers: employeeInternalHeaders,
    body: JSON.stringify({ employee_id: protectedEmployee.d.id, date: '2020-01-02' }),
  });
  ok(attendanceForGuard.status === 201, 'Attendance Service stores deletion-guard fixture in its own DB');
  ok((await call('DELETE', '/employees/' + protectedEmployee.d.id, null, A)).s === 409,
    'employee deletion is blocked while Attendance Service data exists');
  const deleteAttendanceFixture = await fetch(`${process.env.ATTENDANCE_SERVICE_URL}/internal/v1/attendance?employee_id=${protectedEmployee.d.id}&date=2020-01-02`, {
    method: 'DELETE',
    headers: { 'X-Internal-Service-Token': process.env.INTERNAL_SERVICE_TOKEN },
  });
  ok(deleteAttendanceFixture.status === 200, 'Attendance Service cleans up deletion-guard fixture');
  ok((await call('DELETE', '/employees/' + protectedEmployee.d.id, null, A)).s === 200,
    'employee can be deleted after related attendance data is removed');

  // Nhan vien chi sua SDT cua minh
  ok((await call('PUT', '/employees/' + mine[0].id, { phone: '0901234567', name: 'Hack', status: 'Chính thức' }, U1)).s === 200);
  const after = (await call('GET', '/employees', null, U1)).d[0];
  ok(after.phone === '0901234567' && after.name === 'An' && after.status === 'Chờ cập nhật', 'chi doi duoc SDT');
  ok((await call('PUT', '/employees/' + mine[0].id, { phone: '123' }, U1)).s === 400, 'tu choi SDT khong hop le');
  ok((await call('PUT', '/employees/' + add.d.id, { phone: '1' }, U1)).s === 404, 'khong sua ho so nguoi khac');

  // Import CSV
  const imp = (await call('POST', '/employees/import', { csv: 'code,name,email,phong ban,chuc danh\nNV200,Dung,dung@cty.vn,Kỹ thuật,Nhân viên\nNV201,Em,sai-email,Kỹ thuật,\nNV200,Trung,t@cty.vn,,' }, A)).d;
  ok(imp.imported === 1 && imp.errors.length === 2, 'import co bao loi tung dong');

  // Quan ly
  const mgrId = (await call('GET', '/users', null, A)).d.find((u) => u.email === 'binh@cty.vn').id;
  ok((await call('PUT', `/users/${mgrId}/role`, { role: 'manager' }, A)).s === 200, 'doi vai tro');
  const me = (await call('GET', '/employees', null, U2)).d[0];
  await call('PUT', '/employees/' + me.id, { department_id: dept.id }, A);
  const seen = (await call('GET', '/employees', null, U2)).d.map((e) => e.email).sort();
  ok(seen.join() === 'binh@cty.vn,chau@cty.vn', 'quan ly thay cung phong ban');

  // ===== Cham cong =====
  await call('PUT', '/employees/' + mine[0].id, { department_id: dept.id }, A); // An cung phong ban voi quan ly Binh
  ok((await call('GET', '/attendance/today', null, U1)).d.check_in === null, 'chua check-in');
  ok((await call('POST', '/attendance/check-in', null, U1)).s === 200, 'check-in');
  ok((await call('POST', '/attendance/check-in', null, U1)).s === 400, 'khong check-in 2 lan');
  ok((await call('POST', '/attendance/check-out', null, U1)).s === 200, 'check-out');
  ok((await call('POST', '/attendance/check-out', null, U1)).s === 400, 'khong check-out 2 lan');
  ok((await call('PUT', '/attendance', { employee_id: mine[0].id, date: '2026-09-07', check_in: '08:00' }, U1)).s === 403, 'nhan vien khong sua cong');
  ok((await call('PUT', '/attendance', { employee_id: mine[0].id, date: '2026-09-07', check_in: '09:00', check_out: '08:00' }, A)).s === 400, 'gio ra truoc gio vao');
  ok((await call('GET', '/attendance/month/' + add.d.id + '?month=2026-09', null, U1)).s === 404, 'khong xem cong nguoi khac');
  ok((await call('GET', '/attendance/month?month=2026-13', null, A)).s === 400, 'thang sai');

  // ===== Ngay le & cau hinh =====
  ok((await call('POST', '/holidays', { date: '2026-09-02', name: 'Quoc khanh' }, U1)).s === 403, 'nhan vien khong them ngay le');
  ok((await call('POST', '/holidays', { date: '2026-09-02', name: 'Quoc khanh' }, A)).s === 201, 'them ngay le');
  ok((await call('POST', '/holidays', { date: '2026-09-02', name: 'Trung' }, A)).s === 409, 'trung ngay le');
  ok((await call('PUT', '/settings', { tax_brackets: '10:5;5:10;*:35' }, A)).s === 400, 'bieu thue sai thu tu');
  ok((await call('PUT', '/settings', { bhxh_rate: '150' }, A)).s === 400, 'ty le > 100');
  ok((await call('PUT', '/settings', { overtime_rate: '4' }, A)).s === 400, 'hệ số tăng ca ngoài phạm vi bị từ chối');
  ok((await call('GET', '/settings', null, U1)).s === 403, 'nhan vien khong xem cau hinh');

  // ===== Nghi phep =====
  const types = (await call('GET', '/leave/types', null, U1)).d;
  const annual = types.find((t) => t.name === 'Phép năm').id;
  const l1 = await call('POST', '/leave', { type_id: annual, from_date: '2027-03-01', to_date: '2027-03-02', reason: 'Viec rieng' }, U1);
  ok(l1.s === 201 && l1.d.status === 'Chờ quản lý' && l1.d.days === 2, 'don cua nhan vien vao buoc quan ly duyet');
  ok((await call('POST', '/leave', { type_id: annual, from_date: '2027-03-02', to_date: '2027-03-03' }, U1)).s === 400, 'trung thoi gian');
  ok((await call('POST', '/leave', { type_id: annual, from_date: '2027-03-06', to_date: '2027-03-07' }, U1)).s === 400, 'chi gom cuoi tuan');
  ok((await call('POST', '/leave', { type_id: annual, from_date: '2027-05-03', to_date: '2027-05-28' }, U1)).s === 400, 'vuot so ngay phep');
  ok((await call('POST', '/leave', { type_id: annual, from_date: '2027-12-30', to_date: '2028-01-04' }, U1)).s === 400, 'khong vat qua nam');
  ok((await call('PUT', `/leave/${l1.d.id}/decide`, { action: 'approve' }, U1)).s === 403, 'khong tu duyet don cua minh');
  ok((await call('GET', '/leave', null, U1)).d.length === 1, 'nhan vien chi thay don cua minh');
  const step1 = await call('PUT', `/leave/${l1.d.id}/decide`, { action: 'approve' }, U2);
  ok(step1.s === 200 && step1.d.status === 'Chờ HR', 'quan ly duyet -> cho HR');
  ok((await call('PUT', `/leave/${l1.d.id}/decide`, { action: 'approve' }, U2)).s === 403, 'quan ly khong duyet buoc HR');
  ok((await call('PUT', `/leave/${l1.d.id}/decide`, { action: 'approve' }, A)).d.status === 'Đã duyệt', 'HR duyet cuoi');
  const bal = (await call('GET', '/leave/balance?year=2027', null, U1)).d;
  ok(bal.quota === 12 && bal.used === 2 && bal.remaining === 10, 'so du phep');
  const l2 = await call('POST', '/leave', { type_id: annual, from_date: '2027-04-05', to_date: '2027-04-05', half: true }, U1);
  ok(l2.d.days === 0.5, 'nghi nua ngay');
  ok((await call('PUT', `/leave/${l2.d.id}/cancel`, null, U1)).s === 200, 'huy don cho duyet');
  ok((await call('PUT', `/leave/${l2.d.id}/decide`, { action: 'approve' }, A)).s === 403, 'khong duyet don da huy');
  const l3 = await call('POST', '/leave', { type_id: annual, from_date: '2027-06-01', to_date: '2027-06-01' }, U1);
  ok((await call('PUT', `/leave/${l3.d.id}/decide`, { action: 'reject', note: 'Ban viec' }, U2)).d.status === 'Từ chối', 'tu choi don');
  ok((await call('GET', '/leave/balance?year=2027', null, U1)).d.remaining === 10, 'don tu choi khong tru phep');

  // ===== Luong: du lieu thang 9/2026 (21 cong chuan sau khi tru le 2/9) =====
  const days = []; // cac ngay lam viec thang 9/2026
  for (let d = 1; d <= 30; d++) { const dt = new Date(2026, 8, d); if (dt.getDay() % 6 && d !== 2) days.push(`2026-09-${String(d).padStart(2, '0')}`); }
  ok(days.length === 21, 'thang 9/2026 co 21 ngay cong');
  const anCode = mine[0].code;
  // An: nghi phep co luong ngay thu 3, vang ngay thu 4, di lam 19 ngay con lai
  const lp = await call('POST', '/leave', { type_id: annual, from_date: days[2], to_date: days[2] }, U1);
  await call('PUT', `/leave/${lp.d.id}/decide`, { action: 'approve' }, U2);
  await call('PUT', `/leave/${lp.d.id}/decide`, { action: 'approve' }, A);
  const rows = days.filter((_, i) => i !== 2 && i !== 3).map((d) => `${anCode},${d},08:00,17:00`);
  days.forEach((d) => rows.push(`NV200,${d.split('-').reverse().join('/')},08:10:00,17:30:00`)); // Dung: du 21 ngay, dinh dang DD/MM/YYYY
  rows.push('NV999,2026-09-01,08:00,17:00', 'NV200,2026-09-01,xx,17:00');
  const impAtt = (await call('POST', '/attendance/import', { csv: 'ma,ngay,vao,ra\n' + rows.join('\n') }, A)).d;
  ok(impAtt.imported === 19 + 21 && impAtt.errors.length === 2, 'import cham cong bao loi tung dong');
  const empCsvResponse = await fetch(`${base}/employees/export`, { headers: { Authorization: 'Bearer ' + A } });
  const empCsv = await empCsvResponse.text();
  ok(empCsvResponse.status === 200 && empCsv.includes('NV200') && empCsv.includes('Mã nhân viên'), 'xuất CSV danh sách nhân viên');
  ok((await fetch(`${base}/employees/export`, { headers: { Authorization: 'Bearer ' + U1 } })).status === 403, 'nhân viên không xuất danh sách người khác');
  const managerCsv = await (await fetch(`${base}/employees/export`, { headers: { Authorization: 'Bearer ' + U2 } })).text();
  ok(managerCsv.includes(mine[0].code) && !managerCsv.includes('NV200'), 'CSV quản lý chỉ gồm nhân viên trong phạm vi phòng ban');
  const attCsvResponse = await fetch(`${base}/attendance/export?month=2026-09`, { headers: { Authorization: 'Bearer ' + A } });
  const attCsv = await attCsvResponse.text();
  ok(attCsvResponse.status === 200 && attCsv.includes('2026-09-01') && attCsv.includes('NV200'), 'xuất CSV chấm công theo tháng');
  const sum = (await call('GET', `/attendance/month/${mine[0].id}?month=2026-09`, null, A)).d.summary;
  ok(sum.std_days === 21 && sum.present === 19 && sum.paid_leave === 1 && sum.absent === 1 && sum.late === 0, 'tong hop bang cong cua An');
  const departmentAttendance = await call('GET', `/attendance/month?month=2026-09&department_id=${dept.id}`, null, U2);
  ok(departmentAttendance.s === 200 && departmentAttendance.d.length > 0 && departmentAttendance.d.every((row) => row.department === 'Ke toan'), 'lọc bảng công theo phòng ban mà vẫn giữ phạm vi quản lý');
  ok((await call('GET', `/attendance/month?month=2026-09&department_id=99999`, null, A)).s === 400, 'phòng ban lọc bảng công không hợp lệ bị từ chối');
  const dungId = (await call('GET', '/employees?q=NV200', null, A)).d[0].id;
  ok((await call('GET', `/attendance/month/${dungId}?month=2026-09`, null, A)).d.summary.late === 0, 'Dung 08:10 khong tre');
  const lockedLeave = await call('POST', '/leave', { type_id: annual, from_date: '2026-09-10', to_date: '2026-09-10', reason: 'Chờ duyệt' }, U1);
  ok(lockedLeave.s === 201, 'tạo trước đơn nghỉ chờ duyệt');
  const lockedOvertime = await call('POST', '/overtime', { date: '2026-09-11', hours: 2, reason: 'Chờ duyệt' }, U1);
  ok(lockedOvertime.s === 201, 'tạo trước đề nghị tăng ca chờ duyệt');

  ok((await call('PUT', `/payroll/salary/${mine[0].id}`, { base_salary: 20000000 }, U1)).s === 403, 'nhan vien khong dat luong');
  ok((await call('PUT', `/payroll/salary/${mine[0].id}`, { base_salary: -5 }, A)).s === 400, 'luong am');
  await call('PUT', `/payroll/salary/${mine[0].id}`, { base_salary: 20000000, allowance: 2000000, dependents: 1 }, A);
  await call('PUT', `/payroll/salary/${dungId}`, { base_salary: 40000000 }, A);
  ok((await call('GET', '/payroll/salary', null, U2)).s === 403, 'quan ly khong xem luong');

  // ===== Ung luong trong thang =====
  const savedToday = L.today, savedCurMonth = L.curMonth;
  const accruedDate = new Date(2099, 0, 1);
  while (accruedDate.getDay() === 0 || accruedDate.getDay() === 6) accruedDate.setDate(accruedDate.getDate() + 1);
  const accruedMonth = `${accruedDate.getFullYear()}-${String(accruedDate.getMonth() + 1).padStart(2, '0')}`;
  const accruedDay = `${accruedMonth}-${String(accruedDate.getDate()).padStart(2, '0')}`;
  L.today = () => accruedDay;
  L.curMonth = () => accruedMonth;
  try {
    ok((await call('PUT', '/attendance', {
      employee_id: mine[0].id, date: accruedDay, check_in: '08:30', check_out: '17:00',
    }, A)).s === 200, 'ghi nhận công để kiểm thử lương tạm tính');
    const advanceView = (await call('GET', '/payroll/advances', null, U1)).d;
    ok(advanceView.summary.credited_days === 1 && advanceView.summary.accrued_gross > 0 && advanceView.summary.available > 0,
      'lương tạm tính tăng theo công hoàn tất');
    ok((await call('POST', '/payroll/advances', { amount: 1, note: 'Xin ứng' }, U2)).s === 400,
      'không cho ứng khi chưa thiết lập lương');
    ok((await call('POST', '/payroll/advances', { amount: advanceView.summary.available + 1, note: 'Vượt hạn mức' }, U1)).s === 400,
      'chặn yêu cầu vượt hạn mức');
    const advance = await call('POST', '/payroll/advances', {
      amount: advanceView.summary.available, note: 'Chi phí cá nhân',
    }, U1);
    ok(advance.s === 201, 'nhân viên gửi yêu cầu ứng trong hạn mức');
    ok((await call('POST', '/payroll/advances', { amount: 1, note: 'Xin thêm' }, U1)).s === 400,
      'yêu cầu chờ duyệt giữ chỗ hạn mức');
    ok((await call('PUT', `/payroll/advances/${advance.d.id}/decision`, { action: 'approve' }, U1)).s === 403,
      'nhân viên không tự duyệt ứng lương');
    ok((await call('GET', '/payroll/advances', null, A)).d.requests.some((r) => r.id === advance.d.id),
      'HR xem được yêu cầu ứng lương');
    ok((await call('PUT', `/payroll/advances/${advance.d.id}/decision`, { action: 'approve' }, A)).s === 200,
      'HR duyệt yêu cầu ứng');
    ok((await call('PUT', `/payroll/advances/${advance.d.id}/decision`, { action: 'approve' }, A)).s === 409,
      'không duyệt trùng yêu cầu');
    const afterAdvance = (await call('GET', '/payroll/advances', null, U1)).d;
    ok(afterAdvance.requests[0].status === 'Đã duyệt' && afterAdvance.summary.advanced === advance.d.amount &&
      afterAdvance.summary.available === 0, 'khoản đã duyệt được ghi nhận và trừ hạn mức');
    ok((await call('DELETE', `/employees/${mine[0].id}`, null, A)).s === 409,
      'giữ hồ sơ nhân viên có lịch sử ứng lương');
    const advancePeriod = (await call('GET', '/payroll/periods', null, A)).d.find((p) => p.month === accruedMonth);
    ok(!!advancePeriod, 'tự tạo kỳ Nháp khi duyệt ứng lương');
    const advanceAdjustments = (await call('GET', `/payroll/periods/${advancePeriod.id}/adjustments`, null, A)).d;
    const linkedAdvance = advanceAdjustments.find((a) => a.type === 'advance');
    ok(!!linkedAdvance && (await call('DELETE', `/payroll/periods/${advancePeriod.id}/adjustments/${linkedAdvance.id}`, null, A)).s === 409,
      'không xóa khoản ứng đã liên kết với yêu cầu duyệt');
    ok((await call('DELETE', `/payroll/periods/${advancePeriod.id}`, null, A)).s === 409,
      'không xóa kỳ lương chứa khoản ứng đã duyệt');
    await call('POST', `/payroll/periods/${advancePeriod.id}/calculate`, null, A);
    const advanceSlip = (await call('GET', `/payroll/periods/${advancePeriod.id}/payslips`, null, A)).d.payslips
      .find((s) => s.employee_code === anCode);
    ok(advanceSlip.advance === advance.d.amount, 'ứng đã duyệt được trừ vào bảng lương tháng');
  } finally {
    L.today = savedToday;
    L.curMonth = savedCurMonth;
  }

  const per = await call('POST', '/payroll/periods', { month: '2026-09' }, A);
  ok(per.s === 201 && (await call('POST', '/payroll/periods', { month: '2026-09' }, A)).s === 409, 'tao ky luong, khong trung');
  ok((await call('POST', `/payroll/periods/${per.d.id}/lock`, null, A)).s === 400, 'chua tinh thi khong chot');
  const calc = (await call('POST', `/payroll/periods/${per.d.id}/calculate`, null, A)).d;
  ok(calc.count === 2 && calc.skipped.length > 0, 'tinh luong 2 nguoi, bo qua nguoi chua dat luong');
  ok((await call('GET', '/payroll/periods', null, U1)).d.length === 0, 'ky nhap thi nhan vien chua thay');
  const slips = (await call('GET', `/payroll/periods/${per.d.id}/payslips`, null, A)).d.payslips;
  const sAn = slips.find((x) => x.employee_code === anCode), sDung = slips.find((x) => x.employee_code === 'NV200');
  // An: 22tr x 20/21 = 20.952.381; BH 10,5% x 20tr = 2.100.000; thu nhap tinh thue am -> thue 0
  ok(sAn.gross === 20952381 && sAn.insurance === 2100000 && sAn.tax === 0 && sAn.net === 18852381, 'phieu luong An');
  // Dung: du cong, 40tr; BH 4.200.000; tinh thue 40-4,2-15,5 = 20,3tr -> 5% x 10tr + 10% x 10,3tr = 1.530.000
  ok(sDung.gross === 40000000 && sDung.taxable === 20300000 && sDung.tax === 1530000 && sDung.net === 34270000, 'phieu luong Dung (thue luy tien)');
  ok((await call('POST', `/payroll/periods/${per.d.id}/lock`, null, A)).s === 200, 'chot ky luong');
  ok((await call('PUT', '/attendance', { employee_id: mine[0].id, date: '2026-09-07', check_in: '09:00', check_out: '17:00' }, A)).s === 409, 'khóa sửa công thuộc kỳ đã chốt');
  ok((await call('POST', '/attendance/import', { csv: `ma,ngay,vao,ra\n${anCode},2026-09-07,09:00,17:00` }, A)).d.errors.length === 1, 'khóa import công thuộc kỳ đã chốt');
  ok((await call('POST', '/leave', { type_id: annual, from_date: '2026-09-14', to_date: '2026-09-14' }, U1)).s === 409, 'khóa tạo đơn nghỉ thuộc kỳ đã chốt');
  ok((await call('PUT', `/leave/${lockedLeave.d.id}/decide`, { action: 'approve' }, U2)).s === 409, 'khóa duyệt đơn nghỉ thuộc kỳ đã chốt');
  ok((await call('PUT', `/leave/${lockedLeave.d.id}/cancel`, null, U1)).s === 409, 'khóa hủy đơn nghỉ thuộc kỳ đã chốt');
  ok((await call('POST', '/overtime', { date: '2026-09-14', hours: 2, reason: 'Tháng đã chốt' }, U1)).s === 409, 'khóa tạo tăng ca thuộc kỳ đã chốt');
  ok((await call('PUT', `/overtime/${lockedOvertime.d.id}/decide`, { action: 'approve' }, U2)).s === 409, 'khóa duyệt tăng ca thuộc kỳ đã chốt');
  ok((await call('PUT', `/overtime/${lockedOvertime.d.id}/cancel`, null, U1)).s === 409, 'khóa hủy tăng ca thuộc kỳ đã chốt');
  ok((await call('POST', `/payroll/periods/${per.d.id}/calculate`, null, A)).s === 400, 'ky da chot khong tinh lai');
  ok((await call('DELETE', `/payroll/periods/${per.d.id}`, null, A)).s === 400, 'ky da chot khong xoa');
  ok((await call('POST', `/payroll/periods/${per.d.id}/unlock`, null, U2)).s === 403, 'chi admin mo khoa');
  const myP = (await call('GET', '/payroll/periods', null, U1)).d;
  ok(myP.length === 1 && myP[0].total_net === undefined, 'nhan vien thay ky da chot, khong thay tong quy luong');
  const mySlips = (await call('GET', `/payroll/periods/${per.d.id}/payslips`, null, U1)).d.payslips;
  ok(mySlips.length === 1 && mySlips[0].employee_code === anCode, 'nhan vien chi thay phieu cua minh');
  ok((await call('GET', `/payroll/periods/${per.d.id}/payslips`, null, U2)).d.payslips.length === 0, 'quan ly khong thay phieu nguoi khac');
  const csv = await fetch(`${base}/payroll/periods/${per.d.id}/export`, { headers: { Authorization: 'Bearer ' + A } });
  const csvBuf = Buffer.from(await csv.arrayBuffer());
  ok(csv.status === 200 && csvBuf[0] === 0xEF && csvBuf[1] === 0xBB && csvBuf[2] === 0xBF && csvBuf.toString('utf8').includes('NV200'), 'xuat CSV co BOM');
  ok((await fetch(`${base}/payroll/periods/${per.d.id}/export`, { headers: { Authorization: 'Bearer ' + U1 } })).status === 403, 'nhan vien khong xuat luong');
  ok((await call('DELETE', '/employees/' + dungId, null, A)).s === 409, 'khong xoa nhan vien da co phieu luong');

  // ===== Thuong / phat / tam ung =====
  const pid = per.d.id;
  const adjAdd = (b, t = A) => call('POST', `/payroll/periods/${pid}/adjustments`, b, t);
  ok((await adjAdd({ employee_id: dungId, type: 'bonus', amount: 5000000, note: 'KPI' })).s === 400, 'ky da chot khong them khoan dieu chinh');
  ok((await call('POST', `/payroll/periods/${pid}/unlock`, null, A)).s === 200, 'admin mo khoa ky');
  ok((await adjAdd({ employee_id: dungId, type: 'bonus', amount: 5000000, note: 'KPI' }, U1)).s === 403, 'nhan vien khong nhap thuong');
  ok((await adjAdd({ employee_id: dungId, type: 'bonus', amount: 5000000, note: 'KPI' }, U2)).s === 403, 'quan ly khong nhap thuong');
  ok((await adjAdd({ employee_id: dungId, type: 'bonus', amount: -1, note: 'x' })).s === 400, 'so tien am');
  ok((await adjAdd({ employee_id: dungId, type: 'bonus', amount: 1.5, note: 'x' })).s === 400, 'so tien le');
  ok((await adjAdd({ employee_id: dungId, type: 'gift', amount: 1000, note: 'x' })).s === 400, 'loai khong hop le');
  ok((await adjAdd({ employee_id: dungId, type: 'penalty', amount: 1000 })).s === 400, 'phat phai co ly do');
  ok((await adjAdd({ employee_id: 99999, type: 'bonus', amount: 1000, note: 'x' })).s === 404, 'nhan vien khong ton tai');
  ok((await call('POST', '/payroll/periods/99999/adjustments', { employee_id: dungId, type: 'bonus', amount: 1000, note: 'x' }, A)).s === 404, 'ky luong khong ton tai');
  ok((await adjAdd({ employee_id: dungId, type: 'bonus', amount: 5000000, note: 'Thuong KPI' })).s === 201, 'them thuong');
  const pen = await adjAdd({ employee_id: dungId, type: 'penalty', amount: 300000, note: 'Di muon' });
  ok(pen.s === 201, 'them phat');
  ok((await adjAdd({ employee_id: dungId, type: 'advance', amount: 1000000 })).s === 201 && (await adjAdd({ employee_id: dungId, type: 'advance', amount: 1000000 })).s === 201, 'tam ung khong can ly do, cong don nhieu lan');
  ok((await call('GET', `/payroll/periods/${pid}/adjustments`, null, U1)).s === 403, 'nhan vien khong xem khoan dieu chinh');
  ok((await call('GET', `/payroll/periods/${pid}/adjustments`, null, A)).d.length === 4, 'liet ke 4 khoan');
  await call('POST', `/payroll/periods/${pid}/calculate`, null, A);
  let sl = (await call('GET', `/payroll/periods/${pid}/payslips`, null, A)).d.payslips;
  let sD = sl.find((x) => x.employee_code === 'NV200');
  // Dung: 40tr + thuong 5tr = 45tr; BH 4,2tr; tinh thue 45 - 4,2 - 15,5 = 25,3tr -> 500.000 + 1.530.000 = 2.030.000
  // Thuc nhan = 45.000.000 - 4.200.000 - 2.030.000 - phat 300.000 - tam ung 2.000.000 = 36.470.000
  ok(sD.bonus === 5000000 && sD.penalty === 300000 && sD.advance === 2000000 && sD.gross === 45000000, 'phieu luong ghi thuong/phat/tam ung');
  ok(sD.insurance === 4200000 && sD.taxable === 25300000 && sD.tax === 2030000 && sD.net === 36470000, 'thuong chiu thue, phat va tam ung tru sau thue');
  ok(sl.find((x) => x.employee_code === anCode).net === 18852381, 'nguoi khac khong bi anh huong');
  // Phat + tam ung vuot thu nhap -> canh bao thuc nhan am
  const big = await adjAdd({ employee_id: mine[0].id, type: 'advance', amount: 30000000 });
  const calcNeg = (await call('POST', `/payroll/periods/${pid}/calculate`, null, A)).d;
  ok(calcNeg.negative.length === 1 && calcNeg.negative[0].includes(anCode), 'canh bao thuc nhan am');
  ok((await call('DELETE', `/payroll/periods/${pid}/adjustments/${big.d.id}`, null, A)).s === 200, 'xoa khoan dieu chinh');
  ok((await call('DELETE', `/payroll/periods/${pid}/adjustments/${pen.d.id}`, null, U1)).s === 403, 'nhan vien khong xoa khoan dieu chinh');
  ok((await call('DELETE', `/payroll/periods/${pid}/adjustments/${pen.d.id}`, null, A)).s === 200, 'xoa phat');
  ok((await call('DELETE', `/payroll/periods/${pid}/adjustments/${pen.d.id}`, null, A)).s === 404, 'xoa lan hai bao khong tim thay');
  const calcOk = (await call('POST', `/payroll/periods/${pid}/calculate`, null, A)).d;
  ok(calcOk.negative.length === 0 && calcOk.unapplied_adjustments === 0, 'het canh bao');
  sl = (await call('GET', `/payroll/periods/${pid}/payslips`, null, A)).d.payslips;
  sD = sl.find((x) => x.employee_code === 'NV200');
  ok(sD.penalty === 0 && sD.net === 36770000, 'bo phat thi thuc nhan tang 300.000');
  ok((await call('POST', `/payroll/periods/${pid}/lock`, null, A)).s === 200, 'chot lai ky luong');
  ok((await call('DELETE', `/payroll/periods/${pid}/adjustments/${pen.d.id}`, null, A)).s === 400, 'ky da chot khong xoa khoan dieu chinh');
  const csv2 = await (await fetch(`${base}/payroll/periods/${pid}/export`, { headers: { Authorization: 'Bearer ' + A } })).text();
  ok(csv2.includes('Thưởng') && csv2.includes('Tạm ứng') && csv2.includes('Tiền tăng ca') && csv2.includes('36770000'), 'CSV co cot thuong, phat, tam ung, tang ca');

  // ===== Dashboard =====
  const dA = (await call('GET', '/dashboard', null, A)).d;
  ok(dA.headcount >= 4 && dA.by_department.length > 0 && dA.payroll_trend.length === 1 && Number.isInteger(dA.late_today), 'dashboard HR có số liệu biểu đồ');
  const dU = (await call('GET', '/dashboard', null, U1)).d;
  ok(dU.headcount === undefined && dU.payroll_trend === undefined && dU.my_today.check_in && dU.my_leave.quota === 12, 'dashboard nhan vien chi thay du lieu cua minh');
  const managerDashboard = await call('GET', '/dashboard', null, U2);
  ok(managerDashboard.d.pending_for_me === 1, 'dashboard quan ly dem don nghi cho duyet');

  // ===== Tăng ca, lịch sử, báo cáo, thông báo =====
  ok((await call('POST', '/overtime', { date: '2026-10-05', hours: 2, reason: 'Chốt tiến độ' }, U1)).s === 201, 'nhân viên gửi đề nghị tăng ca');
  const otList = (await call('GET', '/overtime', null, U1)).d;
  const ot = otList[0];
  ok(ot.status === 'Chờ quản lý' && ot.hours === 2, 'đề nghị tăng ca chờ quản lý');
  ok((await call('POST', '/overtime', { date: '2026-10-06', hours: 13, reason: 'Quá giờ' }, U1)).s === 400, 'giới hạn giờ tăng ca');
  ok((await call('PUT', `/overtime/${ot.id}/decide`, { action: 'approve' }, U1)).s === 403, 'không tự duyệt đề nghị tăng ca');
  ok((await call('PUT', `/overtime/${ot.id}/decide`, { action: 'approve' }, U2)).d.status === 'Chờ HR', 'quản lý chuyển tăng ca sang HR');
  ok((await call('PUT', `/overtime/${ot.id}/decide`, { action: 'approve' }, A)).d.status === 'Đã duyệt', 'HR xác nhận tăng ca');
  const otPeriod = (await call('POST', '/payroll/periods', { month: '2026-10' }, A)).d;
  await call('POST', `/payroll/periods/${otPeriod.id}/calculate`, null, A);
  const otSlips = (await call('GET', `/payroll/periods/${otPeriod.id}/payslips`, null, A)).d.payslips;
  const otSlip = otSlips.find((x) => x.employee_code === anCode);
  ok(otSlip.overtime_hours === 2 && otSlip.overtime_pay > 0 && otSlip.gross === otSlip.overtime_pay, 'giờ tăng ca được đưa vào phiếu lương');

  const historyAdmin = (await call('GET', `/history?employee_id=${mine[0].id}`, null, A)).d;
  ok(historyAdmin.some((x) => x.entity === 'salary' && x.changes['Lương cơ bản']), 'lưu lịch sử thay đổi lương');
  const historyEmployee = (await call('GET', `/history?employee_id=${mine[0].id}`, null, U1)).d;
  ok(historyEmployee.length > 0 && historyEmployee.every((x) => x.entity !== 'salary'), 'nhân viên chỉ xem lịch sử hồ sơ, không xem lịch sử lương');
  ok((await call('GET', `/history?employee_id=${dungId}`, null, U1)).s === 404, 'không xem lịch sử nhân viên khác');
  const report = (await call('GET', '/reports?month=2026-09', null, A)).d;
  ok(report.headcount >= 4 && report.attendance.present >= 19 && report.payroll.length >= 1, 'báo cáo HR tổng hợp nhân sự, công và lương');
  ok((await call('GET', '/reports', null, U1)).s === 403, 'nhân viên không xem báo cáo HR');
  const reportCsv = await (await fetch(`${base}/reports/export?month=2026-09`, { headers: { Authorization: 'Bearer ' + A } })).text();
  ok(reportCsv.includes('Báo cáo HR') && reportCsv.includes('Chấm công'), 'xuất CSV báo cáo');
  const userNotifications = (await call('GET', '/notifications', null, U1)).d;
  ok(userNotifications.unread > 0 && userNotifications.notifications.some((x) => x.title.includes('tăng ca')), 'nhận thông báo về đề nghị tăng ca');
  ok((await call('PUT', '/notifications/read-all', null, U1)).s === 200, 'đánh dấu thông báo đã đọc');
  ok((await call('GET', '/notifications', null, U1)).d.unread === 0, 'đếm đúng thông báo chưa đọc');

  // Admin: reset mat khau, tu bao ve
  const adminId = (await call('GET', '/users', null, A)).d[0].id;
  ok((await call('PUT', `/users/${adminId}/role`, { role: 'employee' }, A)).s === 400, 'khong tu ha quyen');
  ok((await call('DELETE', '/users/' + adminId, null, A)).s === 400, 'khong tu xoa');
  const anId = (await call('GET', '/users', null, A)).d.find((u) => u.email === 'an@cty.vn').id;
  const tmp = (await call('POST', `/users/${anId}/reset-password`, null, A)).d.temporaryPassword;
  ok(tmp && tmp.length >= 8, 'reset sinh mat khau tam');
  const resetLogin = await call('POST', '/auth/login', { email: 'an@cty.vn', password: tmp });
  ok(resetLogin.s === 200 && resetLogin.d.user.must_change_password === 1, 'reset mat khau yeu cau doi o lan dang nhap');
  ok((await call('GET', '/employees', null, resetLogin.d.token)).s === 403, 'token sau reset phai doi mat khau');
  ok((await call('POST', '/auth/change-password', { current: tmp, next: 'anprivate123' }, resetLogin.d.token)).s === 200, 'doi mat khau sau reset');
  ok((await call('POST', '/auth/change-password', { current: 'sai', next: 'newpass123' }, A)).s === 400, 'doi mat khau sai hien tai');
  ok((await call('POST', '/auth/change-password', { current: 'secret1234', next: 'newpass123' }, A)).s === 200, 'doi mat khau');

  // Khoi phuc mat khau qua SMTP: token mot lan va khong tiet lo email co tai khoan hay khong
  const messages = [];
  const smtp = net.createServer((socket) => {
    socket.write('220 localhost ESMTP\r\n');
    let input = '', dataMode = false, message = '';
    socket.on('data', (chunk) => {
      input += chunk.toString();
      let end;
      while ((end = input.indexOf('\r\n')) >= 0) {
        const line = input.slice(0, end);
        input = input.slice(end + 2);
        if (dataMode) {
          if (line === '.') {
            dataMode = false;
            messages.push(message);
            message = '';
            socket.write('250 queued\r\n');
          } else message += `${line}\r\n`;
          continue;
        }
        const command = line.split(' ')[0].toUpperCase();
        if (command === 'EHLO' || command === 'HELO') socket.write('250-localhost\r\n250 SIZE 10485760\r\n');
        else if (command === 'MAIL' || command === 'RCPT') socket.write('250 ok\r\n');
        else if (command === 'DATA') { dataMode = true; socket.write('354 end with dot\r\n'); }
        else if (command === 'QUIT') { socket.write('221 bye\r\n'); socket.end(); }
        else socket.write('250 ok\r\n');
      }
    });
  });
  await new Promise((resolve) => smtp.listen(0, '127.0.0.1', resolve));
  const oldMailEnv = Object.fromEntries(['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'APP_URL'].map((key) => [key, process.env[key]]));
  try {
    for (const key of Object.keys(oldMailEnv)) delete process.env[key];
    ok((await call('POST', '/auth/forgot-password', { email: 'an@cty.vn' })).s === 503, 'bao loi khi chua cau hinh SMTP');
    process.env.SMTP_HOST = '127.0.0.1';
    process.env.SMTP_PORT = String(smtp.address().port);
    process.env.SMTP_SECURE = 'false';
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;
    process.env.SMTP_FROM = 'hrm@example.test';
    process.env.APP_URL = 'https://hrm.example.test';
    const sent = await call('POST', '/auth/forgot-password', { email: 'an@cty.vn' });
    ok(sent.s === 200 && sent.d.message, 'gui email khoi phuc');
    const decodedMessage = messages[0] && messages[0].replace(/=\r?\n/g, '').replace(/=([A-Fa-f0-9]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    let resetToken = decodedMessage && decodedMessage.match(/https:\/\/hrm\.example\.test\/\?reset=([a-f0-9]{64})/);
    if (!resetToken && messages[0]) {
      const encoded = messages[0].match(/Content-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+)/);
      if (encoded) resetToken = Buffer.from(encoded[1].replace(/\s/g, ''), 'base64').toString().match(/https:\/\/hrm\.example\.test\/\?reset=([a-f0-9]{64})/);
    }
    ok(!!resetToken, 'email chua lien ket reset token');
    const unknown = await call('POST', '/auth/forgot-password', { email: 'unknown@cty.vn' });
    ok(unknown.s === 200 && unknown.d.message === sent.d.message && messages.length === 1, 'khong tiet lo email tai khoan ton tai');
    ok((await call('POST', '/auth/reset-password', { token: resetToken[1], password: 'short7' })).s === 400, 'tu choi mat khau reset ngan');
    ok((await call('POST', '/auth/reset-password', { token: resetToken[1], password: 'emailreset123' })).s === 200, 'reset mat khau bang token email');
    ok((await call('POST', '/auth/reset-password', { token: resetToken[1], password: 'anotherpass123' })).s === 400, 'token reset chi dung mot lan');
    const resetWithNewPassword = await call('POST', '/auth/login', { email: 'an@cty.vn', password: 'emailreset123' });
    ok(resetWithNewPassword.s === 200 && resetWithNewPassword.d.user.must_change_password === 0, 'dang nhap duoc voi mat khau moi qua email');
    const waitForMessages = async (count) => {
      for (let attempt = 0; attempt < 100 && messages.length < count; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return messages.length >= count;
    };
    let expectedMessages = messages.length;
    const emailLeave = await call('POST', '/leave', { type_id: annual, from_date: '2027-07-12', to_date: '2027-07-12' }, U1);
    ok(emailLeave.s === 201 && await waitForMessages(++expectedMessages), 'email gui cho quan ly khi tao don nghi');
    ok((await call('PUT', `/leave/${emailLeave.d.id}/decide`, { action: 'approve' }, U2)).d.status === 'Chờ HR', 'quản lý chuyển đơn nghỉ tới HR');
    ok(await waitForMessages(++expectedMessages), 'email gui HR khi don nghi qua quan ly');
    ok((await call('PUT', `/leave/${emailLeave.d.id}/decide`, { action: 'approve' }, A)).d.status === 'Đã duyệt', 'HR duyet don nghi');
    ok(await waitForMessages(++expectedMessages), 'email ket qua don nghi gui cho nhan vien');
    const emailOvertime = await call('POST', '/overtime', { date: '2027-08-03', hours: 2, reason: 'Kiểm thử email' }, U1);
    ok(emailOvertime.s === 201 && await waitForMessages(++expectedMessages), 'email gui cho quan ly khi tao don tang ca');
    ok((await call('PUT', `/overtime/${emailOvertime.d.id}/decide`, { action: 'approve' }, U2)).d.status === 'Chờ HR', 'quản lý chuyển tăng ca tới HR');
    ok(await waitForMessages(++expectedMessages), 'email gui HR khi tang ca qua quan ly');
    ok((await call('PUT', `/overtime/${emailOvertime.d.id}/decide`, { action: 'approve' }, A)).d.status === 'Đã duyệt', 'HR duyet tang ca');
    ok(await waitForMessages(++expectedMessages), 'email ket qua tang ca gui cho nhan vien');
    const emailPeriod = (await call('POST', '/payroll/periods', { month: '2027-09' }, A)).d;
    await call('POST', `/payroll/periods/${emailPeriod.id}/calculate`, null, A);
    const emailSlips = (await call('GET', `/payroll/periods/${emailPeriod.id}/payslips`, null, A)).d.payslips;
    ok(emailSlips.length > 0 && (await call('POST', `/payroll/periods/${emailPeriod.id}/lock`, null, A)).s === 200, 'chot ky luong de gui email phieu luong');
    const employeeEmails = (await call('GET', '/employees', null, A)).d;
    const registeredEmails = (await call('GET', '/users', null, A)).d.map((user) => user.email);
    expectedMessages += emailSlips.filter((slip) => {
      const employee = employeeEmails.find((item) => item.code === slip.employee_code);
      return employee && registeredEmails.includes(employee.email);
    }).length;
    ok(await waitForMessages(expectedMessages), 'email thong bao phieu luong gui toi nhan vien co phieu');
  } finally {
    for (const [key, value] of Object.entries(oldMailEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await new Promise((resolve) => smtp.close(resolve));
  }

  // Xoa tai khoan co hieu luc ngay
  await call('DELETE', '/users/' + anId, null, A);
  ok((await call('GET', '/auth/me', null, U1)).s === 401, 'token cua tai khoan da xoa vo hieu');

  // Nhat ky
  ok((await call('GET', '/logs', null, A)).d.length > 10, 'co nhat ky');
  await emailApp.close();
  await configApp.close();
  const notificationServiceDown = await fetch(`${gatewayBase}/api/notifications`, {
    headers: { Authorization: 'Bearer ' + A },
  });
  const dependencyError = await notificationServiceDown.json();
  ok(notificationServiceDown.status === 503 && dependencyError.code === 'DEPENDENCY_UNAVAILABLE',
    'notification API returns 503 when its service is down');
  const configServiceDown = await fetch(`${gatewayBase}/api/settings`, {
    headers: { Authorization: 'Bearer ' + A },
  });
  const configDependencyError = await configServiceDown.json();
  ok(configServiceDown.status === 503 && configDependencyError.code === 'DEPENDENCY_UNAVAILABLE',
    'configuration API returns 503 when Config Service is down');
  ok(L.getSettings().work_start === '08:30'
    && L.holidays('2020-01-01', '2020-12-31').size === 0,
  'synchronous HRM calculations retain the last Config Service cache when it is down');
  const cachedLeaveBalance = await call('GET', '/leave/balance', null, A);
  ok(cachedLeaveBalance.s === 200 && Number.isFinite(cachedLeaveBalance.d.quota),
    'Leave balance continues to use Core Config cache when Config Service is down');
  await attendanceApp.close();
  const attendanceServiceDown = await call('GET', '/attendance/today', null, A);
  ok(attendanceServiceDown.s === 503 && attendanceServiceDown.d.code === 'DEPENDENCY_UNAVAILABLE',
    'attendance API returns 503 when Attendance Service is down');
  await leaveApp.close();
  const leaveServiceDown = await call('GET', '/leave/types', null, A);
  ok(leaveServiceDown.s === 503 && leaveServiceDown.d.code === 'DEPENDENCY_UNAVAILABLE',
    'leave API returns 503 when Leave Service is down');
  await payrollApp.close();
  const payrollServiceDown = await call('GET', '/payroll/periods', null, A);
  ok(payrollServiceDown.s === 503 && payrollServiceDown.d.code === 'DEPENDENCY_UNAVAILABLE',
    'payroll API returns 503 when Payroll Service is down');
  const isolatedIdentityApp = await createIdentityApp();
  await isolatedIdentityApp.listen(0, '127.0.0.1');
  const isolatedIdentityUrl = `http://127.0.0.1:${isolatedIdentityApp.getHttpServer().address().port}`;
  const isolatedStatus = await fetch(`${isolatedIdentityUrl}/internal/v1/auth/status`, {
    headers: { 'X-Internal-Service-Token': process.env.INTERNAL_SERVICE_TOKEN },
  });
  ok(isolatedStatus.status === 200 && (await isolatedStatus.json()).registrationOpen,
    'new Identity database opens initial Admin registration');
  const isolatedRegistration = await fetch(`${isolatedIdentityUrl}/internal/v1/auth/register`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Service-Token': process.env.INTERNAL_SERVICE_TOKEN,
    },
    body: JSON.stringify({ name: 'Isolated Admin', email: 'isolated-admin@cty.vn', password: 'secret1234' }),
  });
  ok(isolatedRegistration.status === 201 && (await isolatedRegistration.json()).role === 'admin',
    'initial Admin registration creates an Identity account and ensures its Core employee');
  await isolatedIdentityApp.close();
  await identityApp.close();
  const identityServiceDown = await fetch(`${gatewayBase}/api/employees`, {
    headers: { Authorization: 'Bearer invalid-token-for-identity-down-test' },
  });
  const identityDependencyError = await identityServiceDown.json();
  ok(identityServiceDown.status === 503 && identityDependencyError.code === 'IDENTITY_SERVICE_UNAVAILABLE',
    'Gateway returns 503 when Identity Service is down');
  console.log(`OK: ${n} kiem tra dat`);
  await new Promise((resolve) => gatewayServer.close(resolve));
  await nestApp.close();
  await employeeApp.close();
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
