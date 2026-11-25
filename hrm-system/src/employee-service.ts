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
  OnModuleDestroy,
  Param,
  Post,
  Body,
  Put,
  Query,
  UnauthorizedException,
  NotFoundException,
} from '@nestjs/common';

interface EmployeeInput {
  code?: string;
  name?: string;
  email?: string;
  phone?: string;
  department_id?: number | null;
  position_id?: number | null;
  status?: string;
  start_date?: string;
}

@Injectable()
export class EmployeeService implements OnModuleDestroy {
  private readonly db: DatabaseSync;

  constructor() {
    const file = process.env.EMPLOYEE_DB_FILE || path.join(__dirname, '..', 'data', 'employee.db');
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS departments (
        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE COLLATE NOCASE
      );
      CREATE TABLE IF NOT EXISTS positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE COLLATE NOCASE
      );
      CREATE TABLE IF NOT EXISTS employees (
        id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE, phone TEXT NOT NULL DEFAULT '',
        department_id INTEGER REFERENCES departments(id) ON DELETE RESTRICT,
        position_id INTEGER REFERENCES positions(id) ON DELETE RESTRICT,
        status TEXT NOT NULL DEFAULT 'Thử việc', start_date TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
      );
      CREATE TABLE IF NOT EXISTS employee_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT, employee_id INTEGER, employee_code TEXT NOT NULL,
        employee_name TEXT NOT NULL, entity TEXT NOT NULL, actor_email TEXT NOT NULL,
        changes TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
      );
      CREATE INDEX IF NOT EXISTS idx_employee_history_employee ON employee_history(employee_id, id);
    `);
  }

  private employeeQuery() {
    return `SELECT e.id, e.code, e.name, e.email, e.phone, e.department_id, e.position_id,
      e.status, e.start_date, d.name AS department, p.name AS position
      FROM employees e LEFT JOIN departments d ON d.id = e.department_id
      LEFT JOIN positions p ON p.id = e.position_id`;
  }

  listEmployees(filters: {
    email?: string; ids?: string; department_id?: string; q?: string;
    scope_email?: string; scope_role?: string;
  }) {
    let sql = `${this.employeeQuery()} WHERE 1=1`;
    const args: Array<string | number> = [];
    if (filters.email) { sql += ' AND lower(e.email) = lower(?)'; args.push(filters.email); }
    if (filters.ids) {
      const ids = filters.ids.split(',').map(Number).filter((id) => Number.isInteger(id) && id > 0);
      if (!ids.length) return [];
      sql += ` AND e.id IN (${ids.map(() => '?').join(',')})`;
      args.push(...ids);
    }
    if (filters.department_id) { sql += ' AND e.department_id = ?'; args.push(Number(filters.department_id)); }
    if (filters.q) {
      sql += ' AND (e.name LIKE ? OR e.code LIKE ? OR e.email LIKE ?)';
      const query = `%${filters.q}%`;
      args.push(query, query, query);
    }
    if (filters.scope_role && filters.scope_role !== 'admin' && filters.scope_role !== 'hr') {
      const own = this.db.prepare('SELECT id, department_id FROM employees WHERE lower(email) = lower(?)')
        .get(filters.scope_email || '') as { id: number; department_id: number | null } | undefined;
      if (!own) return [];
      if (filters.scope_role === 'manager' && own.department_id) {
        sql += ' AND (e.department_id = ? OR e.id = ?)';
        args.push(own.department_id, own.id);
      } else {
        sql += ' AND e.id = ?';
        args.push(own.id);
      }
    }
    return this.db.prepare(`${sql} ORDER BY e.code`).all(...args);
  }

  getEmployee(id: number) {
    return this.db.prepare(`${this.employeeQuery()} WHERE e.id = ?`).get(id);
  }

  async ensureEmployee(name: string, email: string) {
    const existing = this.db.prepare('SELECT id FROM employees WHERE lower(email) = lower(?)').get(email) as { id: number } | undefined;
    if (existing) return { id: existing.id, created: false };
    const code = this.nextEmployeeCode();
    const result = this.db.prepare(`INSERT INTO employees(code, name, email, status, start_date)
      VALUES (?, ?, ?, 'Chờ cập nhật', '')`).run(code, name, email);
    return { id: Number(result.lastInsertRowid), created: true };
  }

  createEmployee(input: EmployeeInput) {
    this.validateReferences(input);
    try {
      const result = this.db.prepare(`INSERT INTO employees
        (code, name, email, phone, department_id, position_id, status, start_date)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
        String(input.code || '').trim(), String(input.name || '').trim(),
        String(input.email || '').trim().toLowerCase(), String(input.phone || ''),
        input.department_id || null, input.position_id || null,
        input.status || 'Thử việc', String(input.start_date || ''),
      );
      return { id: Number(result.lastInsertRowid) };
    } catch (error) {
      if (this.isUniqueViolation(error)) throw new ConflictException('Mã hoặc email bị trùng');
      throw error;
    }
  }

  updateEmployee(id: number, input: EmployeeInput) {
    if (!this.getEmployee(id)) throw new NotFoundException('Không tìm thấy hồ sơ');
    this.validateReferences(input);
    try {
      this.db.prepare(`UPDATE employees SET code=?, name=?, email=?, phone=?, department_id=?,
        position_id=?, status=?, start_date=? WHERE id=?`).run(
        String(input.code || '').trim(), String(input.name || '').trim(),
        String(input.email || '').trim().toLowerCase(), String(input.phone || ''),
        input.department_id || null, input.position_id || null, input.status || 'Thử việc',
        String(input.start_date || ''), id,
      );
      return { ok: true };
    } catch (error) {
      if (this.isUniqueViolation(error)) throw new ConflictException('Mã hoặc email bị trùng');
      throw error;
    }
  }

  updatePhone(id: number, phone: string) {
    const result = this.db.prepare('UPDATE employees SET phone = ? WHERE id = ?').run(phone, id);
    if (!result.changes) throw new NotFoundException('Không tìm thấy hồ sơ');
    return { ok: true };
  }

  deleteEmployee(id: number) {
    const result = this.db.prepare('DELETE FROM employees WHERE id = ?').run(id);
    if (!result.changes) throw new NotFoundException('Không tìm thấy hồ sơ');
    return { ok: true };
  }

  listOrganization(table: 'departments' | 'positions') {
    return this.db.prepare(`SELECT id, name FROM ${table} ORDER BY name`).all();
  }

  createOrganization(table: 'departments' | 'positions', rawName: string) {
    const name = String(rawName || '').trim();
    if (!name) throw new BadRequestException('Vui lòng nhập tên');
    try {
      const result = this.db.prepare(`INSERT INTO ${table}(name) VALUES (?)`).run(name);
      return { id: Number(result.lastInsertRowid), name };
    } catch (error) {
      if (this.isUniqueViolation(error)) throw new ConflictException(`${table === 'departments' ? 'Phòng ban' : 'Chức danh'} đã tồn tại`);
      throw error;
    }
  }

  deleteOrganization(table: 'departments' | 'positions', id: number) {
    const row = this.db.prepare(`SELECT name FROM ${table} WHERE id = ?`).get(id);
    if (!row) throw new NotFoundException('Không tìm thấy');
    const column = table === 'departments' ? 'department_id' : 'position_id';
    if (this.db.prepare(`SELECT 1 FROM employees WHERE ${column} = ?`).get(id)) {
      throw new ConflictException('Đang có nhân viên thuộc mục này, không thể xóa');
    }
    this.db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
    return { ok: true };
  }

  addHistory(input: {
    employee_id?: number | null; employee_code?: string; employee_name?: string;
    entity: string; actor_email: string; changes: Record<string, unknown>;
  }) {
    if (!input.changes || !Object.keys(input.changes).length) return { ok: true };
    const employee = input.employee_id ? this.getEmployee(input.employee_id) as
      { code: string; name: string } | undefined : undefined;
    this.db.prepare(`INSERT INTO employee_history
      (employee_id, employee_code, employee_name, entity, actor_email, changes)
      VALUES (?, ?, ?, ?, ?, ?)`).run(
      input.employee_id || null, employee?.code || input.employee_code || '',
      employee?.name || input.employee_name || '', input.entity, input.actor_email || '-',
      JSON.stringify(input.changes),
    );
    return { ok: true };
  }

  listHistory(employeeId: number | null, scopeEmail: string, scopeRole: string) {
    let allowedIds: number[] | null = null;
    if (scopeRole !== 'admin' && scopeRole !== 'hr') {
      allowedIds = (this.listEmployees({ scope_email: scopeEmail, scope_role: scopeRole }) as Array<{ id: number }>)
        .map((employee) => employee.id);
      if (employeeId && !allowedIds.includes(employeeId)) throw new NotFoundException('Không tìm thấy lịch sử');
      if (!employeeId && !allowedIds.length) return [];
    }
    let sql = 'SELECT * FROM employee_history WHERE 1=1';
    const args: Array<number> = [];
    if (employeeId) { sql += ' AND employee_id = ?'; args.push(employeeId); }
    else if (allowedIds) {
      sql += ` AND employee_id IN (${allowedIds.map(() => '?').join(',')})`;
      args.push(...allowedIds);
    }
    if (scopeRole !== 'admin' && scopeRole !== 'hr') sql += " AND entity != 'salary'";
    return (this.db.prepare(`${sql} ORDER BY id DESC LIMIT 200`).all(...args) as Array<Record<string, unknown> & { changes: string }>)
      .map((row) => ({ ...row, changes: JSON.parse(row.changes) }));
  }

  migrateLegacy(input: {
    departments?: Array<{ id: number; name: string }>;
    positions?: Array<{ id: number; name: string }>;
    employees?: Array<{
      id: number; code: string; name: string; email: string; phone?: string;
      department_id?: number | null; position_id?: number | null; status?: string;
      start_date?: string; created_at?: string;
    }>;
    employee_history?: Array<{
      id: number; employee_id?: number | null; employee_code?: string; employee_name?: string;
      entity: string; actor_email?: string; changes: string; created_at?: string;
    }>;
  }) {
    const departments = input.departments || [];
    const positions = input.positions || [];
    const employees = input.employees || [];
    const history = input.employee_history || [];
    if ([departments, positions, employees, history].some((batch) => !Array.isArray(batch) || batch.length > 500)) {
      throw new BadRequestException('Migration batch is invalid');
    }
    const write = (table: string, fields: string[]) => this.db.prepare(
      `INSERT OR IGNORE INTO ${table}(${fields.join(',')}) VALUES (${fields.map(() => '?').join(',')})`,
    );
    const insertDepartment = write('departments', ['id', 'name']);
    const insertPosition = write('positions', ['id', 'name']);
    const insertEmployee = write('employees', ['id', 'code', 'name', 'email', 'phone', 'department_id', 'position_id', 'status', 'start_date', 'created_at']);
    const insertHistory = write('employee_history', ['id', 'employee_id', 'employee_code', 'employee_name', 'entity', 'actor_email', 'changes', 'created_at']);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      departments.forEach((row) => insertDepartment.run(row.id, row.name));
      positions.forEach((row) => insertPosition.run(row.id, row.name));
      employees.forEach((row) => insertEmployee.run(
        row.id, row.code, row.name, row.email, row.phone || '', row.department_id ?? null,
        row.position_id ?? null, row.status || 'Thử việc', row.start_date || '',
        row.created_at || new Date().toISOString(),
      ));
      history.forEach((row) => insertHistory.run(
        row.id, row.employee_id ?? null, row.employee_code || '', row.employee_name || '',
        row.entity, row.actor_email || '-', row.changes, row.created_at || new Date().toISOString(),
      ));
      if (!(this.db.prepare('SELECT COUNT(*) AS count FROM departments').get() as { count: number }).count) {
        const addDepartment = this.db.prepare('INSERT INTO departments(name) VALUES (?)');
        ['Kinh doanh', 'Kỹ thuật', 'Hành chính'].forEach((name) => addDepartment.run(name));
        const addPosition = this.db.prepare('INSERT INTO positions(name) VALUES (?)');
        ['Nhân viên', 'Trưởng nhóm', 'Giám đốc'].forEach((name) => addPosition.run(name));
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return {
      migrated_departments: departments.length, migrated_positions: positions.length,
      migrated_employees: employees.length, migrated_history: history.length,
    };
  }

  private validateReferences(input: EmployeeInput) {
    if (input.department_id && !this.db.prepare('SELECT 1 FROM departments WHERE id = ?').get(input.department_id)) {
      throw new BadRequestException('Phòng ban không tồn tại');
    }
    if (input.position_id && !this.db.prepare('SELECT 1 FROM positions WHERE id = ?').get(input.position_id)) {
      throw new BadRequestException('Chức danh không tồn tại');
    }
  }

  private nextEmployeeCode() {
    let next = (this.db.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS next FROM employees').get() as { next: number }).next;
    while (this.db.prepare('SELECT 1 FROM employees WHERE code = ?').get(`NV${String(next).padStart(3, '0')}`)) next++;
    return `NV${String(next).padStart(3, '0')}`;
  }

  private isUniqueViolation(error: unknown) {
    return error instanceof Error && error.message.includes('UNIQUE constraint failed');
  }

  onModuleDestroy() {
    this.db.close();
  }
}

@Controller()
class EmployeeController {
  constructor(private readonly employees: EmployeeService) {}

  private authorize(token: string | undefined) {
    const expected = process.env.INTERNAL_SERVICE_TOKEN
      || (process.env.NODE_ENV === 'production' ? '' : 'dev-only-internal-service-token');
    const provided = token || '';
    if (!expected || Buffer.byteLength(expected) !== Buffer.byteLength(provided)
      || !timingSafeEqual(Buffer.from(expected), Buffer.from(provided))) {
      throw new UnauthorizedException('Invalid service credentials');
    }
  }

  @Get('/health')
  health() { return { status: 'ok', service: 'hrm-employee-service' }; }

  @Get('/internal/v1/employees')
  listEmployees(@Headers('x-internal-service-token') token: string | undefined, @Query() query: {
    email?: string; ids?: string; department_id?: string; q?: string; scope_email?: string; scope_role?: string;
  }) {
    this.authorize(token);
    return this.employees.listEmployees(query);
  }

  @Get('/internal/v1/employees/:id')
  getEmployee(@Headers('x-internal-service-token') token: string | undefined, @Param('id') id: string) {
    this.authorize(token);
    const employee = this.employees.getEmployee(Number(id));
    if (!employee) throw new NotFoundException('Không tìm thấy hồ sơ');
    return employee;
  }

  @Post('/internal/v1/employees/ensure')
  ensureEmployee(@Headers('x-internal-service-token') token: string | undefined, @Body() body: { name: string; email: string }) {
    this.authorize(token);
    const name = String(body?.name || '').trim();
    const email = String(body?.email || '').trim().toLowerCase();
    if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new BadRequestException('Employee name and email are required');
    return this.employees.ensureEmployee(name, email);
  }

  @Post('/internal/v1/employees')
  createEmployee(@Headers('x-internal-service-token') token: string | undefined, @Body() body: EmployeeInput) {
    this.authorize(token);
    return this.employees.createEmployee(body);
  }

  @Put('/internal/v1/employees/:id')
  updateEmployee(@Headers('x-internal-service-token') token: string | undefined, @Param('id') id: string, @Body() body: EmployeeInput) {
    this.authorize(token);
    return this.employees.updateEmployee(Number(id), body);
  }

  @Put('/internal/v1/employees/:id/phone')
  updatePhone(@Headers('x-internal-service-token') token: string | undefined, @Param('id') id: string, @Body() body: { phone: string }) {
    this.authorize(token);
    return this.employees.updatePhone(Number(id), String(body?.phone || ''));
  }

  @Delete('/internal/v1/employees/:id')
  deleteEmployee(@Headers('x-internal-service-token') token: string | undefined, @Param('id') id: string) {
    this.authorize(token);
    return this.employees.deleteEmployee(Number(id));
  }

  @Get('/internal/v1/departments')
  departments(@Headers('x-internal-service-token') token: string | undefined) {
    this.authorize(token);
    return this.employees.listOrganization('departments');
  }

  @Get('/internal/v1/positions')
  positions(@Headers('x-internal-service-token') token: string | undefined) {
    this.authorize(token);
    return this.employees.listOrganization('positions');
  }

  @Post('/internal/v1/departments')
  createDepartment(@Headers('x-internal-service-token') token: string | undefined, @Body() body: { name: string }) {
    this.authorize(token);
    return this.employees.createOrganization('departments', body?.name);
  }

  @Post('/internal/v1/positions')
  createPosition(@Headers('x-internal-service-token') token: string | undefined, @Body() body: { name: string }) {
    this.authorize(token);
    return this.employees.createOrganization('positions', body?.name);
  }

  @Delete('/internal/v1/departments/:id')
  deleteDepartment(@Headers('x-internal-service-token') token: string | undefined, @Param('id') id: string) {
    this.authorize(token);
    return this.employees.deleteOrganization('departments', Number(id));
  }

  @Delete('/internal/v1/positions/:id')
  deletePosition(@Headers('x-internal-service-token') token: string | undefined, @Param('id') id: string) {
    this.authorize(token);
    return this.employees.deleteOrganization('positions', Number(id));
  }

  @Post('/internal/v1/history')
  addHistory(@Headers('x-internal-service-token') token: string | undefined, @Body() body: Parameters<EmployeeService['addHistory']>[0]) {
    this.authorize(token);
    return this.employees.addHistory(body);
  }

  @Get('/internal/v1/history')
  history(@Headers('x-internal-service-token') token: string | undefined, @Query('employee_id') id?: string,
    @Query('scope_email') email?: string, @Query('scope_role') role?: string) {
    this.authorize(token);
    return this.employees.listHistory(id ? Number(id) : null, email || '', role || '');
  }

  @Post('/internal/v1/migrate')
  migrate(@Headers('x-internal-service-token') token: string | undefined,
    @Body() body: Parameters<EmployeeService['migrateLegacy']>[0]) {
    this.authorize(token);
    return this.employees.migrateLegacy(body);
  }
}

@Module({ controllers: [EmployeeController], providers: [EmployeeService] })
export class EmployeeServiceModule {}
