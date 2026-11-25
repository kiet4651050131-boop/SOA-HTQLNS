import { createHash, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import nodemailer from 'nodemailer';
import {
  BadRequestException,
  Controller,
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
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';

interface EmailMessage {
  to: string;
  subject: string;
  text?: string;
  html?: string;
}

@Injectable()
export class EmailDispatchService implements OnModuleDestroy {
  private readonly db: DatabaseSync;

  constructor() {
    const file = process.env.EMAIL_DB_FILE || path.join(__dirname, '..', 'data', 'email.db');
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS email_dispatches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        recipient_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('sent', 'failed')),
        error_code TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
      );
      CREATE INDEX IF NOT EXISTS idx_email_dispatch_created ON email_dispatches(created_at);
      CREATE TABLE IF NOT EXISTS notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        message TEXT NOT NULL DEFAULT '',
        href TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        read_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, id DESC);
      CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        user_email TEXT NOT NULL,
        action TEXT NOT NULL
      );
    `);
  }

  async dispatch(message: EmailMessage) {
    const to = String(message?.to || '').trim().toLowerCase();
    const subject = String(message?.subject || '');
    const text = typeof message?.text === 'string' ? message.text : '';
    const html = typeof message?.html === 'string' ? message.html : '';
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to) || !subject.trim() || /[\r\n]/.test(subject) || (!text && !html)) {
      throw new BadRequestException('Email message is invalid');
    }

    const host = process.env.SMTP_HOST;
    const from = process.env.SMTP_FROM;
    const port = Number(process.env.SMTP_PORT || 587);
    const secure = process.env.SMTP_SECURE === 'true' || port === 465;
    if (!host || !from || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new ServiceUnavailableException('Email service is not configured');
    }

    const auth = process.env.SMTP_USER && process.env.SMTP_PASS
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined;
    const transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000,
      ...(auth ? { auth } : {}),
    });
    const recipientHash = createHash('sha256').update(to).digest('hex');
    try {
      await transporter.sendMail({ from, to, subject, ...(text ? { text } : {}), ...(html ? { html } : {}) });
      this.db.prepare("INSERT INTO email_dispatches(recipient_hash, status) VALUES (?, 'sent')").run(recipientHash);
      return { ok: true };
    } catch (error) {
      this.db.prepare("INSERT INTO email_dispatches(recipient_hash, status, error_code) VALUES (?, 'failed', 'SMTP_DELIVERY_FAILED')")
        .run(recipientHash);
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Email delivery failed: ${message}`);
      throw new ServiceUnavailableException('Email could not be delivered');
    }
  }

  recordNotification(input: { user_id: number; title: string; message?: string; href?: string }) {
    const userId = Number(input?.user_id);
    const title = String(input?.title || '').trim();
    if (!Number.isSafeInteger(userId) || userId < 1 || !title) {
      throw new BadRequestException('Notification data is invalid');
    }
    const result = this.db.prepare(
      'INSERT INTO notifications(user_id, title, message, href) VALUES (?, ?, ?, ?)',
    ).run(userId, title, String(input.message || ''), String(input.href || ''));
    return { id: Number(result.lastInsertRowid) };
  }

  listNotifications(userId: number) {
    const notifications = this.db.prepare(`SELECT id, title, message, href, created_at, read_at
      FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 50`).all(userId);
    const unreadRow = this.db.prepare('SELECT COUNT(*) AS count FROM notifications WHERE user_id = ? AND read_at IS NULL')
      .get(userId) as { count: number } | undefined;
    if (!unreadRow) throw new Error('Notification unread count query returned no result');
    return { notifications, unread: unreadRow.count };
  }

  markAllRead(userId: number) {
    this.db.prepare(`UPDATE notifications SET read_at = datetime('now','localtime')
      WHERE user_id = ? AND read_at IS NULL`).run(userId);
    return { ok: true };
  }

  markRead(userId: number, id: number) {
    const result = this.db.prepare(`UPDATE notifications SET read_at = datetime('now','localtime')
      WHERE id = ? AND user_id = ? AND read_at IS NULL`).run(id, userId);
    if (!result.changes) {
      const exists = this.db.prepare('SELECT 1 FROM notifications WHERE id = ? AND user_id = ?').get(id, userId);
      if (!exists) return { ok: false };
    }
    return { ok: true };
  }

  recordAudit(input: { user_email: string; action: string }) {
    const userEmail = String(input?.user_email || '-').trim();
    const action = String(input?.action || '').trim();
    if (!action) throw new BadRequestException('Audit action is required');
    const result = this.db.prepare('INSERT INTO audit_logs(user_email, action) VALUES (?, ?)').run(userEmail, action);
    return { id: Number(result.lastInsertRowid) };
  }

  listAudit(limit: number) {
    return this.db.prepare('SELECT at, user_email, action FROM audit_logs ORDER BY id DESC LIMIT ?').all(limit);
  }

  migrateLegacy(input: {
    notifications?: Array<{ id: number; user_id: number; title: string; message: string; href: string; created_at: string; read_at: string | null }>;
    audit_logs?: Array<{ id: number; at: string; user_email: string; action: string }>;
  }) {
    const notifications = input?.notifications || [];
    const auditLogs = input?.audit_logs || [];
    if (!Array.isArray(notifications) || !Array.isArray(auditLogs) || notifications.length > 500 || auditLogs.length > 500) {
      throw new BadRequestException('Migration batch is invalid');
    }
    const insertNotification = this.db.prepare(`INSERT OR IGNORE INTO notifications
      (id, user_id, title, message, href, created_at, read_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    const insertAudit = this.db.prepare(`INSERT OR IGNORE INTO audit_logs
      (id, at, user_email, action) VALUES (?, ?, ?, ?)`);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      notifications.forEach((row) => insertNotification.run(
        row.id, row.user_id, row.title, row.message || '', row.href || '', row.created_at, row.read_at,
      ));
      auditLogs.forEach((row) => insertAudit.run(row.id, row.at, row.user_email, row.action));
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { migrated_notifications: notifications.length, migrated_audit_logs: auditLogs.length };
  }

  onModuleDestroy() {
    this.db.close();
  }
}

@Controller()
class EmailController {
  constructor(private readonly dispatchService: EmailDispatchService) {}

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
    return { status: 'ok', service: 'hrm-email-service' };
  }

  @Post('/internal/v1/email')
  send(
    @Headers('x-internal-service-token') token: string | undefined,
    @Body() body: EmailMessage,
  ) {
    this.authorize(token);
    return this.dispatchService.dispatch(body);
  }

  @Post('/internal/v1/notifications')
  notify(
    @Headers('x-internal-service-token') token: string | undefined,
    @Body() body: { user_id: number; title: string; message?: string; href?: string },
  ) {
    this.authorize(token);
    return this.dispatchService.recordNotification(body);
  }

  @Get('/internal/v1/notifications')
  notifications(
    @Headers('x-internal-service-token') token: string | undefined,
    @Query('userId') userId: string,
  ) {
    this.authorize(token);
    const id = Number(userId);
    if (!Number.isSafeInteger(id) || id < 1) throw new BadRequestException('userId is invalid');
    return this.dispatchService.listNotifications(id);
  }

  @Put('/internal/v1/notifications/read-all')
  readAll(
    @Headers('x-internal-service-token') token: string | undefined,
    @Query('userId') userId: string,
  ) {
    this.authorize(token);
    const id = Number(userId);
    if (!Number.isSafeInteger(id) || id < 1) throw new BadRequestException('userId is invalid');
    return this.dispatchService.markAllRead(id);
  }

  @Put('/internal/v1/notifications/:id/read')
  readOne(
    @Headers('x-internal-service-token') token: string | undefined,
    @Query('userId') userId: string,
    @Param('id') notificationId: string,
  ) {
    this.authorize(token);
    const user = Number(userId);
    const id = Number(notificationId);
    if (!Number.isSafeInteger(user) || user < 1 || !Number.isSafeInteger(id) || id < 1) {
      throw new BadRequestException('Notification id is invalid');
    }
    return this.dispatchService.markRead(user, id);
  }

  @Post('/internal/v1/audit')
  audit(
    @Headers('x-internal-service-token') token: string | undefined,
    @Body() body: { user_email: string; action: string },
  ) {
    this.authorize(token);
    return this.dispatchService.recordAudit(body);
  }

  @Get('/internal/v1/audit')
  logs(
    @Headers('x-internal-service-token') token: string | undefined,
    @Query('limit') requestedLimit?: string,
  ) {
    this.authorize(token);
    const limit = Math.min(300, Math.max(1, Number(requestedLimit || 300)));
    if (!Number.isInteger(limit)) throw new BadRequestException('limit is invalid');
    return this.dispatchService.listAudit(limit);
  }

  @Post('/internal/v1/migrate')
  migrate(
    @Headers('x-internal-service-token') token: string | undefined,
    @Body() body: Parameters<EmailDispatchService['migrateLegacy']>[0],
  ) {
    this.authorize(token);
    return this.dispatchService.migrateLegacy(body);
  }
}

@Module({
  controllers: [EmailController],
  providers: [EmailDispatchService],
})
export class EmailServiceModule {}
