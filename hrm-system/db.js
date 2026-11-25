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

function audit(user, action) {
  publishServiceEvent('/internal/v1/audit', {
    user_email: user ? user.email : '-',
    action,
  });
}

function notifyUser(userId, title, message, href) {
  publishServiceEvent('/internal/v1/notifications', {
    user_id: userId,
    title,
    message: message || '',
    href: href || '',
  });
}

module.exports = { db, audit, notifyUser };
