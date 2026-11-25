const router = require('express').Router();
const { audit } = require('../db');
const { auth, need, wrap } = require('../middleware');
const L = require('../lib');
const { callConfigService } = require('../config-client');
const {
  setSettingsCache,
  addHolidayCache,
  deleteHolidayCache,
} = require('../config-cache');

router.use(auth);

/* ----- Cấu hình hệ thống (Admin/HR) ----- */
const MONEY = ['cap_bhxh', 'cap_bhtn', 'personal_deduction', 'dependent_deduction'];
const PERCENT = ['bhxh_rate', 'bhyt_rate', 'bhtn_rate'];
const KEYS = ['work_start', 'work_saturday', 'annual_leave_days', 'overtime_rate', ...PERCENT, ...MONEY, 'tax_brackets'];

router.get('/settings', need('admin', 'hr'), wrap(async (_req, res) => {
  const settings = await callConfigService('/internal/v1/settings');
  res.json(settings);
}));

router.put('/settings', need('admin', 'hr'), wrap(async (req, res) => {
  const b = req.body || {};
  const out = {};
  for (const k of Object.keys(b)) {
    if (!KEYS.includes(k)) return res.status(400).json({ error: `Cấu hình không hợp lệ: ${k}` });
    const v = String(b[k]).trim();
    if (k === 'work_start' && !L.validTime(v)) return res.status(400).json({ error: 'Giờ bắt đầu làm việc không hợp lệ (HH:MM)' });
    if (k === 'work_saturday' && !['0', '1'].includes(v)) return res.status(400).json({ error: 'Giá trị thứ Bảy không hợp lệ' });
    if (k === 'annual_leave_days' && !(Number(v) >= 0 && Number(v) <= 60)) return res.status(400).json({ error: 'Số ngày phép năm phải từ 0 đến 60' });
    if (k === 'overtime_rate' && !(Number(v) >= 1 && Number(v) <= 3)) return res.status(400).json({ error: 'Hệ số tăng ca phải từ 1 đến 3' });
    if (PERCENT.includes(k) && !(v !== '' && Number(v) >= 0 && Number(v) <= 100)) return res.status(400).json({ error: 'Tỷ lệ phải từ 0 đến 100 (%)' });
    if (MONEY.includes(k) && !(v !== '' && Number.isInteger(Number(v)) && Number(v) >= 0)) return res.status(400).json({ error: 'Số tiền phải là số nguyên không âm' });
    if (k === 'tax_brackets') { try { L.parseBrackets(v); } catch (e) { return res.status(400).json({ error: e.message }); } }
    out[k] = v;
  }
  const result = await callConfigService('/internal/v1/settings', { method: 'PUT', body: out });
  setSettingsCache(result.settings);
  audit(req.user, `Đổi cấu hình: ${Object.keys(out).join(', ')}`);
  res.json({ ok: true });
}));

/* ----- Ngày lễ (mọi người xem được, Admin/HR chỉnh sửa) ----- */
router.get('/holidays', wrap(async (req, res) => {
  const year = req.query.year;
  if (year && (typeof year !== 'string' || !/^\d{4}$/.test(year))) {
    return res.status(400).json({ error: 'Năm không hợp lệ' });
  }
  const holidays = await callConfigService(year
    ? `/internal/v1/holidays?from=${year}-01-01&to=${year}-12-31`
    : '/internal/v1/holidays');
  res.json(year
    ? holidays
    : holidays.sort((a, b) => b.date.localeCompare(a.date)).slice(0, 200));
}));

router.post('/holidays', need('admin', 'hr'), wrap(async (req, res) => {
  const date = String(req.body.date || ''), name = String(req.body.name || '').trim();
  if (!L.validDate(date)) return res.status(400).json({ error: 'Ngày không hợp lệ' });
  if (!name) return res.status(400).json({ error: 'Vui lòng nhập tên ngày lễ' });
  const result = await callConfigService('/internal/v1/holidays', {
    method: 'POST',
    body: { date, name: name.slice(0, 100) },
  });
  addHolidayCache(result.holiday);
  audit(req.user, `Thêm ngày lễ ${date} ${name}`);
  res.status(201).json({ ok: true });
}));

router.delete('/holidays/:date', need('admin', 'hr'), wrap(async (req, res) => {
  await callConfigService(`/internal/v1/holidays/${encodeURIComponent(req.params.date)}`, { method: 'DELETE' });
  deleteHolidayCache(req.params.date);
  audit(req.user, `Xóa ngày lễ ${req.params.date}`);
  res.json({ ok: true });
}));

module.exports = router;
