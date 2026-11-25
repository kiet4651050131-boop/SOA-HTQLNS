import { timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Injectable,
  Module,
  OnModuleDestroy,
  Param,
  Post,
  Put,
  Query,
  UnauthorizedException,
} from '@nestjs/common';

interface LeaveType {
  id: number;
  name: string;
  paid: number;
  uses_quota: number;
}

interface LeaveRequestInput {
  id?: number;
  employee_id: number;
  type_id: number;
  from_date: string;
  to_date: string;
  half: number;
  days: number;
  reason: string;
  status: string;
  manager_note?: string;
  decided_by?: string;
  created_at?: string;
}

interface OvertimeRequestInput {
  id?: number;
  employee_id: number;
  date: string;
  hours: number;
  reason: string;
  status: string;
  manager_note?: string;
  decided_by?: string;
  created_at?: string;
}

const LEAVE_STATUSES = ['Chờ quản lý', 'Chờ HR', 'Đã duyệt', 'Từ chối', 'Đã hủy'];
const DEFAULT_TYPES: LeaveType[] = [
  { id: 1, name: 'Phép năm', paid: 1, uses_quota: 1 },
  { id: 2, name: 'Nghỉ ốm', paid: 1, uses_quota: 0 },
  { id: 3, name: 'Nghỉ không lương', paid: 0, uses_quota: 0 },
];

function validDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function positiveId(value: unknown) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw new BadRequestException('Employee ID is invalid');
  return id;
}

function parseIds(value: string | undefined) {
  if (!value) return [];
  const ids = value.split(',').map((part) => positiveId(part.trim()));
  const unique = [...new Set(ids)];
  if (unique.length > 100) throw new BadRequestException('At most 100 employee IDs can be requested');
  return unique;
}

@Injectable()
export class LeaveService implements OnModuleDestroy {
  private readonly db: DatabaseSync;

  constructor() {
    const file = process.env.LEAVE_DB_FILE || path.join(__dirname, '..', 'data', 'leave.db');
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS leave_types (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        paid INTEGER NOT NULL DEFAULT 1,
        uses_quota INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS leave_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        employee_id INTEGER NOT NULL,
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
      CREATE INDEX IF NOT EXISTS idx_leave_dates ON leave_requests(from_date, to_date, status);
      CREATE TABLE IF NOT EXISTS overtime_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        employee_id INTEGER NOT NULL,
        date TEXT NOT NULL,
        hours REAL NOT NULL CHECK (hours > 0 AND hours <= 12),
        reason TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'Chờ HR' CHECK (status IN ('Chờ quản lý','Chờ HR','Đã duyệt','Từ chối','Đã hủy')),
        manager_note TEXT NOT NULL DEFAULT '',
        decided_by TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
      );
      CREATE INDEX IF NOT EXISTS idx_overtime_date_status ON overtime_requests(date, status);
      CREATE INDEX IF NOT EXISTS idx_overtime_employee_status ON overtime_requests(employee_id, status);
    `);
  }

  onModuleDestroy() {
    this.db.close();
  }

  getTypes() {
    return this.db.prepare('SELECT id, name, paid, uses_quota FROM leave_types ORDER BY id').all() as unknown as LeaveType[];
  }

  getRequests(idsValue: string | undefined, status?: string) {
    const ids = parseIds(idsValue);
    if (!ids.length) return [];
    let sql = `SELECT r.id, r.employee_id, r.type_id, r.from_date, r.to_date, r.days, r.half, r.reason,
      r.status, r.manager_note, r.decided_by, r.created_at, t.name AS type, t.paid
      FROM leave_requests r JOIN leave_types t ON t.id = r.type_id
      WHERE r.employee_id IN (${ids.map(() => '?').join(',')})`;
    const args: Array<string | number> = [...ids];
    if (status) {
      if (!LEAVE_STATUSES.includes(status)) throw new BadRequestException('Leave status is invalid');
      sql += ' AND r.status = ?';
      args.push(status);
    }
    sql += ` ORDER BY CASE WHEN r.status IN ('Chờ quản lý','Chờ HR') THEN 0 ELSE 1 END,
      r.from_date DESC, r.id DESC LIMIT 500`;
    return this.db.prepare(sql).all(...args);
  }

  getRequest(id: number) {
    return this.db.prepare(`SELECT r.id, r.employee_id, r.type_id, r.from_date, r.to_date, r.days, r.half, r.reason,
      r.status, r.manager_note, r.decided_by, r.created_at, t.name AS type, t.paid
      FROM leave_requests r JOIN leave_types t ON t.id = r.type_id WHERE r.id = ?`).get(id) || null;
  }

  getRequestsByRecordIds(value: string | undefined) {
    const ids = parseIds(value);
    if (!ids.length) return [];
    return this.db.prepare(`SELECT r.id, r.employee_id, r.type_id, r.from_date, r.to_date, r.days, r.half, r.reason,
      r.status, r.manager_note, r.decided_by, r.created_at
      FROM leave_requests r WHERE r.id IN (${ids.map(() => '?').join(',')})`).all(...ids);
  }

  hasOverlappingRequest(employeeId: number, from: string, to: string) {
    if (!validDate(from) || !validDate(to) || from > to) {
      throw new BadRequestException('Leave date range is invalid');
    }
    return Boolean(this.db.prepare(`SELECT 1 FROM leave_requests
      WHERE employee_id = ? AND status IN ('Chờ quản lý','Chờ HR','Đã duyệt')
        AND from_date <= ? AND to_date >= ? LIMIT 1`).get(employeeId, to, from));
  }

  countRequests(idsValue: string | undefined, status: string) {
    const ids = parseIds(idsValue);
    if (!ids.length) return { count: 0 };
    if (!LEAVE_STATUSES.includes(status)) throw new BadRequestException('Leave status is invalid');
    const result = this.db.prepare(`SELECT COUNT(*) AS count FROM leave_requests
        WHERE employee_id IN (${ids.map(() => '?').join(',')}) AND status = ?`).get(...ids, status) as { count: number };
    return { count: result.count };
  }

  createRequest(input: LeaveRequestInput) {
    const employeeId = positiveId(input?.employee_id);
    const typeId = positiveId(input?.type_id);
    const from = String(input?.from_date || '');
    const to = String(input?.to_date || '');
    const half = Number(input?.half);
    const days = Number(input?.days);
    if (!validDate(from) || !validDate(to) || to < from || from.slice(0, 4) !== to.slice(0, 4)
      || (half !== 0 && half !== 1) || (half && from !== to) || !LEAVE_STATUSES.includes(input.status)
      || !Number.isFinite(days) || days <= 0) {
      throw new BadRequestException('Leave request is invalid');
    }
    if (!this.db.prepare('SELECT 1 FROM leave_types WHERE id = ?').get(typeId)) {
      throw new BadRequestException('Leave type does not exist');
    }
    const result = this.db.prepare(`INSERT INTO leave_requests
      (employee_id, type_id, from_date, to_date, half, days, reason, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      employeeId, typeId, from, to, half, days,
      String(input.reason || '').slice(0, 500), input.status,
    );
    return { id: Number(result.lastInsertRowid) };
  }

  updateRequest(id: number, input: { status?: string; manager_note?: string; decided_by?: string }) {
    if (!this.getRequest(id)) return null;
    if (!input.status || !LEAVE_STATUSES.includes(input.status)) {
      throw new BadRequestException('Leave status is invalid');
    }
    this.db.prepare(`UPDATE leave_requests SET status = ?, manager_note = ?, decided_by = ? WHERE id = ?`)
      .run(input.status, String(input.manager_note || '').slice(0, 300),
        String(input.decided_by || '').slice(0, 200), id);
    return { ok: true };
  }

  approvedLeaves(idsValue: string | undefined, from: string, to: string) {
    const ids = parseIds(idsValue);
    if (!ids.length) return [];
    if (!validDate(from) || !validDate(to) || from > to) throw new BadRequestException('Leave date range is invalid');
    return this.db.prepare(`SELECT r.employee_id, r.from_date, r.to_date, r.half, t.paid, t.name AS tname
      FROM leave_requests r JOIN leave_types t ON t.id = r.type_id
      WHERE r.status = 'Đã duyệt' AND r.employee_id IN (${ids.map(() => '?').join(',')})
        AND r.from_date <= ? AND r.to_date >= ?`).all(...ids, to, from);
  }

  leaveBalance(employeeId: number, year: string, quota: number) {
    if (!/^\d{4}$/.test(year)) throw new BadRequestException('Year must use YYYY format');
    if (!Number.isFinite(quota) || quota < 0) throw new BadRequestException('Annual leave quota is invalid');
    const sum = (statuses: string[]) => Number(this.db.prepare(`SELECT COALESCE(SUM(r.days), 0) AS total
      FROM leave_requests r JOIN leave_types t ON t.id = r.type_id
      WHERE r.employee_id = ? AND t.uses_quota = 1 AND r.from_date LIKE ?
        AND r.status IN (${statuses.map(() => '?').join(',')})`)
      .get(employeeId, `${year}-%`, ...statuses)?.total || 0);
    const used = sum(['Đã duyệt']);
    const pending = sum(['Chờ quản lý', 'Chờ HR']);
    return { year: Number(year), quota, used, pending, remaining: quota - used - pending };
  }

  getOvertimeRequests(idsValue: string | undefined) {
    const ids = parseIds(idsValue);
    if (!ids.length) return [];
    return this.db.prepare(`SELECT o.* FROM overtime_requests o
      WHERE o.employee_id IN (${ids.map(() => '?').join(',')})
      ORDER BY CASE WHEN o.status IN ('Chờ quản lý','Chờ HR') THEN 0 ELSE 1 END,
        o.date DESC, o.id DESC LIMIT 500`).all(...ids);
  }

  getOvertimeRequest(id: number) {
    return this.db.prepare('SELECT * FROM overtime_requests WHERE id = ?').get(id) || null;
  }

  getOvertimeRequestsByRecordIds(value: string | undefined) {
    const ids = parseIds(value);
    if (!ids.length) return [];
    return this.db.prepare(`SELECT * FROM overtime_requests
      WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);
  }

  createOvertimeRequest(input: OvertimeRequestInput) {
    const employeeId = positiveId(input?.employee_id);
    const date = String(input?.date || '');
    const hours = Number(input?.hours);
    if (!validDate(date) || !Number.isFinite(hours) || hours < 0.5 || hours > 12
      || Math.round(hours * 2) !== hours * 2
      || !LEAVE_STATUSES.includes(input.status)) {
      throw new BadRequestException('Overtime request is invalid');
    }
    const result = this.db.prepare(`INSERT INTO overtime_requests(employee_id, date, hours, reason, status)
      VALUES (?, ?, ?, ?, ?)`).run(
      employeeId, date, hours, String(input.reason || '').slice(0, 500), input.status,
    );
    return { id: Number(result.lastInsertRowid) };
  }

  updateOvertimeRequest(id: number, input: { status?: string; manager_note?: string; decided_by?: string }) {
    if (!this.getOvertimeRequest(id)) return null;
    if (!input.status || !LEAVE_STATUSES.includes(input.status)) {
      throw new BadRequestException('Overtime status is invalid');
    }
    this.db.prepare('UPDATE overtime_requests SET status = ?, manager_note = ?, decided_by = ? WHERE id = ?')
      .run(input.status, String(input.manager_note || '').slice(0, 300),
        String(input.decided_by || '').slice(0, 200), id);
    return { ok: true };
  }

  approvedOvertimeHours(month: string, to?: string) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new BadRequestException('Month must use YYYY-MM format');
    if (to && (!validDate(to) || to.slice(0, 7) !== month)) {
      throw new BadRequestException('Overtime cutoff date is invalid');
    }
    return this.db.prepare(`SELECT employee_id, SUM(hours) AS hours FROM overtime_requests
      WHERE status = 'Đã duyệt' AND substr(date, 1, 7) = ? AND (? IS NULL OR date <= ?)
      GROUP BY employee_id`).all(month, to || null, to || null);
  }

  leaveReport(idsValue: string | undefined, from: string, to: string) {
    const ids = parseIds(idsValue);
    if (!ids.length) return [];
    if (!validDate(from) || !validDate(to) || from > to) throw new BadRequestException('Leave report range is invalid');
    return this.db.prepare(`SELECT status, COUNT(*) AS requests, COALESCE(SUM(days), 0) AS days
      FROM leave_requests WHERE employee_id IN (${ids.map(() => '?').join(',')})
        AND from_date <= ? AND to_date >= ?
      GROUP BY status ORDER BY status`).all(...ids, to, from);
  }

  overtimeReport(idsValue: string | undefined, from: string, to: string) {
    const ids = parseIds(idsValue);
    if (!ids.length) return { requests: 0, hours: 0 };
    if (!validDate(from) || !validDate(to) || from > to) throw new BadRequestException('Overtime report range is invalid');
    return this.db.prepare(`SELECT COUNT(*) AS requests, COALESCE(SUM(hours), 0) AS hours
      FROM overtime_requests WHERE date BETWEEN ? AND ? AND status = 'Đã duyệt'
        AND employee_id IN (${ids.map(() => '?').join(',')})`).get(from, to, ...ids);
  }

  hasEmployeeRequests(employeeId: number) {
    return Boolean(this.db.prepare(`SELECT 1 FROM leave_requests WHERE employee_id = ?
      UNION ALL SELECT 1 FROM overtime_requests WHERE employee_id = ? LIMIT 1`).get(employeeId, employeeId));
  }

  migrate(input: {
    leave_types?: LeaveType[];
    leave_requests?: LeaveRequestInput[];
    overtime_requests?: OvertimeRequestInput[];
  }) {
    const types = input?.leave_types || [];
    const leaves = input?.leave_requests || [];
    const overtime = input?.overtime_requests || [];
    if (![types, leaves, overtime].every(Array.isArray)
      || types.length > 500 || leaves.length > 500 || overtime.length > 500) {
      throw new BadRequestException('Migration batches must contain at most 500 records per collection');
    }
    const currentTypes = this.getTypes();
    const typeRows = types.length || currentTypes.length ? types : DEFAULT_TYPES;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const insertType = this.db.prepare(`INSERT OR IGNORE INTO leave_types(id, name, paid, uses_quota)
        VALUES (?, ?, ?, ?)`);
      typeRows.forEach((type) => {
        const paid = Number(type.paid);
        const usesQuota = Number(type.uses_quota);
        if (!Number.isSafeInteger(Number(type.id)) || Number(type.id) < 1
          || !String(type.name || '').trim() || ![0, 1].includes(paid) || ![0, 1].includes(usesQuota)) {
          throw new BadRequestException('Legacy leave type is invalid');
        }
        insertType.run(Number(type.id), String(type.name), paid, usesQuota);
      });
      const insertLeave = this.db.prepare(`INSERT OR IGNORE INTO leave_requests
        (id, employee_id, type_id, from_date, to_date, half, days, reason, status, manager_note, decided_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      leaves.forEach((leave) => {
        const days = Number(leave.days);
        if (!Number.isSafeInteger(Number(leave.id)) || Number(leave.id) < 1
          || !positiveId(leave.employee_id) || !positiveId(leave.type_id)
          || !validDate(leave.from_date) || !validDate(leave.to_date)
          || !Number.isFinite(days) || days <= 0 || !LEAVE_STATUSES.includes(leave.status)) {
          throw new BadRequestException('Legacy leave request is invalid');
        }
        insertLeave.run(Number(leave.id), positiveId(leave.employee_id), positiveId(leave.type_id),
          leave.from_date, leave.to_date, Number(leave.half) ? 1 : 0, days,
          String(leave.reason || ''), leave.status,
          String(leave.manager_note || ''), String(leave.decided_by || ''), String(leave.created_at || ''));
      });
      const insertOvertime = this.db.prepare(`INSERT OR IGNORE INTO overtime_requests
        (id, employee_id, date, hours, reason, status, manager_note, decided_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      overtime.forEach((request) => {
        const hours = Number(request.hours);
        if (!Number.isSafeInteger(Number(request.id)) || Number(request.id) < 1
          || !positiveId(request.employee_id) || !validDate(request.date)
          || !Number.isFinite(hours) || hours <= 0 || hours > 12 || !LEAVE_STATUSES.includes(request.status)) {
          throw new BadRequestException('Legacy overtime request is invalid');
        }
        insertOvertime.run(Number(request.id), positiveId(request.employee_id), request.date, hours,
          String(request.reason || ''), request.status,
          String(request.manager_note || ''), String(request.decided_by || ''), String(request.created_at || ''));
      });
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { migrated_types: typeRows.length, migrated_leave_requests: leaves.length, migrated_overtime_requests: overtime.length };
  }
}

@Controller()
class LeaveController {
  constructor(private readonly leave: LeaveService) {}

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
    return { status: 'ok', service: 'hrm-leave-service' };
  }

  @Get('/internal/v1/leave/types')
  getTypes(@Headers('x-internal-service-token') token: string | undefined) {
    this.authorize(token);
    return this.leave.getTypes();
  }

  @Get('/internal/v1/leave/requests')
  getRequests(@Headers('x-internal-service-token') token: string | undefined,
    @Query('ids') ids: string | undefined, @Query('status') status?: string) {
    this.authorize(token);
    return this.leave.getRequests(ids, status);
  }

  @Get('/internal/v1/leave/requests/by-record-ids')
  getRequestsByRecordIds(@Headers('x-internal-service-token') token: string | undefined,
    @Query('ids') ids: string | undefined) {
    this.authorize(token);
    return this.leave.getRequestsByRecordIds(ids);
  }

  @Get('/internal/v1/leave/requests/:id')
  getRequest(@Headers('x-internal-service-token') token: string | undefined, @Param('id') id: string) {
    this.authorize(token);
    return this.leave.getRequest(positiveId(id));
  }

  @Get('/internal/v1/leave/conflict')
  hasOverlappingRequest(@Headers('x-internal-service-token') token: string | undefined,
    @Query('employee_id') employeeId: string, @Query('from') from: string, @Query('to') to: string) {
    this.authorize(token);
    return { conflict: this.leave.hasOverlappingRequest(positiveId(employeeId), from, to) };
  }

  @Get('/internal/v1/leave/count')
  countRequests(@Headers('x-internal-service-token') token: string | undefined,
    @Query('ids') ids: string | undefined, @Query('status') status: string) {
    this.authorize(token);
    return this.leave.countRequests(ids, status);
  }

  @Get('/internal/v1/leave/balance')
  leaveBalance(@Headers('x-internal-service-token') token: string | undefined,
    @Query('employee_id') employeeId: string, @Query('year') year: string, @Query('quota') quota: string) {
    this.authorize(token);
    if (quota === undefined || quota.trim() === '') throw new BadRequestException('Annual leave quota is required');
    return this.leave.leaveBalance(positiveId(employeeId), year, Number(quota));
  }

  @Get('/internal/v1/leave/approved')
  approvedLeaves(@Headers('x-internal-service-token') token: string | undefined,
    @Query('ids') ids: string | undefined, @Query('from') from: string, @Query('to') to: string) {
    this.authorize(token);
    return this.leave.approvedLeaves(ids, from, to);
  }

  @Post('/internal/v1/leave/requests')
  createRequest(@Headers('x-internal-service-token') token: string | undefined, @Body() body: LeaveRequestInput) {
    this.authorize(token);
    return this.leave.createRequest(body);
  }

  @Put('/internal/v1/leave/requests/:id')
  updateRequest(@Headers('x-internal-service-token') token: string | undefined, @Param('id') id: string,
    @Body() body: { status?: string; manager_note?: string; decided_by?: string }) {
    this.authorize(token);
    return this.leave.updateRequest(positiveId(id), body);
  }

  @Get('/internal/v1/overtime/requests')
  getOvertimeRequests(@Headers('x-internal-service-token') token: string | undefined, @Query('ids') ids: string | undefined) {
    this.authorize(token);
    return this.leave.getOvertimeRequests(ids);
  }

  @Get('/internal/v1/overtime/requests/by-record-ids')
  getOvertimeRequestsByRecordIds(@Headers('x-internal-service-token') token: string | undefined,
    @Query('ids') ids: string | undefined) {
    this.authorize(token);
    return this.leave.getOvertimeRequestsByRecordIds(ids);
  }

  @Get('/internal/v1/overtime/requests/:id')
  getOvertimeRequest(@Headers('x-internal-service-token') token: string | undefined, @Param('id') id: string) {
    this.authorize(token);
    return this.leave.getOvertimeRequest(positiveId(id));
  }

  @Post('/internal/v1/overtime/requests')
  createOvertimeRequest(@Headers('x-internal-service-token') token: string | undefined, @Body() body: OvertimeRequestInput) {
    this.authorize(token);
    return this.leave.createOvertimeRequest(body);
  }

  @Put('/internal/v1/overtime/requests/:id')
  updateOvertimeRequest(@Headers('x-internal-service-token') token: string | undefined, @Param('id') id: string,
    @Body() body: { status?: string; manager_note?: string; decided_by?: string }) {
    this.authorize(token);
    return this.leave.updateOvertimeRequest(positiveId(id), body);
  }

  @Get('/internal/v1/overtime/approved-hours')
  approvedOvertimeHours(@Headers('x-internal-service-token') token: string | undefined,
    @Query('month') month: string, @Query('to') to?: string) {
    this.authorize(token);
    return this.leave.approvedOvertimeHours(month, to);
  }

  @Get('/internal/v1/reports')
  report(@Headers('x-internal-service-token') token: string | undefined,
    @Query('ids') ids: string | undefined, @Query('from') from: string, @Query('to') to: string) {
    this.authorize(token);
    return {
      leave: this.leave.leaveReport(ids, from, to),
      overtime: this.leave.overtimeReport(ids, from, to),
    };
  }

  @Get('/internal/v1/employees/:id/has-requests')
  hasEmployeeRequests(@Headers('x-internal-service-token') token: string | undefined, @Param('id') id: string) {
    this.authorize(token);
    return { has_requests: this.leave.hasEmployeeRequests(positiveId(id)) };
  }

  @Post('/internal/v1/migrate')
  migrate(@Headers('x-internal-service-token') token: string | undefined,
    @Body() body: { leave_types?: LeaveType[]; leave_requests?: LeaveRequestInput[]; overtime_requests?: OvertimeRequestInput[] }) {
    this.authorize(token);
    return this.leave.migrate(body);
  }
}

@Module({
  controllers: [LeaveController],
  providers: [LeaveService],
})
export class LeaveServiceModule {}
