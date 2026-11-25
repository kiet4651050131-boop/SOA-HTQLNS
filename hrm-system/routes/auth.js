const router = require('express').Router();
const { audit } = require('../db');
const { auth, wrap, EMAIL_RE } = require('../middleware');
const { callIdentityService } = require('../identity-client');

router.get('/status', wrap(async (_req, res) => {
  res.json(await callIdentityService('/internal/v1/auth/status'));
}));

router.post('/forgot-password', wrap(async (req, res) => {
  const result = await callIdentityService('/internal/v1/auth/forgot-password', {
    method: 'POST',
    body: { email: (req.body || {}).email, ip: req.ip },
  });
  res.json(result);
}));

router.post('/reset-password', wrap(async (req, res) => {
  const result = await callIdentityService('/internal/v1/auth/reset-password', {
    method: 'POST',
    body: { token: (req.body || {}).token, password: (req.body || {}).password },
  });
  const { user_email, ...response } = result;
  audit({ email: user_email }, 'Khôi phục mật khẩu qua email');
  res.json(response);
}));

// Chỉ dùng để tạo tài khoản Admin đầu tiên. Sau đó Admin/HR tạo tài khoản ở POST /api/users
router.post('/register', wrap(async (req, res) => {
  const name = String((req.body || {}).name || '').trim();
  const email = String((req.body || {}).email || '').trim().toLowerCase();
  const password = String((req.body || {}).password || '');
  if (!name) return res.status(400).json({ error: 'Vui lòng nhập họ tên' });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Email không hợp lệ' });
  if (password.length < 8) return res.status(400).json({ error: 'Mật khẩu tối thiểu 8 ký tự' });
  const result = await callIdentityService('/internal/v1/auth/register', {
    method: 'POST',
    body: { name, email, password },
  });
  audit({ email }, 'Tạo tài khoản Admin đầu tiên');
  res.status(201).json(result);
}));

router.post('/login', wrap(async (req, res) => {
  const result = await callIdentityService('/internal/v1/auth/login', {
    method: 'POST',
    body: {
      email: (req.body || {}).email,
      password: (req.body || {}).password,
      ip: req.ip,
    },
  });
  audit(result.user, 'Đăng nhập');
  res.json(result);
}));

router.get('/me', auth, (req, res) => res.json({ user: req.user }));

router.post('/change-password', auth, wrap(async (req, res) => {
  const { current, next } = req.body || {};
  const result = await callIdentityService('/internal/v1/auth/change-password', {
    method: 'POST',
    body: { user_id: req.user.id, current, next },
  });
  audit(req.user, 'Đổi mật khẩu');
  res.json(result);
}));

module.exports = router;
