import { timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import {
  BadRequestException,
  ConflictException,
  Controller,
  Delete,
  Get,
  Headers,
  Injectable,
  Module,
  NotFoundException,
  OnModuleDestroy,
  Param,
  Post,
  Put,
  Body,
  Query,
  UnauthorizedException,
} from '@nestjs/common';

interface Salary {
  employee_id: number;
  base_salary: number;
  allowance: number;
  exempt_allowance: number;
  dependents: number;
  insured: number;
  insured_salary: number;
}

interface Employee {
  id: number;
  code: string;
  name: string;
  email: string;
  department?: string;
  status: string;
  start_date: string;
}

interface Summary {
  std_days: number;
  present: number;
  paid_leave: number;
  unpaid_leave: number;
  absent: number;
}

interface AttendanceDay {
  date: string;
  workday: boolean;
  check_in: string | null;
  check_out: string | null;
  hours: number | null;
  leave: { paid?: boolean; frac?: number } | null;
}

interface AdvanceRequest {
  id: number;
  employee_id: number;
  month: string;
  amount: number;
  note: string;
  status: string;
  reviewed_by: string;
  review_note: string;
  adjustment_id: number | null;
  created_at: string;
  decided_at: string | null;
}

interface PayslipInput {
  period_id: number;
  employee_id: number;
  employee_code: string;
  employee_name: string;
  department: string;
  std_days: number;
  paid_days: number;
  present_days: number;
  paid_leave_days: number;
  unpaid_leave_days: number;
  absent_days: number;
  base_salary: number;
  allowance: number;
  gross: number;
  insurance: number;
  dependents: number;
  taxable: number;
  tax: number;
  net: number;
  bonus: number;
  penalty: number;
  advance: number;
  overtime_hours: number;
  overtime_pay: number;
}

interface CallOptions {
  method?: 'GET' | 'POST';
  baseUrl: string;
  timeoutEnv: string;
  serviceName: string;
  body?: unknown;
}

const { callService } = require('../service-client') as {
  callService(path: string, options: CallOptions & { passThrough4xx?: boolean }): Promise<unknown>;
};

const DEFAULT_URLS = {
  employee: 'http://127.0.0.1:3002',
  attendance: 'http://127.0.0.1:3003',
  leave: 'http://127.0.0.1:3004',
  config: 'http://127.0.0.1:3300',
};

function validMonth(value: string) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

function validDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function positiveId(value: unknown) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw new BadRequestException('Record ID is invalid');
  return id;
}

function round2(value: number) {
  return Math.round(value * 100) / 100;
}

function today() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function parseBrackets(value: string) {
  const parts = String(value || '').split(';').map((part) => part.trim()).filter(Boolean);
  if (!parts.length) throw new BadRequestException('Tax brackets are empty');
  let previous = 0;
  const brackets = parts.map((part, index) => {
    const [limit, rate] = part.split(':').map((item) => item.trim());
    const taxRate = Number(rate);
    if (!(taxRate >= 0 && taxRate <= 100)) throw new BadRequestException(`Invalid tax rate at bracket ${index + 1}`);
    if (limit === '*') {
      if (index !== parts.length - 1) throw new BadRequestException('The * tax bracket must be last');
      return { upto: Infinity, rate: taxRate };
    }
    const amount = Number(limit);
    if (!(amount > previous)) throw new BadRequestException(`Invalid tax threshold at bracket ${index + 1}`);
    previous = amount;
    return { upto: amount, rate: taxRate };
  });
  if (brackets[brackets.length - 1].upto !== Infinity) {
    throw new BadRequestException('The final tax bracket must use *');
  }
  return brackets;
}

function calcTax(taxable: number, brackets: Array<{ upto: number; rate: number }>) {
  let tax = 0;
  let previous = 0;
  for (const bracket of brackets) {
    if (taxable <= previous) break;
    tax += ((Math.min(taxable, bracket.upto) - previous) * bracket.rate) / 100;
    previous = bracket.upto;
  }
  return Math.round(tax);
}

function calcPayslip(
  salary: Salary,
  summary: Summary,
  settings: Record<string, string>,
  adjustment: { bonus?: number; penalty?: number; advance?: number },
  overtime: { hours: number; pay: number },
) {
  const ratio = summary.std_days > 0 ? Math.min(1, (summary.present + summary.paid_leave) / summary.std_days) : 1;
  const baseEarned = Math.round(salary.base_salary * ratio);
  const allowanceEarned = Math.round(salary.allowance * ratio);
  const bonus = Math.round(adjustment.bonus || 0);
  const penalty = Math.round(adjustment.penalty || 0);
  const advance = Math.round(adjustment.advance || 0);
  const overtimeHours = round2(overtime.hours || 0);
  const overtimePay = Math.round(overtime.pay || 0);
  const gross = baseEarned + allowanceEarned + bonus + overtimePay;
  let insurance = 0;
  if (salary.insured) {
    const insuredSalary = salary.insured_salary || salary.base_salary;
    insurance = Math.round(
      (Math.min(insuredSalary, Number(settings.cap_bhxh)) * Number(settings.bhxh_rate)) / 100
      + (Math.min(insuredSalary, Number(settings.cap_bhxh)) * Number(settings.bhyt_rate)) / 100
      + (Math.min(insuredSalary, Number(settings.cap_bhtn)) * Number(settings.bhtn_rate)) / 100,
    );
  }
  const exempt = Math.min(Math.round(salary.exempt_allowance * ratio), allowanceEarned);
  const taxable = Math.max(0, gross - exempt - insurance - Number(settings.personal_deduction)
    - salary.dependents * Number(settings.dependent_deduction));
  const tax = calcTax(taxable, parseBrackets(settings.tax_brackets));
  return {
    base_salary: salary.base_salary,
    allowance: salary.allowance,
    gross,
    insurance,
    dependents: salary.dependents,
    taxable,
    tax,
    net: gross - insurance - tax - penalty - advance,
    bonus,
    penalty,
    advance,
    overtime_hours: overtimeHours,
    overtime_pay: overtimePay,
  };
}

@Injectable()
export class PayrollService implements OnModuleDestroy {
  private readonly db: DatabaseSync;

  constructor() {
    const file = process.env.PAYROLL_DB_FILE || path.join(__dirname, '..', 'data', 'payroll.db');
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS employee_salary (
        employee_id INTEGER PRIMARY KEY,
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
        employee_id INTEGER NOT NULL,
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
      CREATE TABLE IF NOT EXISTS payroll_adjustments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        period_id INTEGER NOT NULL REFERENCES payroll_periods(id) ON DELETE CASCADE,
        employee_id INTEGER NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('bonus','penalty','advance')),
        amount INTEGER NOT NULL CHECK (amount > 0),
        note TEXT NOT NULL DEFAULT '',
        created_by TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
      );
      CREATE INDEX IF NOT EXISTS idx_adj_period ON payroll_adjustments(period_id, employee_id);
      CREATE TABLE IF NOT EXISTS advance_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        employee_id INTEGER NOT NULL,
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
    `);
  }

  onModuleDestroy() {
    this.db.close();
  }

  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private getPeriod(id: number) {
    return this.db.prepare('SELECT * FROM payroll_periods WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  }

  findPeriod(id: number) {
    return this.getPeriod(id) || null;
  }

  requirePeriod(id: number) {
    const period = this.getPeriod(id);
    if (!period) throw new NotFoundException('Payroll period was not found');
    return period;
  }

  private isLocked(month: string) {
    return Boolean(this.db.prepare("SELECT 1 FROM payroll_periods WHERE month = ? AND status = 'Đã chốt'").get(month));
  }

  private async dependency(pathname: string, service: keyof typeof DEFAULT_URLS, timeoutEnv: string) {
    return callService(pathname, {
      baseUrl: process.env[`${service.toUpperCase()}_SERVICE_URL`] || DEFAULT_URLS[service],
      timeoutEnv,
      serviceName: `${service[0].toUpperCase()}${service.slice(1)} Service`,
      passThrough4xx: true,
    });
  }

  listSalaries(employeeIds?: string) {
    if (!employeeIds) return this.db.prepare('SELECT * FROM employee_salary ORDER BY employee_id').all();
    const ids = employeeIds.split(',').map((id) => positiveId(id.trim()));
    if (!ids.length) return [];
    return this.db.prepare(`SELECT * FROM employee_salary WHERE employee_id IN (${ids.map(() => '?').join(',')}) ORDER BY employee_id`)
      .all(...ids);
  }

  getSalary(employeeId: number) {
    return this.db.prepare('SELECT * FROM employee_salary WHERE employee_id = ?').get(employeeId) as Salary | undefined;
  }

  upsertSalary(employeeId: number, salary: Omit<Salary, 'employee_id'>) {
    const previous = this.getSalary(employeeId) || null;
    this.db.prepare(`INSERT INTO employee_salary
      (employee_id, base_salary, allowance, exempt_allowance, dependents, insured, insured_salary)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(employee_id) DO UPDATE SET base_salary=excluded.base_salary, allowance=excluded.allowance,
        exempt_allowance=excluded.exempt_allowance, dependents=excluded.dependents,
        insured=excluded.insured, insured_salary=excluded.insured_salary`)
      .run(employeeId, salary.base_salary, salary.allowance, salary.exempt_allowance,
        salary.dependents, salary.insured, salary.insured_salary);
    return { previous, salary: this.getSalary(employeeId) };
  }

  listPeriods(employeeId?: number) {
    if (employeeId) {
      return this.db.prepare(`SELECT p.id, p.month, p.status, p.locked_at FROM payroll_periods p
        JOIN payslips s ON s.period_id = p.id WHERE s.employee_id = ? AND p.status = 'Đã chốt'
        ORDER BY p.month DESC`).all(employeeId);
    }
    return this.db.prepare(`SELECT p.*, COUNT(s.id) headcount, COALESCE(SUM(s.gross),0) total_gross,
      COALESCE(SUM(s.net),0) total_net FROM payroll_periods p
      LEFT JOIN payslips s ON s.period_id = p.id GROUP BY p.id ORDER BY p.month DESC`).all();
  }

  createPeriod(month: string, createdBy: string) {
    if (!validMonth(month)) throw new BadRequestException('Month must use YYYY-MM format');
    try {
      const info = this.db.prepare('INSERT INTO payroll_periods(month, created_by) VALUES (?, ?)')
        .run(month, createdBy);
      return { id: Number(info.lastInsertRowid) };
    } catch (error) {
      if (String(error).includes('UNIQUE constraint failed')) throw new ConflictException(`Kỳ lương ${month} đã tồn tại`);
      throw error;
    }
  }

  listPayslips(periodId: number, employeeId?: number) {
    this.requirePeriod(periodId);
    if (employeeId) {
      return this.db.prepare('SELECT * FROM payslips WHERE period_id = ? AND employee_id = ?')
        .all(periodId, employeeId);
    }
    return this.db.prepare('SELECT * FROM payslips WHERE period_id = ? ORDER BY employee_code').all(periodId);
  }

  listAdjustments(periodId: number) {
    this.requirePeriod(periodId);
    return this.db.prepare('SELECT * FROM payroll_adjustments WHERE period_id = ? ORDER BY employee_id, id')
      .all(periodId);
  }

  createAdjustment(periodId: number, input: {
    employee_id: number; type: string; amount: number; note: string; created_by: string;
  }) {
    const period = this.requirePeriod(periodId);
    if (period.status !== 'Nháp') throw new BadRequestException('Payroll period is locked');
    const result = this.db.prepare(`INSERT INTO payroll_adjustments
      (period_id, employee_id, type, amount, note, created_by) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(periodId, input.employee_id, input.type, input.amount, input.note, input.created_by);
    return { id: Number(result.lastInsertRowid) };
  }

  deleteAdjustment(periodId: number, adjustmentId: number) {
    const period = this.requirePeriod(periodId);
    if (period.status !== 'Nháp') throw new BadRequestException('Payroll period is locked');
    const adjustment = this.db.prepare('SELECT * FROM payroll_adjustments WHERE id = ? AND period_id = ?')
      .get(adjustmentId, periodId) as Record<string, unknown> | undefined;
    if (!adjustment) throw new NotFoundException('Payroll adjustment was not found');
    if (adjustment.type === 'advance'
      && this.db.prepare("SELECT 1 FROM advance_requests WHERE adjustment_id = ? AND status = 'Đã duyệt'").get(adjustmentId)) {
      throw new ConflictException('Khoản ứng đã duyệt không thể xóa khỏi yêu cầu; hãy giữ nguyên để đối soát kỳ lương');
    }
    this.db.prepare('DELETE FROM payroll_adjustments WHERE id = ?').run(adjustmentId);
    return adjustment;
  }

  listAdvanceRequests(employeeId?: number) {
    if (employeeId) {
      return this.db.prepare(`SELECT id, month, amount, note, status, review_note, created_at
        FROM advance_requests WHERE employee_id = ? ORDER BY id DESC LIMIT 100`).all(employeeId);
    }
    return this.db.prepare('SELECT * FROM advance_requests ORDER BY created_at DESC, id DESC LIMIT 500').all();
  }

  getAdvanceRequest(id: number) {
    return this.db.prepare('SELECT * FROM advance_requests WHERE id = ?').get(id) as AdvanceRequest | undefined;
  }

  async advanceSummary(employeeId: number, month: string, excludeRequestId?: number, asOf = today()) {
    if (!validMonth(month)) throw new BadRequestException('Month must use YYYY-MM format');
    if (!validDate(asOf)) throw new BadRequestException('As-of date is invalid');
    const employee = await this.dependency(`/internal/v1/employees/${employeeId}`, 'employee', 'EMPLOYEE_SERVICE_TIMEOUT_MS') as Employee | null;
    if (!employee) throw new NotFoundException('Employee was not found');
    const salary = this.getSalary(employeeId);
    const from = `${month}-01`;
    const to = `${month}-${String(new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate()).padStart(2, '0')}`;
    const cutoff = asOf < to ? asOf : to;
    const settingsPromise = this.dependency('/internal/v1/settings', 'config', 'CONFIG_SERVICE_TIMEOUT_MS');
    const attendanceRequest = salary
      ? callService('/internal/v1/summary/batch', {
        method: 'POST',
        baseUrl: process.env.ATTENDANCE_SERVICE_URL || DEFAULT_URLS.attendance,
        timeoutEnv: 'ATTENDANCE_SERVICE_TIMEOUT_MS',
        serviceName: 'Attendance Service',
        passThrough4xx: true,
        body: { month, employees: [{ id: employee.id, start_date: employee.start_date || '' }] },
      })
      : Promise.resolve([]);
    const [settingsValue, attendanceResult, overtimeResult] = await Promise.all([
      settingsPromise,
      attendanceRequest,
      salary && cutoff >= from
        ? this.dependency(`/internal/v1/overtime/approved-hours?month=${encodeURIComponent(month)}&to=${encodeURIComponent(cutoff)}`,
          'leave', 'LEAVE_SERVICE_TIMEOUT_MS')
        : Promise.resolve([]),
    ]);
    if (!settingsValue || typeof settingsValue !== 'object' || Array.isArray(settingsValue)) {
      throw new Error('Config Service returned invalid settings');
    }
    const attendanceRows = attendanceResult as Array<{ employee_id: number; summary: Summary; days: AttendanceDay[] }>;
    const attendance = attendanceRows.find((row) => row.employee_id === employeeId);
    let creditedDays = 0;
    if (attendance) {
      for (const day of attendance.days) {
        if (!day.workday || day.date > cutoff || (employee.start_date && String(day.date) < employee.start_date)) continue;
        const leave = day.leave as { paid?: boolean; frac?: number } | null;
        const paidLeave = leave && leave.paid ? Number(leave.frac || 0) : 0;
        const attended = day.check_in && day.check_out ? (Number(day.hours) >= 4 ? 1 : 0.5) : 0;
        creditedDays += Math.min(attended, 1 - (leave ? Number(leave.frac || 0) : 0)) + paidLeave;
      }
    }
    creditedDays = round2(creditedDays);
    const stdDays = attendance ? attendance.summary.std_days : 0;
    const overtimeRows = overtimeResult as Array<{ employee_id: number; hours: number }>;
    const overtimeHours = overtimeRows.find((row) => row.employee_id === employeeId)?.hours || 0;
    const settings = settingsValue as Record<string, string>;
    const overtimePay = salary && stdDays > 0
      ? Math.round((salary.base_salary / stdDays / 8) * overtimeHours * Number(settings.overtime_rate || 1.5))
      : 0;
    const accruedGross = salary && salary.base_salary > 0 && stdDays > 0
      ? Math.round((salary.base_salary + salary.allowance) * Math.min(1, creditedDays / stdDays)) + overtimePay
      : 0;
    const advances = Number(this.db.prepare(`SELECT COALESCE(SUM(a.amount),0) amount FROM payroll_adjustments a
      JOIN payroll_periods p ON p.id = a.period_id WHERE a.employee_id = ? AND p.month = ? AND a.type = 'advance'`)
      .get(employeeId, month)?.amount || 0);
    const pending = Number(this.db.prepare(`SELECT COALESCE(SUM(amount),0) amount FROM advance_requests
      WHERE employee_id = ? AND month = ? AND status = 'Chờ duyệt' AND (? IS NULL OR id != ?)`)
      .get(employeeId, month, excludeRequestId || null, excludeRequestId || null)?.amount || 0);
    const limit = Math.floor(accruedGross * 0.5);
    return {
      month,
      configured: Boolean(salary && salary.base_salary > 0),
      std_days: stdDays,
      credited_days: creditedDays,
      accrued_gross: accruedGross,
      advance_limit: limit,
      advanced: advances,
      pending,
      available: Math.max(0, limit - advances - pending),
      locked: this.isLocked(month),
    };
  }

  async createAdvanceRequest(input: { employee_id: number; month: string; amount: number; note: string; as_of?: string }) {
    const summary = await this.advanceSummary(input.employee_id, input.month, undefined, input.as_of);
    return this.transaction(() => {
      if (!summary.configured) throw new BadRequestException('Nhân viên chưa được thiết lập lương');
      if (summary.locked) throw new ConflictException('Kỳ lương tháng này đã chốt, không thể ứng lương');
      if (input.amount > summary.available) {
        throw new BadRequestException(`Số tiền vượt hạn mức ứng còn lại (${summary.available} đồng)`);
      }
      const info = this.db.prepare('INSERT INTO advance_requests(employee_id, month, amount, note) VALUES (?, ?, ?, ?)')
        .run(input.employee_id, input.month, input.amount, input.note);
      return { id: Number(info.lastInsertRowid), month: input.month };
    });
  }

  async decideAdvanceRequest(id: number, input: {
    action: 'approve' | 'reject'; reviewed_by: string; review_note: string; as_of?: string;
  }) {
    const current = this.getAdvanceRequest(id);
    if (!current) throw new NotFoundException('Advance request was not found');
    if (current.status !== 'Chờ duyệt') throw new ConflictException('Yêu cầu này đã được xử lý');
    const employee = await this.dependency(`/internal/v1/employees/${current.employee_id}`, 'employee', 'EMPLOYEE_SERVICE_TIMEOUT_MS') as Employee | null;
    if (!employee) throw new NotFoundException('Employee was not found');
    const summary = input.action === 'approve'
      ? await this.advanceSummary(Number(current.employee_id), String(current.month), id, input.as_of)
      : null;
    return this.transaction(() => {
      const request = this.getAdvanceRequest(id);
      if (!request) throw new NotFoundException('Advance request was not found');
      if (request.status !== 'Chờ duyệt') throw new ConflictException('Yêu cầu này đã được xử lý');
      const result = { ...request, code: employee.code, name: employee.name, email: employee.email,
        employee_status: employee.status, start_date: employee.start_date };
      if (input.action === 'reject') {
        this.db.prepare(`UPDATE advance_requests SET status = 'Từ chối', reviewed_by = ?, review_note = ?,
          decided_at = datetime('now','localtime') WHERE id = ? AND status = 'Chờ duyệt'`)
          .run(input.reviewed_by, input.review_note, id);
        return { request: result };
      }
      if (employee.status === 'Nghỉ việc') throw new BadRequestException('Nhân viên đã nghỉ việc');
      if (!summary?.configured) throw new BadRequestException('Nhân viên chưa được thiết lập lương');
      if (summary.locked) throw new ConflictException('Kỳ lương đã chốt, không thể duyệt yêu cầu ứng');
      if (String(request.month) > String(input.as_of || today()).slice(0, 7)) {
        throw new ConflictException('Chưa thể duyệt yêu cầu cho kỳ lương tương lai');
      }
      if (Number(request.amount) > summary.available) {
        throw new ConflictException('Hạn mức ứng đã thay đổi; yêu cầu vượt số tiền hiện có');
      }
      const periodRow = this.db.prepare('SELECT id FROM payroll_periods WHERE month = ?').get(request.month) as { id: number } | undefined;
      const periodId = periodRow ? periodRow.id : Number(this.db.prepare(
        'INSERT INTO payroll_periods(month, created_by) VALUES (?, ?)',
      ).run(request.month, input.reviewed_by).lastInsertRowid);
      const note = `Ứng lương theo yêu cầu #${id}${request.note ? ` – ${request.note}` : ''}`;
      const adjustment = this.db.prepare(`INSERT INTO payroll_adjustments
        (period_id, employee_id, type, amount, note, created_by) VALUES (?, ?, 'advance', ?, ?, ?)`)
        .run(periodId, request.employee_id, request.amount, note, input.reviewed_by);
      this.db.prepare(`UPDATE advance_requests SET status = 'Đã duyệt', reviewed_by = ?, review_note = ?,
        adjustment_id = ?, decided_at = datetime('now','localtime') WHERE id = ? AND status = 'Chờ duyệt'`)
        .run(input.reviewed_by, input.review_note, Number(adjustment.lastInsertRowid), id);
      return { request: result };
    });
  }

  async calculate(periodId: number) {
    const period = this.requirePeriod(periodId);
    if (period.status !== 'Nháp') throw new BadRequestException('Kỳ lương đã chốt, không thể tính lại');
    const month = String(period.month);
    const employees = await this.dependency('/internal/v1/employees', 'employee', 'EMPLOYEE_SERVICE_TIMEOUT_MS') as Employee[];
    const active = employees.filter((employee) => employee.status !== 'Nghỉ việc');
    const settingsValue = await this.dependency('/internal/v1/settings', 'config', 'CONFIG_SERVICE_TIMEOUT_MS');
    if (!settingsValue || typeof settingsValue !== 'object' || Array.isArray(settingsValue)) {
      throw new Error('Config Service returned invalid payroll settings');
    }
    const settings = settingsValue as Record<string, string>;
    const attendanceSummaries: Array<{ employee_id: number; summary: Summary }> = [];
    for (let index = 0; index < active.length; index += 100) {
      const batch = active.slice(index, index + 100);
      const summaries = await callService('/internal/v1/summary/batch', {
        method: 'POST',
        baseUrl: process.env.ATTENDANCE_SERVICE_URL || DEFAULT_URLS.attendance,
        timeoutEnv: 'ATTENDANCE_SERVICE_TIMEOUT_MS',
        serviceName: 'Attendance Service',
        passThrough4xx: true,
        body: { month, employees: batch.map((employee) => ({ id: employee.id, start_date: employee.start_date || '' })) },
      }) as Array<{ employee_id: number; summary: Summary }>;
      attendanceSummaries.push(...summaries);
    }
    const overtimeRows = await this.dependency(`/internal/v1/overtime/approved-hours?month=${encodeURIComponent(month)}`,
      'leave', 'LEAVE_SERVICE_TIMEOUT_MS') as Array<{ employee_id: number; hours: number }>;
    const salaryRows = this.db.prepare('SELECT * FROM employee_salary').all() as unknown as Salary[];
    const salaries = new Map(salaryRows.map((salary) => [salary.employee_id, salary]));
    const adjustmentRows = this.db.prepare(`SELECT employee_id, type, SUM(amount) amount
      FROM payroll_adjustments WHERE period_id = ? GROUP BY employee_id, type`).all(periodId) as Array<{
        employee_id: number; type: string; amount: number;
      }>;
    const adjustments = new Map<number, { bonus?: number; penalty?: number; advance?: number }>();
    adjustmentRows.forEach((row) => {
      const current = adjustments.get(row.employee_id) || {};
      if (row.type === 'bonus' || row.type === 'penalty' || row.type === 'advance') current[row.type] = row.amount;
      adjustments.set(row.employee_id, current);
    });
    const attendanceById = new Map(attendanceSummaries.map((summary) => [summary.employee_id, summary.summary]));
    const overtimeById = new Map(overtimeRows.map((row) => [row.employee_id, row.hours]));
    const skipped: string[] = [];
    const negative: string[] = [];
    const slips: PayslipInput[] = [];
    for (const employee of active) {
      const salary = salaries.get(employee.id);
      if (!salary || salary.base_salary <= 0) {
        skipped.push(`${employee.code} - ${employee.name}`);
        continue;
      }
      const summary = attendanceById.get(employee.id);
      if (!summary) throw new Error(`Attendance Service omitted employee ${employee.id} from payroll summary`);
      const overtimeHours = overtimeById.get(employee.id) || 0;
      const overtimePay = summary.std_days > 0
        ? Math.round((salary.base_salary / summary.std_days / 8) * overtimeHours * Number(settings.overtime_rate || 1.5))
        : 0;
      const calculated = calcPayslip(salary, summary, settings, adjustments.get(employee.id) || {},
        { hours: overtimeHours, pay: overtimePay });
      if (calculated.net < 0) negative.push(`${employee.code} - ${employee.name}`);
      slips.push({
        period_id: periodId,
        employee_id: employee.id,
        employee_code: employee.code,
        employee_name: employee.name,
        department: employee.department || '',
        std_days: summary.std_days,
        paid_days: round2(summary.present + summary.paid_leave),
        present_days: summary.present,
        paid_leave_days: summary.paid_leave,
        unpaid_leave_days: summary.unpaid_leave,
        absent_days: summary.absent,
        ...calculated,
      });
    }
    const unappliedAdjustments = [...adjustments.keys()].filter((employeeId) =>
      !slips.some((slip) => slip.employee_id === employeeId)).length;
    this.transaction(() => {
      const current = this.requirePeriod(periodId);
      if (current.status !== 'Nháp') throw new ConflictException('Kỳ lương đã được thay đổi, vui lòng tải lại và thử lại');
      this.db.prepare('DELETE FROM payslips WHERE period_id = ?').run(periodId);
      const insert = this.db.prepare(`INSERT INTO payslips
        (period_id, employee_id, employee_code, employee_name, department, std_days, paid_days, present_days,
         paid_leave_days, unpaid_leave_days, absent_days, base_salary, allowance, gross, insurance, dependents,
         taxable, tax, net, bonus, penalty, advance, overtime_hours, overtime_pay)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      slips.forEach((slip) => insert.run(
        slip.period_id, slip.employee_id, slip.employee_code, slip.employee_name, slip.department,
        slip.std_days, slip.paid_days, slip.present_days, slip.paid_leave_days, slip.unpaid_leave_days,
        slip.absent_days, slip.base_salary, slip.allowance, slip.gross, slip.insurance, slip.dependents,
        slip.taxable, slip.tax, slip.net, slip.bonus, slip.penalty, slip.advance, slip.overtime_hours, slip.overtime_pay,
      ));
    });
    const end = `${month}-${String(new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate()).padStart(2, '0')}`;
    return {
      count: slips.length,
      skipped,
      negative,
      unapplied_adjustments: unappliedAdjustments,
      warning: end >= today() ? 'Tháng này chưa kết thúc nên ngày công chưa đầy đủ. Hãy tính lại sau khi hết tháng.' : '',
    };
  }

  lockPeriod(periodId: number) {
    const period = this.requirePeriod(periodId);
    if (period.status === 'Đã chốt') throw new BadRequestException('Kỳ lương đã được chốt');
    if (!this.db.prepare('SELECT 1 FROM payslips WHERE period_id = ?').get(periodId)) {
      throw new BadRequestException('Chưa có phiếu lương, hãy bấm Tính lương trước');
    }
    const result = this.db.prepare(`UPDATE payroll_periods SET status = 'Đã chốt',
      locked_at = datetime('now','localtime') WHERE id = ? AND status = 'Nháp'`).run(periodId);
    if (result.changes !== 1) throw new ConflictException('Kỳ lương đã được thay đổi, vui lòng tải lại và thử lại');
    return this.db.prepare('SELECT DISTINCT employee_id FROM payslips WHERE period_id = ?').all(periodId)
      .map((row) => (row as { employee_id: number }).employee_id);
  }

  unlockPeriod(periodId: number) {
    const period = this.requirePeriod(periodId);
    this.db.prepare("UPDATE payroll_periods SET status = 'Nháp', locked_at = NULL WHERE id = ?").run(periodId);
    return period;
  }

  deletePeriod(periodId: number) {
    const period = this.requirePeriod(periodId);
    if (period.status !== 'Nháp') throw new BadRequestException('Chỉ xóa được kỳ lương ở trạng thái Nháp');
    if (this.db.prepare("SELECT 1 FROM advance_requests WHERE month = ? AND status = 'Đã duyệt'").get(String(period.month))) {
      throw new ConflictException('Kỳ lương có khoản ứng đã duyệt, không thể xóa để tránh mất dữ liệu đối soát');
    }
    this.db.prepare('DELETE FROM payroll_periods WHERE id = ?').run(periodId);
    return period;
  }

  lockStatus(from?: string, to?: string, month?: string) {
    if (month) {
      if (!validMonth(month)) throw new BadRequestException('Month must use YYYY-MM format');
      return { locked: this.isLocked(month) };
    }
    if (!from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) {
      throw new BadRequestException('Payroll date range is invalid');
    }
    const locked = Boolean(this.db.prepare(`SELECT 1 FROM payroll_periods WHERE status = 'Đã chốt'
      AND month BETWEEN substr(?, 1, 7) AND substr(?, 1, 7) LIMIT 1`).get(from, to));
    return { locked };
  }

  hasPayrollData(employeeId: number) {
    const hasPayslips = Boolean(this.db.prepare('SELECT 1 FROM payslips WHERE employee_id = ?').get(employeeId));
    const hasAdvances = Boolean(this.db.prepare('SELECT 1 FROM advance_requests WHERE employee_id = ?').get(employeeId));
    const hasSalary = Boolean(this.db.prepare('SELECT 1 FROM employee_salary WHERE employee_id = ?').get(employeeId));
    const hasAdjustments = Boolean(this.db.prepare('SELECT 1 FROM payroll_adjustments WHERE employee_id = ?').get(employeeId));
    return { has_payslips: hasPayslips, has_advances: hasAdvances, has_salary: hasSalary, has_adjustments: hasAdjustments };
  }

  payrollCost(month: string, department?: string) {
    if (!validMonth(month)) throw new BadRequestException('Month must use YYYY-MM format');
    let sql = `SELECT s.department, COUNT(*) AS headcount, SUM(s.gross) AS gross, SUM(s.net) AS net
      FROM payslips s JOIN payroll_periods p ON p.id = s.period_id
      WHERE p.month = ? AND p.status = 'Đã chốt'`;
    const args: Array<string> = [month];
    if (department !== undefined) {
      sql += ' AND s.department = ?';
      args.push(department);
    }
    return this.db.prepare(`${sql} GROUP BY s.department ORDER BY s.department`).all(...args);
  }

  payrollTrend() {
    return this.db.prepare(`SELECT p.month, COUNT(s.id) headcount, SUM(s.gross) gross, SUM(s.net) net
      FROM payroll_periods p JOIN payslips s ON s.period_id = p.id
      WHERE p.status = 'Đã chốt' GROUP BY p.id ORDER BY p.month DESC LIMIT 6`).all().reverse();
  }

  migrateLegacy(input: {
    salaries?: Array<Record<string, unknown>>;
    periods?: Array<Record<string, unknown>>;
    payslips?: Array<Record<string, unknown>>;
    adjustments?: Array<Record<string, unknown>>;
    advances?: Array<Record<string, unknown>>;
  }) {
    const salaries = input?.salaries || [];
    const periods = input?.periods || [];
    const slips = input?.payslips || [];
    const adjustments = input?.adjustments || [];
    const advances = input?.advances || [];
    if ([salaries, periods, slips, adjustments, advances].some((rows) => !Array.isArray(rows) || rows.length > 500)) {
      throw new BadRequestException('Payroll migration batches must not exceed 500 rows per table');
    }
    this.transaction(() => {
      const insertSalary = this.db.prepare(`INSERT OR IGNORE INTO employee_salary
        (employee_id, base_salary, allowance, exempt_allowance, dependents, insured, insured_salary)
        VALUES (?, ?, ?, ?, ?, ?, ?)`);
      salaries.forEach((row) => insertSalary.run(
        positiveId(row.employee_id), Number(row.base_salary), Number(row.allowance), Number(row.exempt_allowance),
        Number(row.dependents), Number(row.insured), Number(row.insured_salary),
      ));
      const insertPeriod = this.db.prepare(`INSERT OR IGNORE INTO payroll_periods
        (id, month, status, created_by, created_at, locked_at) VALUES (?, ?, ?, ?, ?, ?)`);
      periods.forEach((row) => {
        if (!validMonth(String(row.month)) || !['Nháp', 'Đã chốt'].includes(String(row.status))) {
          throw new BadRequestException('Legacy payroll period is invalid');
        }
        insertPeriod.run(positiveId(row.id), String(row.month), String(row.status), String(row.created_by || ''),
          String(row.created_at || ''), row.locked_at == null ? null : String(row.locked_at));
      });
      const insertAdjustment = this.db.prepare(`INSERT OR IGNORE INTO payroll_adjustments
        (id, period_id, employee_id, type, amount, note, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      adjustments.forEach((row) => insertAdjustment.run(
        positiveId(row.id), positiveId(row.period_id), positiveId(row.employee_id), String(row.type),
        Number(row.amount), String(row.note || ''), String(row.created_by || ''), String(row.created_at || ''),
      ));
      const insertSlip = this.db.prepare(`INSERT OR IGNORE INTO payslips
        (id, period_id, employee_id, employee_code, employee_name, department, std_days, paid_days,
         present_days, paid_leave_days, unpaid_leave_days, absent_days, base_salary, allowance, gross,
         insurance, dependents, taxable, tax, net, bonus, penalty, advance, overtime_hours, overtime_pay)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      slips.forEach((row) => insertSlip.run(
        positiveId(row.id), positiveId(row.period_id), positiveId(row.employee_id), String(row.employee_code),
        String(row.employee_name), String(row.department || ''), Number(row.std_days), Number(row.paid_days),
        Number(row.present_days), Number(row.paid_leave_days), Number(row.unpaid_leave_days), Number(row.absent_days),
        Number(row.base_salary), Number(row.allowance), Number(row.gross), Number(row.insurance),
        Number(row.dependents), Number(row.taxable), Number(row.tax), Number(row.net), Number(row.bonus || 0),
        Number(row.penalty || 0), Number(row.advance || 0), Number(row.overtime_hours || 0), Number(row.overtime_pay || 0),
      ));
      const insertAdvance = this.db.prepare(`INSERT OR IGNORE INTO advance_requests
        (id, employee_id, month, amount, note, status, reviewed_by, review_note, adjustment_id, created_at, decided_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      advances.forEach((row) => {
        if (!validMonth(String(row.month)) || !['Chờ duyệt', 'Đã duyệt', 'Từ chối'].includes(String(row.status))) {
          throw new BadRequestException('Legacy advance request is invalid');
        }
        insertAdvance.run(positiveId(row.id), positiveId(row.employee_id), String(row.month), Number(row.amount),
          String(row.note || ''), String(row.status), String(row.reviewed_by || ''), String(row.review_note || ''),
          row.adjustment_id == null ? null : positiveId(row.adjustment_id), String(row.created_at || ''),
          row.decided_at == null ? null : String(row.decided_at));
      });
    });
    return {
      migrated_salaries: salaries.length,
      migrated_periods: periods.length,
      migrated_payslips: slips.length,
      migrated_adjustments: adjustments.length,
      migrated_advances: advances.length,
    };
  }

  migrationRecords(collection: string, ids: string) {
    const values = ids.split(',').map((id) => positiveId(id.trim()));
    if (!values.length || values.length > 100) throw new BadRequestException('Migration verification supports 1 to 100 IDs');
    const queries: Record<string, { sql: string; column: string }> = {
      salaries: { sql: 'SELECT * FROM employee_salary WHERE employee_id', column: 'employee_id' },
      periods: { sql: 'SELECT * FROM payroll_periods WHERE id', column: 'id' },
      payslips: { sql: 'SELECT * FROM payslips WHERE id', column: 'id' },
      adjustments: { sql: 'SELECT * FROM payroll_adjustments WHERE id', column: 'id' },
      advances: { sql: 'SELECT * FROM advance_requests WHERE id', column: 'id' },
    };
    const query = queries[collection];
    if (!query) throw new BadRequestException('Unknown payroll migration collection');
    return this.db.prepare(`${query.sql} IN (${values.map(() => '?').join(',')})`).all(...values);
  }
}

@Controller()
class PayrollController {
  constructor(private readonly payroll: PayrollService) {}

  private authorize(token: string | undefined) {
    const expected = process.env.INTERNAL_SERVICE_TOKEN
      || (process.env.NODE_ENV === 'production' ? '' : 'dev-only-internal-service-token');
    if (!token || !expected || Buffer.byteLength(token) !== Buffer.byteLength(expected)
      || !timingSafeEqual(Buffer.from(token), Buffer.from(expected))) {
      throw new UnauthorizedException('Invalid service credentials');
    }
  }

  @Get('/health')
  health() {
    return { status: 'ok', service: 'hrm-payroll-service' };
  }

  @Get('/internal/v1/payroll/salaries')
  listSalaries(@Headers('x-internal-service-token') token: string | undefined, @Query('employee_ids') ids?: string) {
    this.authorize(token);
    return this.payroll.listSalaries(ids);
  }

  @Put('/internal/v1/payroll/salaries/:employeeId')
  upsertSalary(@Headers('x-internal-service-token') token: string | undefined, @Param('employeeId') employeeId: string,
    @Body() body: Omit<Salary, 'employee_id'>) {
    this.authorize(token);
    return this.payroll.upsertSalary(positiveId(employeeId), body);
  }

  @Get('/internal/v1/payroll/periods')
  listPeriods(@Headers('x-internal-service-token') token: string | undefined, @Query('employee_id') employeeId?: string) {
    this.authorize(token);
    return this.payroll.listPeriods(employeeId ? positiveId(employeeId) : undefined);
  }

  @Post('/internal/v1/payroll/periods')
  createPeriod(@Headers('x-internal-service-token') token: string | undefined, @Body() body: { month: string; created_by: string }) {
    this.authorize(token);
    return this.payroll.createPeriod(String(body?.month || ''), String(body?.created_by || ''));
  }

  @Get('/internal/v1/payroll/periods/:id')
  getPeriod(@Headers('x-internal-service-token') token: string | undefined, @Param('id') id: string) {
    this.authorize(token);
    return this.payroll.findPeriod(positiveId(id));
  }

  @Get('/internal/v1/payroll/periods/:id/payslips')
  listPayslips(@Headers('x-internal-service-token') token: string | undefined, @Param('id') id: string,
    @Query('employee_id') employeeId?: string) {
    this.authorize(token);
    return this.payroll.listPayslips(positiveId(id), employeeId ? positiveId(employeeId) : undefined);
  }

  @Post('/internal/v1/payroll/periods/:id/calculate')
  calculate(@Headers('x-internal-service-token') token: string | undefined, @Param('id') id: string) {
    this.authorize(token);
    return this.payroll.calculate(positiveId(id));
  }

  @Post('/internal/v1/payroll/periods/:id/lock')
  lockPeriod(@Headers('x-internal-service-token') token: string | undefined, @Param('id') id: string) {
    this.authorize(token);
    return { employee_ids: this.payroll.lockPeriod(positiveId(id)) };
  }

  @Post('/internal/v1/payroll/periods/:id/unlock')
  unlockPeriod(@Headers('x-internal-service-token') token: string | undefined, @Param('id') id: string) {
    this.authorize(token);
    return this.payroll.unlockPeriod(positiveId(id));
  }

  @Delete('/internal/v1/payroll/periods/:id')
  deletePeriod(@Headers('x-internal-service-token') token: string | undefined, @Param('id') id: string) {
    this.authorize(token);
    return this.payroll.deletePeriod(positiveId(id));
  }

  @Get('/internal/v1/payroll/periods/:id/adjustments')
  listAdjustments(@Headers('x-internal-service-token') token: string | undefined, @Param('id') id: string) {
    this.authorize(token);
    return this.payroll.listAdjustments(positiveId(id));
  }

  @Post('/internal/v1/payroll/periods/:id/adjustments')
  createAdjustment(@Headers('x-internal-service-token') token: string | undefined, @Param('id') id: string,
    @Body() body: { employee_id: number; type: string; amount: number; note: string; created_by: string }) {
    this.authorize(token);
    return this.payroll.createAdjustment(positiveId(id), body);
  }

  @Delete('/internal/v1/payroll/periods/:id/adjustments/:adjustmentId')
  deleteAdjustment(@Headers('x-internal-service-token') token: string | undefined, @Param('id') id: string,
    @Param('adjustmentId') adjustmentId: string) {
    this.authorize(token);
    return this.payroll.deleteAdjustment(positiveId(id), positiveId(adjustmentId));
  }

  @Get('/internal/v1/payroll/advances')
  listAdvanceRequests(@Headers('x-internal-service-token') token: string | undefined, @Query('employee_id') employeeId?: string) {
    this.authorize(token);
    return this.payroll.listAdvanceRequests(employeeId ? positiveId(employeeId) : undefined);
  }

  @Get('/internal/v1/payroll/advances/:id')
  getAdvanceRequest(@Headers('x-internal-service-token') token: string | undefined, @Param('id') id: string) {
    this.authorize(token);
    return this.payroll.getAdvanceRequest(positiveId(id)) || null;
  }

  @Post('/internal/v1/payroll/advances')
  createAdvanceRequest(@Headers('x-internal-service-token') token: string | undefined,
    @Body() body: { employee_id: number; month: string; amount: number; note: string; as_of?: string }) {
    this.authorize(token);
    return this.payroll.createAdvanceRequest(body);
  }

  @Put('/internal/v1/payroll/advances/:id/decision')
  decideAdvanceRequest(@Headers('x-internal-service-token') token: string | undefined, @Param('id') id: string,
    @Body() body: { action: 'approve' | 'reject'; reviewed_by: string; review_note: string; as_of?: string }) {
    this.authorize(token);
    return this.payroll.decideAdvanceRequest(positiveId(id), body);
  }

  @Get('/internal/v1/payroll/advance-summary')
  advanceSummary(@Headers('x-internal-service-token') token: string | undefined, @Query('employee_id') employeeId: string,
    @Query('month') month: string, @Query('exclude_request_id') excludeId?: string, @Query('as_of') asOf?: string) {
    this.authorize(token);
    return this.payroll.advanceSummary(positiveId(employeeId), month,
      excludeId ? positiveId(excludeId) : undefined, asOf);
  }

  @Get('/internal/v1/payroll/lock-status')
  lockStatus(@Headers('x-internal-service-token') token: string | undefined, @Query('from') from?: string,
    @Query('to') to?: string, @Query('month') month?: string) {
    this.authorize(token);
    return this.payroll.lockStatus(from, to, month);
  }

  @Get('/internal/v1/payroll/employees/:id/has-data')
  hasPayrollData(@Headers('x-internal-service-token') token: string | undefined, @Param('id') id: string) {
    this.authorize(token);
    return this.payroll.hasPayrollData(positiveId(id));
  }

  @Get('/internal/v1/payroll/stats/cost')
  payrollCost(@Headers('x-internal-service-token') token: string | undefined, @Query('month') month: string,
    @Query('department') department?: string) {
    this.authorize(token);
    return this.payroll.payrollCost(month, department);
  }

  @Get('/internal/v1/payroll/stats/trend')
  payrollTrend(@Headers('x-internal-service-token') token: string | undefined) {
    this.authorize(token);
    return this.payroll.payrollTrend();
  }

  @Post('/internal/v1/migrate')
  migrateLegacy(@Headers('x-internal-service-token') token: string | undefined,
    @Body() body: Parameters<PayrollService['migrateLegacy']>[0]) {
    this.authorize(token);
    return this.payroll.migrateLegacy(body);
  }

  @Get('/internal/v1/migration-records/:collection')
  migrationRecords(@Headers('x-internal-service-token') token: string | undefined,
    @Param('collection') collection: string, @Query('ids') ids: string) {
    this.authorize(token);
    return this.payroll.migrationRecords(collection, ids);
  }
}

@Module({
  controllers: [PayrollController],
  providers: [PayrollService],
})
export class PayrollServiceModule {}
