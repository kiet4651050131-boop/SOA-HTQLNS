import { timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  Headers,
  Injectable,
  Module,
  OnModuleDestroy,
  Post,
  Body,
  Query,
  UnauthorizedException,
} from '@nestjs/common';

interface AttendanceInput {
  id?: number;
  employee_id: number;
  date: string;
  check_in?: string | null;
  check_out?: string | null;
  note?: string;
  source?: string;
}

interface EmployeeForSummary {
  id: number;
  start_date?: string;
}

interface ApprovedLeave {
  employee_id: number;
  from_date: string;
  to_date: string;
  half: number;
  paid: number;
  tname: string;
}

interface AttendanceRow {
  id: number;
  employee_id: number;
  date: string;
  check_in: string | null;
  check_out: string | null;
  note: string;
  source: string;
}

interface ValidatedAttendance {
  employee_id: number;
  date: string;
  check_in: string | null;
  check_out: string | null;
  note: string;
  source: string;
}

interface ServiceCallOptions {
  method?: 'GET' | 'POST';
  baseUrl?: string;
  timeoutEnv?: string;
  serviceName?: string;
  passThrough4xx?: boolean;
  body?: unknown;
}

const { callService } = require('../service-client') as {
  callService(path: string, options: ServiceCallOptions): Promise<unknown>;
};

function validDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validTime(value: string) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function positiveId(value: unknown): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw new BadRequestException('Employee ID is invalid');
  return id;
}

function parseIds(value: string | undefined) {
  if (!value) return [];
  const ids = value.split(',').map((part) => positiveId(part.trim()));
  return [...new Set(ids)];
}

function monthRange(month: string) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new BadRequestException('Month must use YYYY-MM format');
  const [year, monthNumber] = month.split('-').map(Number);
  const lastDay = new Date(year, monthNumber, 0).getDate();
  return { from: `${month}-01`, to: `${month}-${String(lastDay).padStart(2, '0')}` };
}

function eachDay(from: string, to: string) {
  const days: string[] = [];
  const date = new Date(`${from}T00:00:00`);
  const format = (value: Date) => `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  while (format(date) <= to) {
    days.push(format(date));
    date.setDate(date.getDate() + 1);
  }
  return days;
}

function round2(value: number) {
  return Math.round(value * 100) / 100;
}

function hoursBetween(start: string | null, end: string | null) {
  if (!start || !end) return null;
  const startMinutes = Number(start.slice(0, 2)) * 60 + Number(start.slice(3, 5));
  const endMinutes = Number(end.slice(0, 2)) * 60 + Number(end.slice(3, 5));
  return (endMinutes - startMinutes) / 60;
}

function summarizeEmployee(
  employee: EmployeeForSummary,
  month: string,
  settings: Record<string, string>,
  holidayDates: Set<string>,
  attendance: AttendanceRow[],
  approvedLeaves: ApprovedLeave[],
) {
  const { from, to } = monthRange(month);
  const days = eachDay(from, to);
  const workdays = days.filter((date) => {
    const weekday = new Date(`${date}T00:00:00`).getDay();
    return !holidayDates.has(date) && weekday !== 0 && (weekday !== 6 || settings.work_saturday === '1');
  });
  const workdaySet = new Set(workdays);
  const attendanceByDate = new Map(attendance.map((row) => [row.date, row]));
  const leaveByDate = new Map<string, { frac: number; paid: boolean; type: string }>();

  approvedLeaves
    .filter((leave) => leave.employee_id === employee.id && leave.from_date <= to && leave.to_date >= from)
    .forEach((leave) => {
      const start = leave.from_date > from ? leave.from_date : from;
      const end = leave.to_date < to ? leave.to_date : to;
      eachDay(start, end).filter((date) => workdaySet.has(date)).forEach((date) => {
        leaveByDate.set(date, { frac: leave.half ? 0.5 : 1, paid: Boolean(leave.paid), type: leave.tname });
      });
    });

  const today = new Date();
  const todayString = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const startDate = employee.start_date || '';
  const summary = { std_days: workdays.length, present: 0, paid_leave: 0, unpaid_leave: 0, absent: 0, late: 0, missing_checkout: 0 };
  const detail = days.map((date) => {
    const record = attendanceByDate.get(date) || null;
    const leave = leaveByDate.get(date) || null;
    const row: Record<string, unknown> = {
      date,
      dow: new Date(`${date}T00:00:00`).getDay(),
      workday: workdaySet.has(date),
      holiday: holidayDates.has(date),
      check_in: record ? record.check_in : null,
      check_out: record ? record.check_out : null,
      note: record ? record.note : '',
      leave,
      hours: null,
      status: '',
    };
    if (record) row.hours = hoursBetween(record.check_in || null, record.check_out || null);
    if (!row.workday) {
      row.status = row.holiday ? 'Ngày lễ' : (record && record.check_in ? 'Làm ngày nghỉ' : 'Nghỉ cuối tuần');
      return row;
    }
    if (startDate && date < startDate) {
      row.status = 'Chưa vào làm';
      return row;
    }
    let credit = 0;
    if (record && record.check_in) {
      if (record.check_out) credit = Number(row.hours) >= 4 ? 1 : 0.5;
      else {
        credit = 1;
        summary.missing_checkout++;
        row.missing = true;
      }
    }
    const leaveFraction = leave ? leave.frac : 0;
    const present = Math.min(credit, 1 - leaveFraction);
    summary.present += present;
    if (leave) {
      if (leave.paid) summary.paid_leave += leaveFraction;
      else summary.unpaid_leave += leaveFraction;
    }
    if (record && record.check_in && present > 0 && record.check_in > settings.work_start) {
      summary.late++;
      row.late = true;
    }
    if (date < todayString) summary.absent += Math.max(0, 1 - present - leaveFraction);
    if (date > todayString && !leave && !record) row.status = '';
    else if (leave && present === 0) row.status = leave.paid ? `Nghỉ phép (${leave.type})` : 'Nghỉ không lương';
    else if (present > 0) row.status = row.missing ? 'Thiếu check-out' : (row.late ? 'Đi muộn' : 'Đi làm');
    else if (date < todayString) row.status = 'Vắng';
    return row;
  });

  summary.present = round2(summary.present);
  summary.paid_leave = round2(summary.paid_leave);
  summary.unpaid_leave = round2(summary.unpaid_leave);
  summary.absent = round2(summary.absent);
  return { summary, days: detail };
}

@Injectable()
export class AttendanceService implements OnModuleDestroy {
  private readonly db: DatabaseSync;

  constructor() {
    const file = process.env.ATTENDANCE_DB_FILE || path.join(__dirname, '..', 'data', 'attendance.db');
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS attendances (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        employee_id INTEGER NOT NULL,
        date TEXT NOT NULL,
        check_in TEXT,
        check_out TEXT,
        note TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT 'web',
        UNIQUE (employee_id, date)
      );
      CREATE INDEX IF NOT EXISTS idx_att_date ON attendances(date);
      CREATE INDEX IF NOT EXISTS idx_att_employee_date ON attendances(employee_id, date);
    `);
  }

  onModuleDestroy() {
    this.db.close();
  }

  getAttendance(employeeId: number, date: string): AttendanceRow | undefined {
    return this.db.prepare('SELECT * FROM attendances WHERE employee_id = ? AND date = ?')
      .get(employeeId, date) as AttendanceRow | undefined;
  }

  listAttendance(filters: {
    ids?: string;
    employee_ids?: string;
    employee_id?: string;
    from?: string;
    to?: string;
  }) {
    let sql = 'SELECT * FROM attendances WHERE 1=1';
    const args: Array<string | number> = [];
    if (filters.ids) {
      const ids = parseIds(filters.ids);
      if (!ids.length) return [];
      sql += ` AND id IN (${ids.map(() => '?').join(',')})`;
      args.push(...ids);
    }
    if (filters.employee_id) {
      sql += ' AND employee_id = ?';
      args.push(positiveId(filters.employee_id));
    }
    if (filters.employee_ids) {
      const ids = parseIds(filters.employee_ids);
      if (!ids.length) return [];
      sql += ` AND employee_id IN (${ids.map(() => '?').join(',')})`;
      args.push(...ids);
    }
    if (Boolean(filters.from) !== Boolean(filters.to)
      || (filters.from && !validDate(filters.from)) || (filters.to && !validDate(filters.to))
      || (filters.from && filters.to && filters.from > filters.to)) {
      throw new BadRequestException('Attendance date range is invalid');
    }
    if (filters.from && filters.to) {
      sql += ' AND date BETWEEN ? AND ?';
      args.push(filters.from, filters.to);
    }
    return this.db.prepare(`${sql} ORDER BY date, employee_id`).all(...args) as unknown as AttendanceRow[];
  }

  hasEmployeeAttendance(employeeId: number) {
    return Boolean(this.db.prepare('SELECT 1 FROM attendances WHERE employee_id = ? LIMIT 1').get(employeeId));
  }

  upsertAttendance(input: AttendanceInput) {
    const record = this.validateAttendance(input);
    this.db.prepare(`INSERT INTO attendances(employee_id, date, check_in, check_out, note, source)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(employee_id, date) DO UPDATE SET check_in = excluded.check_in,
        check_out = excluded.check_out, note = excluded.note, source = excluded.source`)
      .run(record.employee_id, record.date, record.check_in, record.check_out, record.note, record.source);
    return { ok: true, attendance: this.getAttendance(record.employee_id, record.date) };
  }

  deleteAttendance(employeeId: number, date: string) {
    if (!validDate(date)) throw new BadRequestException('Attendance date is invalid');
    this.db.prepare('DELETE FROM attendances WHERE employee_id = ? AND date = ?').run(employeeId, date);
    return { ok: true };
  }

  importAttendance(records: AttendanceInput[]) {
    if (!Array.isArray(records) || records.length > 5000) {
      throw new BadRequestException('At most 5000 attendance records can be imported at once');
    }
    const validated = records.map((record) => this.validateAttendance({ ...record, source: 'import' }));
    const upsert = this.db.prepare(`INSERT INTO attendances(employee_id, date, check_in, check_out, note, source)
      VALUES (?, ?, ?, ?, ?, 'import')
      ON CONFLICT(employee_id, date) DO UPDATE SET check_in = excluded.check_in,
        check_out = excluded.check_out, source = 'import'`);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      validated.forEach((record) => upsert.run(
        record.employee_id, record.date, record.check_in, record.check_out, record.note,
      ));
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { imported: validated.length };
  }

  async summarizeBatch(input: {
    month?: string;
    employees?: EmployeeForSummary[];
  }) {
    const month = String(input?.month || '');
    const { from, to } = monthRange(month);
    const employees = input?.employees || [];
    if (!Array.isArray(employees) || employees.length > 100) {
      throw new BadRequestException('Summary batch must contain at most 100 employees');
    }
    const normalized = employees.map((employee) => ({
      id: positiveId(employee?.id),
      start_date: typeof employee.start_date === 'string' ? employee.start_date : '',
    }));
    if (!normalized.length) return [];

    const ids = [...new Set(normalized.map((employee) => employee.id))];
    if (ids.length > 100) throw new BadRequestException('Summary batch must contain at most 100 unique employees');
    const leaveUrl = process.env.LEAVE_SERVICE_URL || 'http://127.0.0.1:3004';
    const configUrl = process.env.CONFIG_SERVICE_URL || 'http://127.0.0.1:3300';
    const query = new URLSearchParams({ ids: ids.join(','), from, to });
    const [settingsResult, holidayResult, leaveResult] = await Promise.all([
      callService('/internal/v1/settings', {
        baseUrl: configUrl,
        timeoutEnv: 'CONFIG_SERVICE_TIMEOUT_MS',
        serviceName: 'Config Service',
        passThrough4xx: true,
      }),
      callService(`/internal/v1/holidays?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, {
        baseUrl: configUrl,
        timeoutEnv: 'CONFIG_SERVICE_TIMEOUT_MS',
        serviceName: 'Config Service',
        passThrough4xx: true,
      }),
      callService(`/internal/v1/leave/approved?${query}`, {
        baseUrl: leaveUrl,
        timeoutEnv: 'LEAVE_SERVICE_TIMEOUT_MS',
        serviceName: 'Leave Service',
        passThrough4xx: true,
      }),
    ]);
    if (!settingsResult || typeof settingsResult !== 'object' || Array.isArray(settingsResult)) {
      throw new Error('Config Service returned invalid attendance settings');
    }
    if (!Array.isArray(holidayResult) || !Array.isArray(leaveResult)) {
      throw new Error('Attendance summary dependency returned invalid data');
    }
    const settings = settingsResult as Record<string, string>;
    const holidayDates = new Set((holidayResult as Array<{ date: string }>).map((holiday) => holiday.date));
    const approvedLeaves = leaveResult as ApprovedLeave[];
    const attendanceByEmployee = new Map<number, AttendanceRow[]>();
    const attendanceRows = this.db.prepare(
      `SELECT * FROM attendances WHERE employee_id IN (${ids.map(() => '?').join(',')}) AND date BETWEEN ? AND ?`,
    ).all(...ids, from, to) as unknown as AttendanceRow[];
    attendanceRows.forEach((row) => {
      const records = attendanceByEmployee.get(row.employee_id) || [];
      records.push(row);
      attendanceByEmployee.set(row.employee_id, records);
    });
    return normalized.map((employee) => ({
      employee_id: employee.id,
      ...summarizeEmployee(
        employee,
        month,
        settings,
        holidayDates,
        attendanceByEmployee.get(employee.id) || [],
        approvedLeaves,
      ),
    }));
  }

  migrateLegacy(input: { records?: AttendanceInput[] }) {
    const records = input?.records || [];
    if (!Array.isArray(records) || records.length > 500) {
      throw new BadRequestException('Migration batch must contain at most 500 records');
    }
    const validated = records.map((record) => {
      if (!Number.isSafeInteger(Number(record.id)) || Number(record.id) < 1) {
        throw new BadRequestException('Legacy attendance ID is invalid');
      }
      return this.validateAttendance(record);
    });
    const insert = this.db.prepare(`INSERT OR IGNORE INTO attendances
      (id, employee_id, date, check_in, check_out, note, source) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      validated.forEach((record, index) => insert.run(
        Number(records[index].id), record.employee_id, record.date, record.check_in, record.check_out,
        record.note, record.source,
      ));
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { migrated_records: records.length };
  }

  private validateAttendance(input: AttendanceInput): ValidatedAttendance {
    const employeeId = positiveId(input?.employee_id);
    const date = String(input?.date || '');
    const checkIn = input?.check_in == null ? null : String(input.check_in);
    const checkOut = input?.check_out == null ? null : String(input.check_out);
    const note = String(input?.note || '').slice(0, 200);
    const source = String(input?.source || 'web');
    if (!validDate(date)) throw new BadRequestException('Attendance date is invalid');
    if ((checkIn && !validTime(checkIn)) || (checkOut && !validTime(checkOut))) {
      throw new BadRequestException('Attendance time is invalid');
    }
    if (checkOut && !checkIn) throw new BadRequestException('Check-out requires check-in');
    if (checkIn && checkOut && checkOut < checkIn) throw new BadRequestException('Check-out must be later than check-in');
    if (!['web', 'manual', 'import'].includes(source)) throw new BadRequestException('Attendance source is invalid');
    return {
      employee_id: employeeId,
      date,
      check_in: checkIn,
      check_out: checkOut,
      note,
      source,
    };
  }
}

@Controller()
class AttendanceController {
  constructor(private readonly attendance: AttendanceService) {}

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
    return { status: 'ok', service: 'hrm-attendance-service' };
  }

  @Get('/internal/v1/attendance/exists')
  hasEmployeeAttendance(@Headers('x-internal-service-token') token: string | undefined, @Query('employee_id') employeeId: string) {
    this.authorize(token);
    return { exists: this.attendance.hasEmployeeAttendance(positiveId(employeeId)) };
  }

  @Get('/internal/v1/attendance/by-date')
  getAttendance(@Headers('x-internal-service-token') token: string | undefined, @Query('employee_id') employeeId: string,
    @Query('date') date: string) {
    this.authorize(token);
    if (!validDate(date)) throw new BadRequestException('Attendance date is invalid');
    return this.attendance.getAttendance(positiveId(employeeId), date) || null;
  }

  @Get('/internal/v1/attendance')
  listAttendance(@Headers('x-internal-service-token') token: string | undefined, @Query() query: {
    ids?: string; employee_ids?: string; employee_id?: string; from?: string; to?: string;
  }) {
    this.authorize(token);
    return this.attendance.listAttendance(query);
  }

  @Post('/internal/v1/attendance')
  upsertAttendance(@Headers('x-internal-service-token') token: string | undefined, @Body() body: AttendanceInput) {
    this.authorize(token);
    return this.attendance.upsertAttendance(body);
  }

  @Delete('/internal/v1/attendance')
  deleteAttendance(@Headers('x-internal-service-token') token: string | undefined,
    @Query('employee_id') employeeId: string, @Query('date') date: string) {
    this.authorize(token);
    return this.attendance.deleteAttendance(positiveId(employeeId), date);
  }

  @Post('/internal/v1/attendance/import')
  importAttendance(@Headers('x-internal-service-token') token: string | undefined, @Body() body: { records?: AttendanceInput[] }) {
    this.authorize(token);
    return this.attendance.importAttendance(body?.records || []);
  }

  @Post('/internal/v1/summary/batch')
  summarizeBatch(@Headers('x-internal-service-token') token: string | undefined,
    @Body() body: { month?: string; employees?: EmployeeForSummary[] }) {
    this.authorize(token);
    return this.attendance.summarizeBatch(body);
  }

  @Post('/internal/v1/migrate')
  migrateLegacy(@Headers('x-internal-service-token') token: string | undefined, @Body() body: { records?: AttendanceInput[] }) {
    this.authorize(token);
    return this.attendance.migrateLegacy(body);
  }
}

@Module({
  controllers: [AttendanceController],
  providers: [AttendanceService],
})
export class AttendanceServiceModule {}
