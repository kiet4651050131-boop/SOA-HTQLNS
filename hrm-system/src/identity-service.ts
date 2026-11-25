import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import bcrypt from 'bcryptjs';
import fs from 'node:fs';
import path from 'node:path';
import { HttpException, HttpStatus } from '@nestjs/common';
import {
  BadRequestException,
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
  ForbiddenException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';

const jwt = require('jsonwebtoken') as {
  sign(payload: object, secret: string, options: { expiresIn: string }): string;
  verify(token: string, secret: string): string | { id?: number };
};
const ROLES = ['admin', 'hr', 'manager', 'employee'];
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const WINDOW_MS = 15 * 60 * 1000;
const RESET_TOKEN_TTL_MS = 30 * 60 * 1000;

interface IdentityUser {
  id: number;
  email: string;
  name: string;
  role: string;
  must_change_password: number;
  password_hash?: string;
  created_at?: string;
}

interface LegacyIdentityUser extends IdentityUser {
  password_hash: string;
  created_at: string;
}

interface LegacyResetToken {
  token_hash: string;
  user_id: number;
  expires_at: number;
}

function getAppUrl() {
  const appUrl = String(process.env.APP_URL || '').replace(/\/+$/, '');
  if (!appUrl) return null;
  let url: URL;
  try {
    url = new URL(appUrl);
  } catch {
    return null;
  }
  const localHost = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || (url.protocol !== 'https:' && !(url.protocol === 'http:' && localHost))) {
    return null;
  }
  return appUrl;
}

@Injectable()
export class IdentityService implements OnModuleDestroy {
  private readonly db: DatabaseSync;
  private readonly loginFailures = new Map<string, number[]>();
  private readonly resetRequests = new Map<string, number[]>();
  private readonly jwtSecret: string;

  constructor() {
    const file = process.env.IDENTITY_DB_FILE || path.join(__dirname, '..', 'data', 'identity.db');
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'employee' CHECK (role IN ('admin','hr','manager','employee')),
        must_change_password INTEGER NOT NULL DEFAULT 1 CHECK (must_change_password IN (0,1)),
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
      );
      CREATE TABLE IF NOT EXISTS password_reset_tokens (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_password_reset_user ON password_reset_tokens(user_id);
    `);

    const secret = process.env.JWT_SECRET;
    if (!secret) {
      if (process.env.NODE_ENV === 'production') throw new Error('Thiếu JWT_SECRET trong môi trường production');
      console.warn('[CẢNH BÁO] Chưa đặt JWT_SECRET, đang dùng khóa tạm cho môi trường dev.');
      this.jwtSecret = `dev-only-secret-${randomBytes(16).toString('hex')}`;
    } else {
      this.jwtSecret = secret;
    }
  }

  listUsers(query: { roles?: string; emails?: string; id?: string } = {}) {
    const conditions: string[] = [];
    const args: Array<string | number> = [];
    if (query.id) {
      const id = Number(query.id);
      if (!Number.isSafeInteger(id) || id < 1) throw new BadRequestException('User id is invalid');
      conditions.push('id = ?');
      args.push(id);
    }
    if (query.roles) {
      const roles = query.roles.split(',').map((role) => role.trim()).filter(Boolean);
      if (!roles.length || roles.some((role) => !ROLES.includes(role))) {
        throw new BadRequestException('User roles are invalid');
      }
      conditions.push(`role IN (${roles.map(() => '?').join(',')})`);
      args.push(...roles);
    }
    if (query.emails) {
      const emails = query.emails.split(',').map((email) => email.trim().toLowerCase()).filter(Boolean);
      if (!emails.length) throw new BadRequestException('User emails are invalid');
      conditions.push(`email IN (${emails.map(() => '?').join(',')})`);
      args.push(...emails);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    return this.db.prepare(`SELECT id, email, name, role, must_change_password, created_at
      FROM users ${where} ORDER BY id`).all(...args) as unknown as IdentityUser[];
  }

  private async ensureEmployee(name: string, email: string) {
    const { callService } = require('../service-client') as {
      callService: (path: string, options: Record<string, unknown>) => Promise<unknown>;
    };
    await callService('/internal/v1/employees/ensure', {
      method: 'POST',
      baseUrl: process.env.CORE_SERVICE_URL || 'http://127.0.0.1:3100',
      timeoutEnv: 'IDENTITY_SERVICE_TIMEOUT_MS',
      serviceName: 'HRM Core Service',
      body: { name, email },
    });
  }

  private async storeUser(input: {
    name: string;
    email: string;
    password: string;
    role: string;
    mustChangePassword: number;
    onlyIfFirstAdmin?: boolean;
  }) {
    const name = String(input.name || '').trim();
    const email = String(input.email || '').trim().toLowerCase();
    if (!name) throw new BadRequestException('Vui lòng nhập họ tên');
    if (!EMAIL_RE.test(email)) throw new BadRequestException('Email không hợp lệ');
    if (!ROLES.includes(input.role)) throw new BadRequestException('Vai trò không hợp lệ');
    if (String(input.password).length < 8) throw new BadRequestException('Mật khẩu tối thiểu 8 ký tự');
    const passwordHash = await bcrypt.hash(input.password, 10);
    let id: number;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const count = this.db.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number };
      if (input.onlyIfFirstAdmin && count.count > 0) {
        this.db.exec('ROLLBACK');
        throw new ForbiddenException('Đăng ký tự do đã đóng. Vui lòng liên hệ Admin hoặc HR để được cấp tài khoản.');
      }
      if (this.db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
        this.db.exec('ROLLBACK');
        throw new ConflictException('Email đã có tài khoản');
      }
      const result = this.db.prepare(`INSERT INTO users
        (email, name, password_hash, role, must_change_password) VALUES (?, ?, ?, ?, ?)`)
        .run(email, name, passwordHash, input.role, input.mustChangePassword);
      id = Number(result.lastInsertRowid);
      this.db.exec('COMMIT');
    } catch (error) {
      if (!(error instanceof ForbiddenException) && !(error instanceof ConflictException)) {
        this.db.exec('ROLLBACK');
      }
      throw error;
    }
    try {
      await this.ensureEmployee(name, email);
    } catch (error) {
      this.db.prepare('DELETE FROM users WHERE id = ?').run(id);
      throw error;
    }
    const user = this.db.prepare(`SELECT id, email, name, role, must_change_password, created_at
      FROM users WHERE id = ?`).get(id) as IdentityUser | undefined;
    if (!user) throw new Error('New Identity user could not be read');
    return user;
  }

  status() {
    const count = this.db.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number };
    return { registrationOpen: count.count === 0 };
  }

  async login(emailInput: string, passwordInput: string, ip: string) {
    const email = String(emailInput || '').trim().toLowerCase();
    const key = `${ip}|${email}`;
    const now = Date.now();
    const recent = (this.loginFailures.get(key) || []).filter((time) => now - time < WINDOW_MS);
    this.loginFailures.set(key, recent);
    if (recent.length >= 10) {
      throw new HttpException('Đăng nhập sai quá nhiều lần, vui lòng thử lại sau 15 phút', HttpStatus.TOO_MANY_REQUESTS);
    }
    const user = this.db.prepare('SELECT * FROM users WHERE email = ?').get(email) as IdentityUser | undefined;
    const valid = user && await bcrypt.compare(String(passwordInput || ''), user.password_hash || '');
    if (!valid) {
      recent.push(now);
      throw new UnauthorizedException('Sai email hoặc mật khẩu');
    }
    this.loginFailures.delete(key);
    const token = jwt.sign({ id: user.id }, this.jwtSecret, { expiresIn: '8h' });
    return {
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        must_change_password: user.must_change_password,
      },
    };
  }

  introspect(token: string) {
    let decoded: string | { id?: number };
    try {
      decoded = jwt.verify(token, this.jwtSecret);
    } catch {
      throw new UnauthorizedException('Phiên đăng nhập hết hạn');
    }
    const id = typeof decoded === 'string' ? NaN : Number(decoded.id);
    if (!Number.isSafeInteger(id) || id < 1) throw new UnauthorizedException('Phiên đăng nhập hết hạn');
    const user = this.db.prepare(`SELECT id, email, name, role, must_change_password
      FROM users WHERE id = ?`).get(id) as IdentityUser | undefined;
    if (!user) throw new UnauthorizedException('Tài khoản không còn tồn tại');
    return user;
  }

  async registerAdmin(input: { name: string; email: string; password: string }) {
    const user = await this.storeUser({
      ...input,
      role: 'admin',
      mustChangePassword: 0,
      onlyIfFirstAdmin: true,
    });
    return { ok: true, role: user.role };
  }

  async createUser(input: { name: string; email: string; role: string; password?: string }) {
    const temporaryPassword = input.password ? null : randomBytes(6).toString('base64url');
    const user = await this.storeUser({
      name: input.name,
      email: input.email,
      password: input.password || temporaryPassword!,
      role: input.role,
      mustChangePassword: 1,
    });
    return { id: user.id, ...(temporaryPassword ? { temporaryPassword } : {}) };
  }

  async changePassword(id: number, current: string, next: string) {
    const user = this.db.prepare('SELECT id, password_hash FROM users WHERE id = ?').get(id) as
      { id: number; password_hash: string } | undefined;
    if (!user) throw new UnauthorizedException('Tài khoản không còn tồn tại');
    if (!(await bcrypt.compare(String(current || ''), user.password_hash))) {
      throw new BadRequestException('Mật khẩu hiện tại không đúng');
    }
    if (String(next || '').length < 8) throw new BadRequestException('Mật khẩu mới tối thiểu 8 ký tự');
    this.db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?')
      .run(await bcrypt.hash(String(next), 10), user.id);
    return { ok: true };
  }

  async forgotPassword(emailInput: string, ip: string) {
    if (!getAppUrl()) {
      throw new ServiceUnavailableException('Chức năng email khôi phục chưa được cấu hình đầy đủ');
    }
    const email = String(emailInput || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) throw new BadRequestException('Email không hợp lệ');
    const now = Date.now();
    const recent = (this.resetRequests.get(ip) || []).filter((time) => now - time < WINDOW_MS);
    this.resetRequests.set(ip, recent);
    if (recent.length >= 5) {
      throw new HttpException('Bạn đã yêu cầu quá nhiều lần, vui lòng thử lại sau 15 phút', HttpStatus.TOO_MANY_REQUESTS);
    }
    recent.push(now);
    const user = this.db.prepare('SELECT id, name, email FROM users WHERE email = ?').get(email) as
      { id: number; name: string; email: string } | undefined;
    if (!user) {
      return { message: 'Nếu địa chỉ email thuộc một tài khoản, hướng dẫn khôi phục sẽ được gửi đến email đó.' };
    }

    const token = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const expiresAt = now + RESET_TOKEN_TTL_MS;
    this.db.prepare('DELETE FROM password_reset_tokens WHERE expires_at <= ?').run(now);
    this.db.prepare('DELETE FROM password_reset_tokens WHERE user_id = ?').run(user.id);
    this.db.prepare('INSERT INTO password_reset_tokens(token_hash, user_id, expires_at) VALUES (?, ?, ?)')
      .run(tokenHash, user.id, expiresAt);

    const appUrl = getAppUrl();
    if (!appUrl) throw new ServiceUnavailableException('Chức năng email khôi phục chưa được cấu hình đầy đủ');
    const link = `${appUrl}/?reset=${token}`;
    const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[char] as string);
    const { callService } = require('../service-client') as {
      callService: (path: string, options: Record<string, unknown>) => Promise<unknown>;
    };
    try {
      await callService('/internal/v1/email', {
        method: 'POST',
        baseUrl: process.env.EMAIL_SERVICE_URL || 'http://127.0.0.1:3200',
        timeoutEnv: 'EMAIL_SERVICE_TIMEOUT_MS',
        serviceName: 'Email Service',
        body: {
          to: user.email,
          subject: 'Khôi phục mật khẩu HRM',
          text: `Xin chào ${user.name},\n\nĐể đặt lại mật khẩu, mở liên kết sau trong vòng 30 phút:\n${link}\n\nNếu bạn không yêu cầu, hãy bỏ qua email này.`,
          html: `<p>Xin chào ${escapeHtml(user.name)},</p><p>Để đặt lại mật khẩu, hãy mở liên kết sau trong vòng 30 phút:</p><p><a href="${link}">Đặt lại mật khẩu</a></p><p>Nếu bạn không yêu cầu, hãy bỏ qua email này.</p>`,
        },
      });
    } catch (error) {
      this.db.prepare('DELETE FROM password_reset_tokens WHERE token_hash = ?').run(tokenHash);
      console.error('Không gửi được email khôi phục mật khẩu:', error instanceof Error ? error.message : String(error));
      throw new ServiceUnavailableException('Không gửi được email khôi phục. Vui lòng thử lại hoặc liên hệ Admin.');
    }
    return { message: 'Nếu địa chỉ email thuộc một tài khoản, hướng dẫn khôi phục sẽ được gửi đến email đó.' };
  }

  async resetPassword(token: string, password: string) {
    if (!/^[a-f0-9]{64}$/.test(token)) {
      throw new BadRequestException('Liên kết khôi phục không hợp lệ hoặc đã hết hạn');
    }
    if (password.length < 8) throw new BadRequestException('Mật khẩu mới tối thiểu 8 ký tự');
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const reset = this.db.prepare(`SELECT t.user_id, t.expires_at, u.email AS user_email
      FROM password_reset_tokens t JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = ?`).get(tokenHash) as
      { user_id: number; expires_at: number; user_email: string } | undefined;
    if (!reset || reset.expires_at <= Date.now()) {
      if (reset) this.db.prepare('DELETE FROM password_reset_tokens WHERE token_hash = ?').run(tokenHash);
      throw new BadRequestException('Liên kết khôi phục không hợp lệ hoặc đã hết hạn');
    }
    const passwordHash = await bcrypt.hash(password, 10);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.db.prepare('SELECT user_id, expires_at FROM password_reset_tokens WHERE token_hash = ?')
        .get(tokenHash) as { user_id: number; expires_at: number } | undefined;
      if (!current || current.expires_at <= Date.now()) {
        this.db.exec('ROLLBACK');
        throw new BadRequestException('Liên kết khôi phục không hợp lệ hoặc đã hết hạn');
      }
      this.db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?')
        .run(passwordHash, current.user_id);
      this.db.prepare('DELETE FROM password_reset_tokens WHERE user_id = ?').run(current.user_id);
      this.db.exec('COMMIT');
    } catch (error) {
      if (!(error instanceof BadRequestException)) this.db.exec('ROLLBACK');
      throw error;
    }
    return {
      ok: true,
      message: 'Đã đổi mật khẩu. Bạn có thể đăng nhập bằng mật khẩu mới.',
      user_email: reset.user_email,
    };
  }

  async resetUserPassword(id: number) {
    const user = this.db.prepare('SELECT id, email FROM users WHERE id = ?').get(id) as
      { id: number; email: string } | undefined;
    if (!user) throw new NotFoundException('Không tìm thấy tài khoản');
    const temporaryPassword = randomBytes(6).toString('base64url');
    this.db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?')
      .run(await bcrypt.hash(temporaryPassword, 10), id);
    this.db.prepare('DELETE FROM password_reset_tokens WHERE user_id = ?').run(id);
    return { temporaryPassword, user_email: user.email };
  }

  updateRole(id: number, role: string) {
    if (!ROLES.includes(role)) throw new BadRequestException('Vai trò không hợp lệ');
    const user = this.db.prepare('SELECT id, email FROM users WHERE id = ?').get(id) as
      { id: number; email: string } | undefined;
    if (!user) throw new NotFoundException('Không tìm thấy tài khoản');
    this.db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
    return { ok: true, user_email: user.email };
  }

  deleteUser(id: number) {
    const user = this.db.prepare('SELECT email FROM users WHERE id = ?').get(id) as { email: string } | undefined;
    if (!user) throw new NotFoundException('Không tìm thấy tài khoản');
    const result = this.db.prepare('DELETE FROM users WHERE id = ?').run(id);
    if (!result.changes) throw new NotFoundException('Không tìm thấy tài khoản');
    return { ok: true, user_email: user.email };
  }

  migrateLegacy(input: { users?: LegacyIdentityUser[]; password_reset_tokens?: LegacyResetToken[] }) {
    const users = input?.users || [];
    const tokens = input?.password_reset_tokens || [];
    if (!Array.isArray(users) || !Array.isArray(tokens) || users.length > 500 || tokens.length > 500) {
      throw new BadRequestException('Migration batch is invalid');
    }
    const insertUser = this.db.prepare(`INSERT OR IGNORE INTO users
      (id, email, name, password_hash, role, must_change_password, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    const insertToken = this.db.prepare(`INSERT OR IGNORE INTO password_reset_tokens
      (token_hash, user_id, expires_at) VALUES (?, ?, ?)`);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      users.forEach((user) => insertUser.run(
        user.id, user.email, user.name, user.password_hash, user.role, user.must_change_password, user.created_at,
      ));
      tokens.forEach((token) => insertToken.run(token.token_hash, token.user_id, token.expires_at));
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { migrated_users: users.length, migrated_reset_tokens: tokens.length };
  }

  onModuleDestroy() {
    this.db.close();
  }
}

@Controller()
class IdentityController {
  constructor(private readonly identityService: IdentityService) {}

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
    return { status: 'ok', service: 'hrm-identity-service' };
  }

  @Get('/internal/v1/auth/status')
  status(@Headers('x-internal-service-token') token: string | undefined) {
    this.authorize(token);
    return this.identityService.status();
  }

  @Post('/internal/v1/auth/login')
  login(
    @Headers('x-internal-service-token') token: string | undefined,
    @Body() body: { email: string; password: string; ip?: string },
  ) {
    this.authorize(token);
    return this.identityService.login(body?.email, body?.password, String(body?.ip || '-'));
  }

  @Post('/internal/v1/auth/register')
  register(
    @Headers('x-internal-service-token') token: string | undefined,
    @Body() body: { name: string; email: string; password: string },
  ) {
    this.authorize(token);
    return this.identityService.registerAdmin(body || {});
  }

  @Post('/internal/v1/auth/change-password')
  changePassword(
    @Headers('x-internal-service-token') token: string | undefined,
    @Body() body: { user_id: number; current: string; next: string },
  ) {
    this.authorize(token);
    const id = Number(body?.user_id);
    if (!Number.isSafeInteger(id) || id < 1) throw new BadRequestException('User id is invalid');
    return this.identityService.changePassword(id, body?.current, body?.next);
  }

  @Post('/internal/v1/auth/forgot-password')
  forgotPassword(
    @Headers('x-internal-service-token') token: string | undefined,
    @Body() body: { email: string; ip?: string },
  ) {
    this.authorize(token);
    return this.identityService.forgotPassword(body?.email, String(body?.ip || '-'));
  }

  @Post('/internal/v1/auth/reset-password')
  resetPassword(
    @Headers('x-internal-service-token') token: string | undefined,
    @Body() body: { token: string; password: string },
  ) {
    this.authorize(token);
    return this.identityService.resetPassword(String(body?.token || ''), String(body?.password || ''));
  }

  @Post('/internal/v1/introspect')
  introspect(
    @Headers('x-internal-service-token') token: string | undefined,
    @Body() body: { token: string },
  ) {
    this.authorize(token);
    if (!body?.token) throw new BadRequestException('Token is required');
    return this.identityService.introspect(body.token);
  }

  @Get('/internal/v1/users')
  users(
    @Headers('x-internal-service-token') token: string | undefined,
    @Query('roles') roles?: string,
    @Query('emails') emails?: string,
    @Query('id') id?: string,
  ) {
    this.authorize(token);
    return this.identityService.listUsers({ roles, emails, id });
  }

  @Post('/internal/v1/users')
  createUser(
    @Headers('x-internal-service-token') token: string | undefined,
    @Body() body: { name: string; email: string; role: string; password?: string },
  ) {
    this.authorize(token);
    return this.identityService.createUser(body || {});
  }

  @Put('/internal/v1/users/:id/role')
  updateRole(
    @Headers('x-internal-service-token') token: string | undefined,
    @Param('id') rawId: string,
    @Body() body: { role: string },
  ) {
    this.authorize(token);
    const id = Number(rawId);
    if (!Number.isSafeInteger(id) || id < 1) throw new BadRequestException('User id is invalid');
    return this.identityService.updateRole(id, body?.role);
  }

  @Post('/internal/v1/users/:id/reset-password')
  resetUserPassword(
    @Headers('x-internal-service-token') token: string | undefined,
    @Param('id') rawId: string,
  ) {
    this.authorize(token);
    const id = Number(rawId);
    if (!Number.isSafeInteger(id) || id < 1) throw new BadRequestException('User id is invalid');
    return this.identityService.resetUserPassword(id);
  }

  @Delete('/internal/v1/users/:id')
  deleteUser(
    @Headers('x-internal-service-token') token: string | undefined,
    @Param('id') rawId: string,
  ) {
    this.authorize(token);
    const id = Number(rawId);
    if (!Number.isSafeInteger(id) || id < 1) throw new BadRequestException('User id is invalid');
    return this.identityService.deleteUser(id);
  }

  @Post('/internal/v1/migrate')
  migrate(
    @Headers('x-internal-service-token') token: string | undefined,
    @Body() body: Parameters<IdentityService['migrateLegacy']>[0],
  ) {
    this.authorize(token);
    return this.identityService.migrateLegacy(body);
  }
}

@Module({
  controllers: [IdentityController],
  providers: [IdentityService],
})
export class IdentityServiceModule {}
