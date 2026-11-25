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

const DEFAULT_SETTINGS = {
  work_start: '08:30',
  work_saturday: '0',
  annual_leave_days: '12',
  overtime_rate: '1.5',
  bhxh_rate: '8',
  bhyt_rate: '1.5',
  bhtn_rate: '1',
  cap_bhxh: '50600000',
  cap_bhtn: '106200000',
  personal_deduction: '15500000',
  dependent_deduction: '6200000',
  tax_brackets: '10000000:5;30000000:10;60000000:20;100000000:30;*:35',
};
const SETTINGS_KEYS = new Set(Object.keys(DEFAULT_SETTINGS));
const MONEY_KEYS = new Set(['cap_bhxh', 'cap_bhtn', 'personal_deduction', 'dependent_deduction']);
const PERCENT_KEYS = new Set(['bhxh_rate', 'bhyt_rate', 'bhtn_rate']);

function validDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validateTaxBrackets(value: string) {
  const parts = value.split(';').map((part) => part.trim()).filter(Boolean);
  if (!parts.length) throw new BadRequestException('Biểu thuế trống');
  let previous = 0;
  parts.forEach((part, index) => {
    const [limit, rawRate, ...extra] = part.split(':').map((item) => item.trim());
    const rate = Number(rawRate);
    if (extra.length || !(rate >= 0 && rate <= 100)) {
      throw new BadRequestException(`Thuế suất không hợp lệ ở bậc ${index + 1}`);
    }
    if (limit === '*') {
      if (index !== parts.length - 1) throw new BadRequestException('Dấu * (bậc cuối) phải nằm cuối cùng');
      return;
    }
    const numericLimit = Number(limit);
    if (!(numericLimit > previous)) {
      throw new BadRequestException(`Mức thu nhập ở bậc ${index + 1} phải lớn hơn bậc trước`);
    }
    previous = numericLimit;
  });
  if (!parts[parts.length - 1].startsWith('*:')) {
    throw new BadRequestException('Bậc cuối phải có dạng *:thuế_suất (ví dụ *:35)');
  }
}

@Injectable()
export class ConfigService implements OnModuleDestroy {
  private readonly db: DatabaseSync;

  constructor() {
    const file = process.env.CONFIG_DB_FILE || path.join(__dirname, '..', 'data', 'config.db');
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS holidays (date TEXT PRIMARY KEY, name TEXT NOT NULL);
    `);
    const insertDefault = this.db.prepare('INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)');
    Object.entries(DEFAULT_SETTINGS).forEach(([key, value]) => insertDefault.run(key, value));
  }

  getSettings() {
    const settings: Record<string, string> = {};
    (this.db.prepare('SELECT key, value FROM settings ORDER BY key').all() as Array<{ key: string; value: string }>)
      .forEach((row) => { settings[row.key] = row.value; });
    return settings;
  }

  updateSettings(input: Record<string, unknown>) {
    const values: Array<[string, string]> = [];
    for (const [key, rawValue] of Object.entries(input || {})) {
      if (!SETTINGS_KEYS.has(key)) throw new BadRequestException(`Cấu hình không hợp lệ: ${key}`);
      const value = String(rawValue).trim();
      if (key === 'work_start' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
        throw new BadRequestException('Giờ bắt đầu làm việc không hợp lệ (HH:MM)');
      }
      if (key === 'work_saturday' && !['0', '1'].includes(value)) {
        throw new BadRequestException('Giá trị thứ Bảy không hợp lệ');
      }
      if (key === 'annual_leave_days' && !(Number(value) >= 0 && Number(value) <= 60)) {
        throw new BadRequestException('Số ngày phép năm phải từ 0 đến 60');
      }
      if (key === 'overtime_rate' && !(Number(value) >= 1 && Number(value) <= 3)) {
        throw new BadRequestException('Hệ số tăng ca phải từ 1 đến 3');
      }
      if (PERCENT_KEYS.has(key) && !(value !== '' && Number(value) >= 0 && Number(value) <= 100)) {
        throw new BadRequestException('Tỷ lệ phải từ 0 đến 100 (%)');
      }
      if (MONEY_KEYS.has(key) && !(value !== '' && Number.isInteger(Number(value)) && Number(value) >= 0)) {
        throw new BadRequestException('Số tiền phải là số nguyên không âm');
      }
      if (key === 'tax_brackets') validateTaxBrackets(value);
      values.push([key, value]);
    }
    const update = this.db.prepare(`INSERT INTO settings(key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      values.forEach(([key, value]) => update.run(key, value));
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { ok: true, settings: this.getSettings() };
  }

  listHolidays(from?: string, to?: string) {
    if (Boolean(from) !== Boolean(to)
      || (from && !validDate(from)) || (to && !validDate(to)) || (from && to && from > to)) {
      throw new BadRequestException('Khoảng ngày không hợp lệ');
    }
    if (from && to) {
      return this.db.prepare('SELECT date, name FROM holidays WHERE date BETWEEN ? AND ? ORDER BY date')
        .all(from, to);
    }
    return this.db.prepare('SELECT date, name FROM holidays ORDER BY date').all();
  }

  addHoliday(input: { date: string; name: string }) {
    const date = String(input?.date || '');
    const name = String(input?.name || '').trim();
    if (!validDate(date)) throw new BadRequestException('Ngày không hợp lệ');
    if (!name) throw new BadRequestException('Vui lòng nhập tên ngày lễ');
    if (this.db.prepare('SELECT 1 FROM holidays WHERE date = ?').get(date)) {
      throw new ConflictException('Ngày này đã có trong danh sách');
    }
    const holiday = { date, name: name.slice(0, 100) };
    this.db.prepare('INSERT INTO holidays(date, name) VALUES (?, ?)').run(holiday.date, holiday.name);
    return { ok: true, holiday };
  }

  deleteHoliday(date: string) {
    if (!this.db.prepare('SELECT 1 FROM holidays WHERE date = ?').get(date)) {
      throw new NotFoundException('Không tìm thấy');
    }
    this.db.prepare('DELETE FROM holidays WHERE date = ?').run(date);
    return { ok: true, date };
  }

  migrateLegacy(input: {
    settings?: Array<{ key: string; value: string }>;
    holidays?: Array<{ date: string; name: string }>;
  }) {
    const settings = input?.settings || [];
    const holidays = input?.holidays || [];
    if (!Array.isArray(settings) || !Array.isArray(holidays)
      || settings.length > 500 || holidays.length > 500) {
      throw new BadRequestException('Migration batch is invalid');
    }
    const writeSetting = this.db.prepare(`INSERT INTO settings(key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
    const writeHoliday = this.db.prepare(`INSERT INTO holidays(date, name) VALUES (?, ?)
      ON CONFLICT(date) DO UPDATE SET name = excluded.name`);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      settings.forEach((row) => writeSetting.run(row.key, row.value));
      holidays.forEach((row) => writeHoliday.run(row.date, row.name));
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { migrated_settings: settings.length, migrated_holidays: holidays.length };
  }

  onModuleDestroy() {
    this.db.close();
  }
}

@Controller()
class ConfigController {
  constructor(private readonly configService: ConfigService) {}

  private authorize(token: string | undefined) {
    const expected = process.env.INTERNAL_SERVICE_TOKEN
      || (process.env.NODE_ENV === 'production' ? '' : 'dev-only-internal-service-token');
    const provided = token || '';
    const authorized = expected.length > 0
      && Buffer.byteLength(expected) === Buffer.byteLength(provided)
      && timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
    if (!authorized) throw new UnauthorizedException('Invalid service credentials');
  }

  @Get('/health')
  health() {
    return { status: 'ok', service: 'hrm-config-service' };
  }

  @Get('/internal/v1/settings')
  settings(@Headers('x-internal-service-token') token: string | undefined) {
    this.authorize(token);
    return this.configService.getSettings();
  }

  @Put('/internal/v1/settings')
  updateSettings(
    @Headers('x-internal-service-token') token: string | undefined,
    @Body() body: Record<string, unknown>,
  ) {
    this.authorize(token);
    return this.configService.updateSettings(body);
  }

  @Get('/internal/v1/holidays')
  holidays(
    @Headers('x-internal-service-token') token: string | undefined,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    this.authorize(token);
    return this.configService.listHolidays(from, to);
  }

  @Post('/internal/v1/holidays')
  addHoliday(
    @Headers('x-internal-service-token') token: string | undefined,
    @Body() body: { date: string; name: string },
  ) {
    this.authorize(token);
    return this.configService.addHoliday(body);
  }

  @Delete('/internal/v1/holidays/:date')
  deleteHoliday(
    @Headers('x-internal-service-token') token: string | undefined,
    @Param('date') date: string,
  ) {
    this.authorize(token);
    return this.configService.deleteHoliday(date);
  }

  @Post('/internal/v1/migrate')
  migrate(
    @Headers('x-internal-service-token') token: string | undefined,
    @Body() body: Parameters<ConfigService['migrateLegacy']>[0],
  ) {
    this.authorize(token);
    return this.configService.migrateLegacy(body);
  }
}

@Module({
  controllers: [ConfigController],
  providers: [ConfigService],
})
export class ConfigServiceModule {}
