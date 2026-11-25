const router = require('express').Router();
const { auth, wrap } = require('../middleware');
const { employeeHistory } = require('../employee-client');

router.use(auth);

router.get('/', wrap(async (req, res) => {
  const requestedId = req.query.employee_id ? Number(req.query.employee_id) : null;
  if (requestedId && !Number.isInteger(requestedId)) return res.status(400).json({ error: 'Mã nhân viên không hợp lệ' });
  res.json(await employeeHistory(requestedId, req.user));
}));

module.exports = router;
