const router = require('express').Router();
const { callService } = require('../service-client');
const { auth, wrap } = require('../middleware');

router.use(auth);

router.get('/', wrap(async (req, res) => {
  const result = await callService(`/internal/v1/notifications?userId=${req.user.id}`);
  res.json(result);
}));

router.put('/read-all', wrap(async (req, res) => {
  await callService(`/internal/v1/notifications/read-all?userId=${req.user.id}`, { method: 'PUT' });
  res.json({ ok: true });
}));

router.put('/:id/read', wrap(async (req, res) => {
  const result = await callService(
    `/internal/v1/notifications/${encodeURIComponent(req.params.id)}/read?userId=${req.user.id}`,
    { method: 'PUT' },
  );
  if (!result.ok) return res.status(404).json({ error: 'Không tìm thấy thông báo' });
  res.json({ ok: true });
}));

module.exports = router;
