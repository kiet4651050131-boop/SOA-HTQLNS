const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite'); // SQLite có sẵn trong Node >= 22.13, không cần biên dịch
const { publishServiceEvent } = require('./service-client');

const file = process.env.DB_FILE || path.join(__dirname, 'data', 'hrm.db');
if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });

const raw = new DatabaseSync(file);
raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

// Lớp bọc nhỏ để giữ cách dùng prepare / exec / transaction như cũ
const db = {
  prepare: (sql) => raw.prepare(sql),
  exec: (sql) => raw.exec(sql),
  transaction: (fn) => (...args) => {
    raw.exec('BEGIN');
    try { const r = fn(...args); raw.exec('COMMIT'); return r; }
    catch (e) { raw.exec('ROLLBACK'); throw e; }
  },
};

db.exec(`
CREATE TABLE IF NOT EXISTS departments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE
);
CREATE TABLE IF NOT EXISTS positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE
);
CREATE TABLE IF NOT EXISTS employees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  phone TEXT NOT NULL DEFAULT '',
  department_id INTEGER REFERENCES departments(id) ON DELETE RESTRICT,
  position_id INTEGER REFERENCES positions(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'Thử việc',
  start_date TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS employee_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER,
  employee_code TEXT NOT NULL,
  employee_name TEXT NOT NULL,
  entity TEXT NOT NULL,
  actor_email TEXT NOT NULL,
  changes TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_history_employee ON employee_history(employee_id, id);
`);

// ----- Chấm công, nghỉ phép, lương -----
db.exec(`
CREATE TABLE IF NOT EXISTS attendances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  check_in TEXT,
  check_out TEXT,
  note TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'web',
  UNIQUE (employee_id, date)
);
CREATE INDEX IF NOT EXISTS idx_att_date ON attendances(date);
CREATE TABLE IF NOT EXISTS leave_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  paid INTEGER NOT NULL DEFAULT 1,
  uses_quota INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS leave_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  type_id INTEGER NOT NULL REFERENCES leave_types(id),
  from_date TEXT NOT NULL,
  to_date TEXT NOT NULL,
  half INTEGER NOT NULL DEFAULT 0,
  days REAL NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'Chờ HR' CHECK (status IN ('Chờ quản lý','Chờ HR','Đã duyệt','Từ chối','Đã hủy')),
  manager_note TEXT NOT NULL DEFAULT '',
  decided_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_leave_emp ON leave_requests(employee_id, status);
CREATE TABLE IF NOT EXISTS employee_salary (
  employee_id INTEGER PRIMARY KEY REFERENCES employees(id) ON DELETE CASCADE,
  base_salary INTEGER NOT NULL DEFAULT 0,
  allowance INTEGER NOT NULL DEFAULT 0,
  exempt_allowance INTEGER NOT NULL DEFAULT 0,
  dependents INTEGER NOT NULL DEFAULT 0,
  insured INTEGER NOT NULL DEFAULT 1,
  insured_salary INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS payroll_periods (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  month TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'Nháp' CHECK (status IN ('Nháp','Đã chốt')),
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  locked_at TEXT
);
CREATE TABLE IF NOT EXISTS payslips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  period_id INTEGER NOT NULL REFERENCES payroll_periods(id) ON DELETE CASCADE,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  employee_code TEXT NOT NULL,
  employee_name TEXT NOT NULL,
  department TEXT NOT NULL DEFAULT '',
  std_days REAL NOT NULL,
  paid_days REAL NOT NULL,
  present_days REAL NOT NULL,
  paid_leave_days REAL NOT NULL,
  unpaid_leave_days REAL NOT NULL,
  absent_days REAL NOT NULL,
  base_salary INTEGER NOT NULL,
  allowance INTEGER NOT NULL,
  gross INTEGER NOT NULL,
  insurance INTEGER NOT NULL,
  dependents INTEGER NOT NULL,
  taxable INTEGER NOT NULL,
  tax INTEGER NOT NULL,
  net INTEGER NOT NULL,
  bonus INTEGER NOT NULL DEFAULT 0,
  penalty INTEGER NOT NULL DEFAULT 0,
  advance INTEGER NOT NULL DEFAULT 0,
  overtime_hours REAL NOT NULL DEFAULT 0,
  overtime_pay INTEGER NOT NULL DEFAULT 0,
  UNIQUE (period_id, employee_id)
);
-- Thưởng / phạt / tạm ứng nhập theo từng kỳ lương, giữ nguyên khi tính lại
CREATE TABLE IF NOT EXISTS payroll_adjustments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  period_id INTEGER NOT NULL REFERENCES payroll_periods(id) ON DELETE CASCADE,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('bonus','penalty','advance')),
  amount INTEGER NOT NULL CHECK (amount > 0),
  note TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_adj_period ON payroll_adjustments(period_id, employee_id);
CREATE TABLE IF NOT EXISTS advance_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  month TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0),
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'Chờ duyệt' CHECK (status IN ('Chờ duyệt','Đã duyệt','Từ chối')),
  reviewed_by TEXT NOT NULL DEFAULT '',
  review_note TEXT NOT NULL DEFAULT '',
  adjustment_id INTEGER REFERENCES payroll_adjustments(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  decided_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_advance_employee_month ON advance_requests(employee_id, month, status);
CREATE INDEX IF NOT EXISTS idx_advance_status ON advance_requests(status, created_at);
CREATE TABLE IF NOT EXISTS overtime_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  hours REAL NOT NULL CHECK (hours > 0 AND hours <= 12),
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'Chờ HR' CHECK (status IN ('Chờ quản lý','Chờ HR','Đã duyệt','Từ chối','Đã hủy')),
  manager_note TEXT NOT NULL DEFAULT '',
  decided_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_overtime_date_status ON overtime_requests(date, status);
`);

// Nâng cấp CSDL cũ (tạo trước khi có thưởng/phạt/tạm ứng)
{
  const cols = db.prepare('PRAGMA table_info(payslips)').all().map((c) => c.name);
  ['bonus', 'penalty', 'advance', 'overtime_hours', 'overtime_pay'].forEach((c) => {
    if (!cols.includes(c)) db.exec(`ALTER TABLE payslips ADD COLUMN ${c} ${c === 'overtime_hours' ? 'REAL' : 'INTEGER'} NOT NULL DEFAULT 0`);
  });
}

{
  const lt = db.prepare('INSERT OR IGNORE INTO leave_types(name, paid, uses_quota) VALUES (?, ?, ?)');
  lt.run('Phép năm', 1, 1); lt.run('Nghỉ ốm', 1, 0); lt.run('Nghỉ không lương', 0, 0);
}

if (db.prepare('SELECT COUNT(*) c FROM departments').get().c === 0) {
  const d = db.prepare('INSERT INTO departments(name) VALUES (?)');
  ['Kinh doanh', 'Kỹ thuật', 'Hành chính'].forEach((n) => d.run(n));
  const p = db.prepare('INSERT INTO positions(name) VALUES (?)');
  ['Nhân viên', 'Trưởng nhóm', 'Giám đốc'].forEach((n) => p.run(n));
}

function audit(user, action) {
  publishServiceEvent('/internal/v1/audit', {
    user_email: user ? user.email : '-',
    action,
  });
}

function recordHistory(employee, actor, entity, changes) {
  if (!changes || !Object.keys(changes).length) return;
  db.prepare(`INSERT INTO employee_history(employee_id, employee_code, employee_name, entity, actor_email, changes)
    VALUES (?,?,?,?,?,?)`).run(
    employee.id || null,
    employee.code || '',
    employee.name || '',
    entity,
    actor ? actor.email : '-',
    JSON.stringify(changes),
  );
}

function notifyUser(userId, title, message, href) {
  publishServiceEvent('/internal/v1/notifications', {
    user_id: userId,
    title,
    message: message || '',
    href: href || '',
  });
}

module.exports = { db, audit, recordHistory, notifyUser };
