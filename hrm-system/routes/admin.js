const router = require('express').Router();
const { audit } = require('../db');
const { auth, need, wrap, EMAIL_RE } = require('../middleware');
const { callService } = require('../service-client');
const { callIdentityService } = require('../identity-client');

router.use(auth);

const ROLES = ['admin', 'hr', 'manager', 'employee'];

// ----- Tài khoản (chỉ Admin) -----
router.get('/users', need('admin'), wrap(async (_req, res) => {
  const users = await callIdentityService('/internal/v1/users');
  res.json(users.map(({ id, email, name, role, created_at }) => ({ id, email, name, role, created_at })));
}));

// Admin tạo được mọi vai trò; HR chỉ tạo tài khoản Nhân viên.
router.post('/users', need('admin', 'hr'), wrap(async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  const email = String(b.email || '').trim().toLowerCase();
  const role = b.role || 'employee';
  const password = b.password == null || b.password === '' ? undefined : String(b.password);
  if (!name) return res.status(400).json({ error: 'Vui lòng nhập họ tên' });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Email không hợp lệ' });
  if (!ROLES.includes(role)) return res.status(400).json({ error: 'Vai trò không hợp lệ' });
  if (req.user.role === 'hr' && role !== 'employee') return res.status(403).json({ error: 'HR chỉ được tạo tài khoản Nhân viên' });
  if (password !== undefined && password.length < 8) return res.status(400).json({ error: 'Mật khẩu tối thiểu 8 ký tự' });
  const result = await callIdentityService('/internal/v1/users', {
    method: 'POST',
    body: { name, email, role, ...(password ? { password } : {}) },
  });
  audit(req.user, `Tạo tài khoản ${email} (${role})`);
  res.status(201).json(result);
}));

router.put('/users/:id/role', need('admin'), wrap(async (req, res) => {
  if (Number(req.params.id) === req.user.id) return res.status(400).json({ error: 'Không thể đổi vai trò của chính mình' });
  const role = (req.body || {}).role;
  if (!ROLES.includes(role)) return res.status(400).json({ error: 'Vai trò không hợp lệ' });
  const result = await callIdentityService(`/internal/v1/users/${encodeURIComponent(req.params.id)}/role`, {
    method: 'PUT',
    body: { role },
  });
  audit(req.user, `Đổi vai trò ${result.user_email} thành ${role}`);
  res.json({ ok: true });
}));

// Đặt lại mật khẩu: sinh mật khẩu tạm ngẫu nhiên, trả về cho Admin chuyển cho nhân viên
router.post('/users/:id/reset-password', need('admin'), wrap(async (req, res) => {
  if (Number(req.params.id) === req.user.id) return res.status(400).json({ error: 'Hãy dùng chức năng đổi mật khẩu' });
  const { temporaryPassword, user_email } = await callIdentityService(
    `/internal/v1/users/${encodeURIComponent(req.params.id)}/reset-password`,
    { method: 'POST' },
  );
  audit(req.user, `Đặt lại mật khẩu ${user_email}`);
  res.json({ temporaryPassword });
}));

router.delete('/users/:id', need('admin'), wrap(async (req, res) => {
  if (Number(req.params.id) === req.user.id) return res.status(400).json({ error: 'Không thể xóa chính mình' });
  const result = await callIdentityService(`/internal/v1/users/${encodeURIComponent(req.params.id)}`, { method: 'DELETE' });
  audit(req.user, `Xóa tài khoản ${result.user_email}`);
  res.json({ ok: true });
}));

// ----- Nhật ký thao tác (Admin, HR) -----
router.get('/logs', need('admin', 'hr'), wrap(async (_req, res) =>
  res.json(await callService('/internal/v1/audit?limit=300'))));

module.exports = router;
