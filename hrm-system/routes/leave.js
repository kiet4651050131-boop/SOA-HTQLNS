const router = require('express').Router();
const { audit, notifyUser } = require('../db');
const { auth, wrap } = require('../middleware');
const L = require('../lib');
const { notifyWorkflowEmail } = require('../mailer');
const { usersByRoles, userByEmail } = require('../identity-client');
const { employeeById, employeeQuery, employeesByIds } = require('../employee-client');
const {
  requestsForEmployees, leaveTypes, leaveBalance, hasOverlappingLeave,
  createLeaveRequest, leaveRequestById, updateLeaveRequest,
} = require('../leave-client');
const { hasLockedPayrollInRange } = require('../payroll-client');

router.use(auth);

const PENDING = ['Chờ quản lý', 'Chờ HR'];
const ACTIVE = ['Chờ quản lý', 'Chờ HR', 'Đã duyệt'];

async function canDecide(u, r) {
  if (r.email === u.email || !PENDING.includes(r.status)) return false;
  if (L.isHr(u)) return true;
  if (u.role === 'manager' && r.status === 'Chờ quản lý') {
    const m = await L.meEmp(u);
    return !!m && !!m.department_id && m.department_id === r.department_id;
  }
  return false;
}
function canCancel(u, r) {
  if (L.isHr(u)) return ACTIVE.includes(r.status);
  return r.email === u.email && PENDING.includes(r.status);
}
async function managersForEmployee(emp) {
  if (!emp.department_id) return [];
  const managers = await usersByRoles(['manager']);
  const employees = await employeeQuery({ emails: managers.map((manager) => manager.email).join(',') });
  const byEmail = new Map(employees.map((employee) => [employee.email, employee]));
  return managers.filter((manager) => {
    const employee = byEmail.get(manager.email);
    return employee && employee.department_id === emp.department_id && employee.id !== emp.id;
  });
}

async function enrichRequests(rows) {
  const employees = await employeesByIds(rows.map((row) => row.employee_id));
  const byId = new Map(employees.map((employee) => [employee.id, employee]));
  return rows.flatMap((row) => {
    const employee = byId.get(row.employee_id);
    return employee ? [{ ...row, code: employee.code, name: employee.name, email: employee.email,
      department_id: employee.department_id, department: employee.department }] : [];
  });
}

const notifyHr = (users, title, message) => {
  users.forEach((user) => notifyUser(user.id, title, message, '/leave'));
  notifyWorkflowEmail(users.map((user) => user.email), title, `${message}\nĐăng nhập hệ thống để xử lý đơn nghỉ.`);
};

router.get('/types', wrap(async (_req, res) => res.json(await leaveTypes())));

router.get('/balance', wrap(async (req, res) => {
  let e = await L.meEmp(req.user);
  if (req.query.employee_id && L.isHr(req.user)) e = await employeeById(req.query.employee_id);
  if (!e) return res.status(404).json({ error: 'Không tìm thấy hồ sơ nhân viên' });
  res.json(await leaveBalance(e.id, req.query.year || L.today().slice(0, 4),
    Number(L.getSettings().annual_leave_days)));
}));

router.get('/', wrap(async (req, res) => {
  const scopedEmployees = await L.employeesInScope(req.user);
  if (!scopedEmployees.length) return res.json([]);
  const ids = scopedEmployees.map((employee) => employee.id);
  const rows = await enrichRequests(await requestsForEmployees(ids, req.query.status));
  const results = await Promise.all(rows.map(async (row) => ({
    ...row, email: undefined, can_decide: await canDecide(req.user, row), can_cancel: canCancel(req.user, row),
  })));
  res.json(results);
}));

router.post('/', wrap(async (req, res) => {
  const e = await L.meEmp(req.user);
  if (!e) return res.status(404).json({ error: 'Tài khoản chưa có hồ sơ nhân viên' });
  if (e.status === 'Nghỉ việc') return res.status(403).json({ error: 'Hồ sơ đã ở trạng thái nghỉ việc' });
  const b = req.body || {};
  const type = (await leaveTypes()).find((item) => item.id === Number(b.type_id));
  if (!type) return res.status(400).json({ error: 'Vui lòng chọn loại nghỉ' });
  const from = String(b.from_date || ''), to = String(b.to_date || b.from_date || '');
  if (!L.validDate(from) || !L.validDate(to)) return res.status(400).json({ error: 'Ngày nghỉ không hợp lệ' });
  if (to < from) return res.status(400).json({ error: 'Ngày kết thúc phải sau hoặc bằng ngày bắt đầu' });
  if (b.half && from !== to) return res.status(400).json({ error: 'Nghỉ nửa ngày chỉ áp dụng cho một ngày' });
  if (from.slice(0, 4) !== to.slice(0, 4)) return res.status(400).json({ error: 'Đơn nghỉ không được vắt qua năm, vui lòng tách thành hai đơn' });
  if (await hasLockedPayrollInRange(from, to)) return res.status(409).json({ error: 'Khoảng nghỉ có ngày thuộc kỳ lương đã chốt, không thể tạo hoặc thay đổi đơn' });
  if (to > L.fmtDate(new Date(new Date().getFullYear() + 1, 11, 31))) return res.status(400).json({ error: 'Ngày nghỉ quá xa' });
  const half = b.half && from === to ? 1 : 0;
  const st = L.getSettings();
  const days = L.workdays(from, to, st, L.holidays(from, to)).length * (half ? 0.5 : 1);
  if (days === 0) return res.status(400).json({ error: 'Khoảng thời gian này không có ngày làm việc (cuối tuần hoặc ngày lễ)' });
  if (await hasOverlappingLeave(e.id, from, to)) {
    return res.status(400).json({ error: 'Bạn đã có đơn nghỉ trùng thời gian này' });
  }
  if (type.uses_quota) {
    const bal = await leaveBalance(e.id, from.slice(0, 4), Number(st.annual_leave_days));
    if (days > bal.remaining) return res.status(400).json({ error: `Số ngày phép còn lại năm ${bal.year} là ${bal.remaining}, không đủ cho đơn ${days} ngày` });
  }
  const managers = req.user.role === 'employee' ? await managersForEmployee(e) : [];
  const status = managers.length ? 'Chờ quản lý' : 'Chờ HR';
  const hrUsers = status === 'Chờ HR' ? await usersByRoles(['admin', 'hr']) : [];
  const result = await createLeaveRequest({
    employee_id: e.id, type_id: type.id, from_date: from, to_date: to, half, days,
    reason: String(b.reason || '').slice(0, 500), status,
  });
  audit(req.user, `Tạo đơn nghỉ #${result.id} (${type.name}, ${from} → ${to}, ${days} ngày)`);
  if (status === 'Chờ quản lý') {
    const message = `${e.name} gửi đơn ${type.name} từ ${from} đến ${to}.`;
    managers.forEach((user) => notifyUser(user.id, 'Đơn nghỉ cần duyệt', message, '/leave'));
    notifyWorkflowEmail(managers.map((user) => user.email), 'Đơn nghỉ cần duyệt', `${message}\nĐăng nhập hệ thống để xử lý đơn nghỉ.`);
  } else notifyHr(hrUsers, 'Đơn nghỉ cần xử lý', `${e.name} gửi đơn ${type.name} từ ${from} đến ${to}.`);
  res.status(201).json({ id: result.id, status, days });
}));

async function find(id) {
  const row = await leaveRequestById(id);
  if (!row) return null;
  return (await enrichRequests([row]))[0] || null;
}

router.put('/:id/decide', wrap(async (req, res) => {
  const r = await find(req.params.id);
  if (!r) return res.status(404).json({ error: 'Không tìm thấy đơn' });
  if (!await canDecide(req.user, r)) return res.status(403).json({ error: 'Bạn không có quyền xử lý đơn này ở bước hiện tại' });
  if (await hasLockedPayrollInRange(r.from_date, r.to_date)) return res.status(409).json({ error: 'Đơn có ngày thuộc kỳ lương đã chốt, không thể duyệt hoặc từ chối' });
  const note = String((req.body || {}).note || '').slice(0, 300);
  let status;
  if (req.body && req.body.action === 'reject') status = 'Từ chối';
  else if (req.body && req.body.action === 'approve') status = r.status === 'Chờ quản lý' && !L.isHr(req.user) ? 'Chờ HR' : 'Đã duyệt';
  else return res.status(400).json({ error: 'Hành động không hợp lệ' });
  const owner = await userByEmail(r.email);
  const hrUsers = status === 'Chờ HR' ? await usersByRoles(['admin', 'hr']) : [];
  await updateLeaveRequest(r.id, { status, manager_note: note, decided_by: req.user.email });
  audit(req.user, `Đơn nghỉ #${r.id} của ${r.code}: ${r.status} → ${status}`);
  if (status === 'Chờ HR') {
    notifyHr(hrUsers, 'Đơn nghỉ cần HR xác nhận', `${r.name}: ${r.type}, ${r.from_date} đến ${r.to_date} đã được quản lý duyệt.`);
    if (owner) notifyUser(owner.id, 'Đơn nghỉ đã qua bước quản lý', `Đơn nghỉ ${r.from_date} đến ${r.to_date} đang chờ HR xác nhận.`, '/leave');
  } else if (owner) {
    const message = `${r.type}, ${r.from_date} đến ${r.to_date}${note ? ` · ${note}` : ''}`;
    notifyUser(owner.id, `Đơn nghỉ ${status.toLowerCase()}`, message, '/leave');
    notifyWorkflowEmail([r.email], `Đơn nghỉ ${status.toLowerCase()}`, `${message}\nĐăng nhập hệ thống để xem kết quả.`);
  }
  res.json({ ok: true, status });
}));

router.put('/:id/cancel', wrap(async (req, res) => {
  const r = await find(req.params.id);
  if (!r) return res.status(404).json({ error: 'Không tìm thấy đơn' });
  if (!canCancel(req.user, r)) return res.status(403).json({ error: 'Không thể hủy đơn này' });
  if (await hasLockedPayrollInRange(r.from_date, r.to_date)) return res.status(409).json({ error: 'Đơn có ngày thuộc kỳ lương đã chốt, không thể hủy' });
  const owner = L.isHr(req.user) && r.email !== req.user.email ? await userByEmail(r.email) : null;
  await updateLeaveRequest(r.id, { status: 'Đã hủy', decided_by: req.user.email });
  audit(req.user, `Hủy đơn nghỉ #${r.id} của ${r.code}`);
  if (owner) notifyUser(owner.id, 'Đơn nghỉ đã bị hủy', `Đơn từ ${r.from_date} đến ${r.to_date} đã được HR hủy.`, '/leave');
  res.json({ ok: true });
}));

module.exports = router;
