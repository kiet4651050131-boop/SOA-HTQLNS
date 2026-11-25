const router = require('express').Router();
const { audit, notifyUser } = require('../db');
const { auth, wrap } = require('../middleware');
const L = require('../lib');
const { notifyWorkflowEmail } = require('../mailer');
const { usersByRoles, userByEmail } = require('../identity-client');
const { employeeQuery, employeesByIds } = require('../employee-client');
const {
  overtimeRequestsForEmployees, overtimeRequestById, createOvertimeRequest, updateOvertimeRequest,
} = require('../leave-client');
const { isPayrollLocked } = require('../payroll-client');

router.use(auth);

const PENDING = ['Chờ quản lý', 'Chờ HR'];
async function enrichRequests(rows) {
  const employees = await employeesByIds(rows.map((row) => row.employee_id));
  const byId = new Map(employees.map((employee) => [employee.id, employee]));
  return rows.flatMap((row) => {
    const employee = byId.get(row.employee_id);
    return employee ? [{ ...row, code: employee.code, name: employee.name, email: employee.email,
      department_id: employee.department_id, department: employee.department }] : [];
  });
}
async function getRequest(id) {
  const request = await overtimeRequestById(id);
  return request ? (await enrichRequests([request]))[0] || null : null;
}

async function canDecide(user, request) {
  if (request.email === user.email || !PENDING.includes(request.status)) return false;
  if (L.isHr(user)) return request.status === 'Chờ HR';
  if (user.role !== 'manager' || request.status !== 'Chờ quản lý') return false;
  const manager = await L.meEmp(user);
  return !!manager && !!manager.department_id && manager.department_id === request.department_id;
}

function notifyRole(users, title, message) {
  users.forEach((user) => {
    notifyUser(user.id, title, message, '/overtime');
  });
  notifyWorkflowEmail(users.map((user) => user.email), title, `${message}\nĐăng nhập hệ thống để xử lý đề nghị tăng ca.`);
}

router.get('/', wrap(async (req, res) => {
  const employees = await L.employeesInScope(req.user);
  if (!employees.length) return res.json([]);
  const ids = employees.map((employee) => employee.id);
  const rows = await enrichRequests(await overtimeRequestsForEmployees(ids));
  res.json(await Promise.all(rows.map(async (request) => ({
    ...request,
    email: undefined,
    can_decide: await canDecide(req.user, request),
    can_cancel: L.isHr(req.user) ? PENDING.includes(request.status)
      : request.email === req.user.email && PENDING.includes(request.status),
  }))));
}));

router.post('/', wrap(async (req, res) => {
  const employee = await L.meEmp(req.user);
  if (!employee) return res.status(404).json({ error: 'Tài khoản chưa có hồ sơ nhân viên' });
  if (employee.status === 'Nghỉ việc') return res.status(403).json({ error: 'Hồ sơ đã ở trạng thái nghỉ việc' });
  const date = String((req.body || {}).date || '');
  const hours = Number((req.body || {}).hours);
  const reason = String((req.body || {}).reason || '').trim().slice(0, 500);
  if (!L.validDate(date)) return res.status(400).json({ error: 'Ngày tăng ca không hợp lệ' });
  if (await isPayrollLocked(date.slice(0, 7))) return res.status(409).json({ error: `Kỳ lương tháng ${date.slice(0, 7)} đã chốt, không thể tạo đề nghị tăng ca` });
  if (!Number.isFinite(hours) || hours < 0.5 || hours > 12 || Math.round(hours * 2) !== hours * 2) {
    return res.status(400).json({ error: 'Số giờ tăng ca phải từ 0,5 đến 12 và theo bước 0,5 giờ' });
  }
  if (!reason) return res.status(400).json({ error: 'Vui lòng nêu lý do tăng ca' });

  const managers = employee.department_id
    ? await usersByRoles(['manager']).then(async (users) => {
      const employees = await employeeQuery({ emails: users.map((user) => user.email).join(',') });
      const byEmail = new Map(employees.map((item) => [item.email, item]));
      return users.filter((user) => {
        const manager = byEmail.get(user.email);
        return manager && manager.department_id === employee.department_id && manager.id !== employee.id;
      });
    })
    : [];
  const status = managers.length ? 'Chờ quản lý' : 'Chờ HR';
  const hrUsers = status === 'Chờ HR' ? await usersByRoles(['admin', 'hr']) : [];
  const result = await createOvertimeRequest({ employee_id: employee.id, date, hours, reason, status });
  audit(req.user, `Tạo đề nghị tăng ca #${result.id} (${date}, ${hours} giờ)`);

  if (managers.length) {
    const message = `${employee.name} đề nghị tăng ca ${hours} giờ ngày ${date}.`;
    managers.forEach((user) => notifyUser(user.id, 'Đề nghị tăng ca cần duyệt', message, '/overtime'));
    notifyWorkflowEmail(managers.map((user) => user.email), 'Đề nghị tăng ca cần duyệt', `${message}\nĐăng nhập hệ thống để xử lý đề nghị tăng ca.`);
  } else notifyRole(hrUsers, 'Đề nghị tăng ca cần xử lý', `${employee.name} đề nghị tăng ca ${hours} giờ ngày ${date}.`);
  res.status(201).json({ id: result.id, status });
}));

router.put('/:id/decide', wrap(async (req, res) => {
  const request = await getRequest(req.params.id);
  if (!request) return res.status(404).json({ error: 'Không tìm thấy đề nghị tăng ca' });
  if (!await canDecide(req.user, request)) return res.status(403).json({ error: 'Bạn không có quyền xử lý đề nghị này ở bước hiện tại' });
  if (await isPayrollLocked(request.date.slice(0, 7))) return res.status(409).json({ error: 'Kỳ lương tháng này đã chốt, không thể duyệt hoặc từ chối đề nghị' });
  const action = req.body && req.body.action;
  if (action !== 'approve' && action !== 'reject') return res.status(400).json({ error: 'Hành động không hợp lệ' });
  const status = action === 'reject' ? 'Từ chối'
    : request.status === 'Chờ quản lý' ? 'Chờ HR' : 'Đã duyệt';
  const note = String((req.body && req.body.note) || '').trim().slice(0, 300);
  const hrUsers = status === 'Chờ HR' ? await usersByRoles(['admin', 'hr']) : [];
  const owner = await userByEmail(request.email);
  await updateOvertimeRequest(request.id, { status, manager_note: note, decided_by: req.user.email });
  audit(req.user, `Đề nghị tăng ca #${request.id} của ${request.code}: ${request.status} → ${status}`);

  if (status === 'Chờ HR') {
    notifyRole(hrUsers, 'Đề nghị tăng ca cần xác nhận', `${request.name}: ${request.date}, ${request.hours} giờ đã được quản lý duyệt.`);
    if (owner) notifyUser(owner.id, 'Đề nghị tăng ca đã qua bước quản lý', `Đề nghị ngày ${request.date} đang chờ HR xác nhận.`, '/overtime');
  } else {
    const message = `${request.date}, ${request.hours} giờ${note ? ` · ${note}` : ''}`;
    if (owner) notifyUser(owner.id, `Đề nghị tăng ca ${status.toLowerCase()}`, message, '/overtime');
    notifyWorkflowEmail([request.email], `Đề nghị tăng ca ${status.toLowerCase()}`, `${message}\nĐăng nhập hệ thống để xem kết quả.`);
  }
  res.json({ ok: true, status });
}));

router.put('/:id/cancel', wrap(async (req, res) => {
  const request = await getRequest(req.params.id);
  if (!request) return res.status(404).json({ error: 'Không tìm thấy đề nghị tăng ca' });
  const allowed = PENDING.includes(request.status)
    && (L.isHr(req.user) || request.email === req.user.email);
  if (!allowed) return res.status(403).json({ error: 'Không thể hủy đề nghị này' });
  if (await isPayrollLocked(request.date.slice(0, 7))) return res.status(409).json({ error: 'Kỳ lương tháng này đã chốt, không thể hủy đề nghị' });
  const owner = request.email !== req.user.email ? await userByEmail(request.email) : null;
  await updateOvertimeRequest(request.id, { status: 'Đã hủy', decided_by: req.user.email });
  audit(req.user, `Hủy đề nghị tăng ca #${request.id} của ${request.code}`);
  if (owner) notifyUser(owner.id, 'Đề nghị tăng ca đã bị hủy', `Đề nghị ngày ${request.date} đã được HR hủy.`, '/overtime');
  res.json({ ok: true });
}));

module.exports = router;
