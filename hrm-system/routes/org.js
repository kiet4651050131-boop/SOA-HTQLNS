const express = require('express');
const { audit } = require('../db');
const { auth, need, wrap } = require('../middleware');
const { callEmployeeService, organization } = require('../employee-client');

function makeRouter(table, label) {
  const servicePath = `/internal/v1/${table}`;
  const router = express.Router();
  router.use(auth);
  router.get('/', wrap(async (_req, res) => res.json(await organization(table))));
  router.post('/', need('admin', 'hr'), wrap(async (req, res) => {
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Vui lòng nhập tên' });
    const created = await callEmployeeService(servicePath, { method: 'POST', body: { name } });
    audit(req.user, `Thêm ${label.toLowerCase()} ${name}`);
    res.status(201).json(created);
  }));
  router.delete('/:id', need('admin', 'hr'), wrap(async (req, res) => {
    const rows = await organization(table);
    const existing = rows.find((row) => row.id === Number(req.params.id));
    if (!existing) return res.status(404).json({ error: 'Không tìm thấy' });
    await callEmployeeService(`${servicePath}/${encodeURIComponent(req.params.id)}`, { method: 'DELETE' });
    audit(req.user, `Xóa ${label.toLowerCase()} ${existing.name}`);
    res.json({ ok: true });
  }));
  return router;
}

module.exports = {
  departments: makeRouter('departments', 'Phòng ban'),
  positions: makeRouter('positions', 'Chức danh'),
};
