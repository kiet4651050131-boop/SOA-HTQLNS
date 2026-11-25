const { timingSafeEqual } = require('crypto');

function hasTrustedGateway(req) {
  const expected = process.env.INTERNAL_SERVICE_TOKEN
    || (process.env.NODE_ENV === 'production' ? '' : 'dev-only-internal-service-token');
  const provided = req.headers['x-internal-service-token'];
  return typeof provided === 'string' && expected.length > 0
    && Buffer.byteLength(expected) === Buffer.byteLength(provided)
    && timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
}

function auth(req, res, next) {
  if (!hasTrustedGateway(req)) return res.status(401).json({ error: 'Chưa đăng nhập' });
  const id = Number(req.headers['x-user-id']);
  const email = String(req.headers['x-user-email'] || '');
  const name = String(req.headers['x-user-name'] || '');
  const role = String(req.headers['x-user-role'] || '');
  const mustChange = Number(req.headers['x-user-must-change-password']);
  if (!Number.isSafeInteger(id) || id < 1 || !email || !name
    || !['admin', 'hr', 'manager', 'employee'].includes(role) || ![0, 1].includes(mustChange)) {
    return res.status(401).json({ error: 'Thông tin xác thực không hợp lệ' });
  }
  req.user = { id, email, name, role, must_change_password: mustChange };
  const allowedDuringPasswordChange = req.baseUrl === '/api/auth'
    && (req.path === '/me' || req.path === '/change-password');
  if (mustChange && !allowedDuringPasswordChange) {
    return res.status(403).json({
      error: 'Bạn cần đổi mật khẩu trước khi tiếp tục',
      code: 'PASSWORD_CHANGE_REQUIRED',
    });
  }
  next();
}

const need = (...roles) => (req, res, next) =>
  roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'Bạn không đủ quyền thực hiện thao tác này' });

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

module.exports = { auth, need, wrap, EMAIL_RE };
