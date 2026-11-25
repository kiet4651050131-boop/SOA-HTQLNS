const router = require('express').Router();
const { audit, notifyUser } = require('../db');
const { auth, need, wrap } = require('../middleware');
const L = require('../lib');
const { notifyWorkflowEmail } = require('../mailer');
const { usersByRoles, usersByEmails, userByEmail } = require('../identity-client');
const { employeeById, employeeQuery, employeesByIds, recordEmployeeHistory } = require('../employee-client');
const {
  payrollSalaries,
  upsertPayrollSalary,
  payrollPeriods,
  payrollPeriod,
  createPayrollPeriod,
  payrollPayslips,
  payrollAdjustments,
  createPayrollAdjustment,
  deletePayrollAdjustment,
  payrollAdvances,
  payrollAdvance,
  createPayrollAdvance,
  decidePayrollAdvance,
  payrollAdvanceSummary,
  calculatePayrollPeriod,
  lockPayrollPeriod,
  unlockPayrollPeriod,
  deletePayrollPeriod,
} = require('../payroll-client');

router.use(auth);

const HR = need('admin', 'hr');
const period = (id) => payrollPeriod(id);

/* ----- Thiết lập lương từng nhân viên (chỉ Admin/HR) ----- */
router.get('/salary', HR, wrap(async (_req, res) => {
  const [employees, salaries] = await Promise.all([employeeQuery(), payrollSalaries()]);
  const byEmployee = new Map(salaries.map((salary) => [salary.employee_id, salary]));
  res.json(employees.map((employee) => {
    const salary = byEmployee.get(employee.id);
    return {
      employee_id: employee.id, code: employee.code, name: employee.name, status: employee.status,
      department: employee.department, base_salary: salary ? salary.base_salary : 0,
      allowance: salary ? salary.allowance : 0, exempt_allowance: salary ? salary.exempt_allowance : 0,
      dependents: salary ? salary.dependents : 0, insured: salary ? salary.insured : 1,
      insured_salary: salary ? salary.insured_salary : 0, configured: salary ? 1 : 0,
    };
  }));
}));

const money = (value) => (Number.isInteger(Number(value)) && Number(value) >= 0 && Number(value) <= 10 ** 10 ? Number(value) : null);
router.put('/salary/:employeeId', HR, wrap(async (req, res) => {
  const employee = await employeeById(req.params.employeeId);
  if (!employee) return res.status(404).json({ error: 'Không tìm thấy nhân viên' });
  const body = req.body || {};
  const base = money(body.base_salary);
  const allowance = money(body.allowance || 0);
  const exempt = money(body.exempt_allowance || 0);
  const insuredSalary = money(body.insured_salary || 0);
  const dependents = Number(body.dependents || 0);
  if (base === null || allowance === null || exempt === null || insuredSalary === null) {
    return res.status(400).json({ error: 'Số tiền phải là số nguyên không âm' });
  }
  if (!Number.isInteger(dependents) || dependents < 0 || dependents > 20) {
    return res.status(400).json({ error: 'Số người phụ thuộc không hợp lệ' });
  }
  if (exempt > allowance) return res.status(400).json({ error: 'Phụ cấp miễn thuế không được lớn hơn tổng phụ cấp' });
  const next = {
    base_salary: base, allowance, exempt_allowance: exempt, dependents,
    insured: body.insured === false || body.insured === 0 || body.insured === '0' ? 0 : 1,
    insured_salary: insuredSalary,
  };
  const { previous } = await upsertPayrollSalary(employee.id, next);
  const fields = {
    base_salary: 'Lương cơ bản', allowance: 'Phụ cấp', exempt_allowance: 'Phụ cấp miễn thuế',
    dependents: 'Người phụ thuộc', insured: 'Tham gia bảo hiểm', insured_salary: 'Mức lương đóng bảo hiểm',
  };
  const changes = {};
  Object.keys(fields).forEach((key) => {
    const oldValue = previous ? previous[key] : null;
    if (!previous || Number(oldValue) !== Number(next[key])) {
      changes[fields[key]] = { old: oldValue, new: next[key] };
    }
  });
  await recordEmployeeHistory(employee, req.user, 'salary', changes);
  audit(req.user, `Cập nhật thiết lập lương ${employee.code}`);
  res.json({ ok: true });
}));

/* ----- Kỳ lương ----- */
router.get('/periods', wrap(async (req, res) => {
  if (L.isHr(req.user)) return res.json(await payrollPeriods());
  const employee = await L.meEmp(req.user);
  if (!employee) return res.json([]);
  res.json(await payrollPeriods(employee.id));
}));

router.post('/periods', HR, wrap(async (req, res) => {
  const month = String((req.body || {}).month || '');
  if (!L.validMonth(month)) return res.status(400).json({ error: 'Tháng không hợp lệ (YYYY-MM)' });
  const result = await createPayrollPeriod(month, req.user.email);
  audit(req.user, `Tạo kỳ lương ${month}`);
  res.status(201).json({ id: result.id });
}));

// HR/Admin xem tất cả phiếu; nhân viên chỉ xem phiếu của mình khi kỳ đã chốt.
router.get('/periods/:id/payslips', wrap(async (req, res) => {
  const current = await period(req.params.id);
  if (!current) return res.status(404).json({ error: 'Không tìm thấy kỳ lương' });
  if (L.isHr(req.user)) {
    return res.json({ period: current, payslips: await payrollPayslips(current.id) });
  }
  const employee = await L.meEmp(req.user);
  if (!employee || current.status !== 'Đã chốt') return res.status(404).json({ error: 'Không tìm thấy phiếu lương' });
  res.json({
    period: { id: current.id, month: current.month, status: current.status },
    payslips: await payrollPayslips(current.id, employee.id),
  });
}));

/* ----- Thưởng / phạt / tạm ứng theo kỳ ----- */
const ADJ_TYPES = { bonus: 'Thưởng', penalty: 'Phạt', advance: 'Tạm ứng' };

router.get('/advances', wrap(async (req, res) => {
  if (L.isHr(req.user)) {
    const requests = await payrollAdvances();
    const employees = await employeesByIds(requests.map((request) => request.employee_id));
    const byId = new Map(employees.map((employee) => [employee.id, employee]));
    return res.json({
      summary: null,
      requests: requests.flatMap((request) => {
        const employee = byId.get(request.employee_id);
        return employee ? [{ ...request, code: employee.code, name: employee.name, email: employee.email }] : [];
      }),
    });
  }
  const employee = await L.meEmp(req.user);
  if (!employee) return res.status(404).json({ error: 'Không tìm thấy hồ sơ nhân viên' });
  res.json({
    summary: await payrollAdvanceSummary(employee.id, L.curMonth(), undefined, L.today()),
    requests: await payrollAdvances(employee.id),
  });
}));

router.post('/advances', wrap(async (req, res) => {
  if (!['employee', 'manager'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Chỉ nhân viên mới có thể gửi yêu cầu ứng lương' });
  }
  const employee = await L.meEmp(req.user);
  if (!employee) return res.status(404).json({ error: 'Không tìm thấy hồ sơ nhân viên' });
  if (employee.status === 'Nghỉ việc') return res.status(400).json({ error: 'Nhân viên đã nghỉ việc không thể ứng lương' });
  const amount = Number((req.body || {}).amount);
  if (!Number.isInteger(amount) || amount <= 0 || amount > 10 ** 9) {
    return res.status(400).json({ error: 'Số tiền phải là số nguyên dương' });
  }
  const note = String((req.body || {}).note || '').trim().slice(0, 200);
  if (!note) return res.status(400).json({ error: 'Vui lòng nhập lý do ứng lương' });
  const month = L.curMonth();
  const recipients = await usersByRoles(['admin', 'hr']);
  const result = await createPayrollAdvance({ employee_id: employee.id, month, amount, note, as_of: L.today() });
  audit(req.user, `Gửi yêu cầu ứng lương ${amount} cho kỳ ${month}`);
  recipients.forEach((user) => notifyUser(user.id, 'Yêu cầu ứng lương mới',
    `${employee.name} đề nghị ứng ${amount} đồng.`, '/pay'));
  res.status(201).json({ id: result.id, month: result.month, amount });
}));

router.put('/advances/:id/decision', HR, wrap(async (req, res) => {
  const body = req.body || {};
  if (!['approve', 'reject'].includes(body.action)) return res.status(400).json({ error: 'Thao tác không hợp lệ' });
  const reviewNote = String(body.note || '').trim().slice(0, 200);
  const current = await payrollAdvance(req.params.id);
  if (!current) return res.status(404).json({ error: 'Không tìm thấy yêu cầu ứng lương' });
  if (current.status !== 'Chờ duyệt') return res.status(409).json({ error: 'Yêu cầu này đã được xử lý' });
  const employee = await employeeById(current.employee_id);
  if (!employee) return res.status(404).json({ error: 'Không tìm thấy hồ sơ nhân viên' });
  const recipient = await userByEmail(employee.email);
  const result = await decidePayrollAdvance(req.params.id, {
    action: body.action,
    reviewed_by: req.user.email,
    review_note: reviewNote,
    as_of: L.today(),
  });
  if (recipient) notifyUser(recipient.id,
    body.action === 'approve' ? 'Yêu cầu ứng lương đã duyệt' : 'Yêu cầu ứng lương bị từ chối',
    body.action === 'approve'
      ? `Yêu cầu ứng ${result.request.amount} đồng đã được ghi nhận vào kỳ lương ${result.request.month}.`
      : (reviewNote || 'HR đã từ chối yêu cầu ứng lương.'),
    '/pay');
  audit(req.user, `${body.action === 'approve' ? 'Duyệt' : 'Từ chối'} ứng lương ${result.request.amount} cho ${result.request.code} kỳ ${result.request.month}`);
  res.json({ ok: true });
}));

router.get('/periods/:id/adjustments', HR, wrap(async (req, res) => {
  const current = await period(req.params.id);
  if (!current) return res.status(404).json({ error: 'Không tìm thấy kỳ lương' });
  const adjustments = await payrollAdjustments(current.id);
  const employees = await employeesByIds(adjustments.map((adjustment) => adjustment.employee_id));
  const byId = new Map(employees.map((employee) => [employee.id, employee]));
  res.json(adjustments.flatMap((adjustment) => {
    const employee = byId.get(adjustment.employee_id);
    return employee ? [{ ...adjustment, code: employee.code, name: employee.name }] : [];
  }));
}));

router.post('/periods/:id/adjustments', HR, wrap(async (req, res) => {
  const current = await period(req.params.id);
  if (!current) return res.status(404).json({ error: 'Không tìm thấy kỳ lương' });
  if (current.status !== 'Nháp') return res.status(400).json({ error: 'Kỳ lương đã chốt, không thể thêm khoản điều chỉnh' });
  const body = req.body || {};
  const employee = await employeeById(body.employee_id);
  if (!employee) return res.status(404).json({ error: 'Không tìm thấy nhân viên' });
  if (!ADJ_TYPES[body.type]) return res.status(400).json({ error: 'Loại khoản không hợp lệ (thưởng, phạt hoặc tạm ứng)' });
  const amount = Number(body.amount);
  if (!Number.isInteger(amount) || amount <= 0 || amount > 10 ** 9) {
    return res.status(400).json({ error: 'Số tiền phải là số nguyên dương' });
  }
  const note = String(body.note || '').trim().slice(0, 200);
  if (body.type !== 'advance' && !note) return res.status(400).json({ error: 'Vui lòng ghi lý do thưởng/phạt' });
  const result = await createPayrollAdjustment(current.id, {
    employee_id: employee.id, type: body.type, amount, note, created_by: req.user.email,
  });
  audit(req.user, `${ADJ_TYPES[body.type]} ${amount} cho ${employee.code} kỳ ${current.month}`);
  res.status(201).json({ id: result.id });
}));

router.delete('/periods/:id/adjustments/:adjId', HR, wrap(async (req, res) => {
  const current = await period(req.params.id);
  if (!current) return res.status(404).json({ error: 'Không tìm thấy kỳ lương' });
  if (current.status !== 'Nháp') return res.status(400).json({ error: 'Kỳ lương đã chốt, không thể xóa khoản điều chỉnh' });
  const adjustment = await deletePayrollAdjustment(current.id, req.params.adjId);
  const employee = await employeeById(adjustment.employee_id);
  if (!employee) return res.status(404).json({ error: 'Không tìm thấy nhân viên' });
  audit(req.user, `Xóa ${ADJ_TYPES[adjustment.type]} ${adjustment.amount} của ${employee.code} kỳ ${current.month}`);
  res.json({ ok: true });
}));

router.post('/periods/:id/calculate', HR, wrap(async (req, res) => {
  const current = await period(req.params.id);
  if (!current) return res.status(404).json({ error: 'Không tìm thấy kỳ lương' });
  if (current.status !== 'Nháp') return res.status(400).json({ error: 'Kỳ lương đã chốt, không thể tính lại' });
  const result = await calculatePayrollPeriod(current.id);
  audit(req.user, `Tính lương kỳ ${current.month}: ${result.count} nhân viên, bỏ qua ${result.skipped.length}`);
  res.json(result);
}));

router.post('/periods/:id/lock', HR, wrap(async (req, res) => {
  const current = await period(req.params.id);
  if (!current) return res.status(404).json({ error: 'Không tìm thấy kỳ lương' });
  if (current.status === 'Đã chốt') return res.status(400).json({ error: 'Kỳ lương đã được chốt' });
  const payslips = await payrollPayslips(current.id);
  if (!payslips.length) return res.status(400).json({ error: 'Chưa có phiếu lương, hãy bấm Tính lương trước' });
  const employeeEmails = (await employeesByIds(payslips.map((slip) => slip.employee_id))).map((employee) => employee.email);
  const employees = await usersByEmails(employeeEmails);
  await lockPayrollPeriod(current.id);
  employees.forEach((employee) => {
    notifyUser(employee.id, 'Phiếu lương đã sẵn sàng', `Phiếu lương tháng ${current.month} đã được chốt.`, '/pay');
  });
  notifyWorkflowEmail(
    employees.map((employee) => employee.email),
    'Phiếu lương đã sẵn sàng',
    `Phiếu lương tháng ${current.month} đã được chốt. Đăng nhập hệ thống để xem phiếu lương.`,
  );
  audit(req.user, `Chốt kỳ lương ${current.month}`);
  res.json({ ok: true });
}));

router.post('/periods/:id/unlock', need('admin'), wrap(async (req, res) => {
  const current = await period(req.params.id);
  if (!current) return res.status(404).json({ error: 'Không tìm thấy kỳ lương' });
  await unlockPayrollPeriod(current.id);
  audit(req.user, `Mở khóa kỳ lương ${current.month}`);
  res.json({ ok: true });
}));

router.delete('/periods/:id', HR, wrap(async (req, res) => {
  const current = await period(req.params.id);
  if (!current) return res.status(404).json({ error: 'Không tìm thấy kỳ lương' });
  await deletePayrollPeriod(current.id);
  audit(req.user, `Xóa kỳ lương ${current.month}`);
  res.json({ ok: true });
}));

// Xuất CSV (mở được bằng Excel, có BOM để không lỗi tiếng Việt)
const cell = L.csvCell;
router.get('/periods/:id/export', HR, wrap(async (req, res) => {
  const current = await period(req.params.id);
  if (!current) return res.status(404).json({ error: 'Không tìm thấy kỳ lương' });
  const head = ['Mã NV', 'Họ tên', 'Phòng ban', 'Công chuẩn', 'Công tính lương', 'Nghỉ phép có lương', 'Nghỉ không lương', 'Vắng', 'Lương cơ bản', 'Phụ cấp', 'Tăng ca (giờ)', 'Tiền tăng ca', 'Thưởng', 'Tổng thu nhập', 'Bảo hiểm', 'Người phụ thuộc', 'Thu nhập tính thuế', 'Thuế TNCN', 'Phạt', 'Tạm ứng', 'Thực nhận'];
  const rows = (await payrollPayslips(current.id))
    .map((slip) => [slip.employee_code, slip.employee_name, slip.department, slip.std_days, slip.paid_days,
      slip.paid_leave_days, slip.unpaid_leave_days, slip.absent_days, slip.base_salary, slip.allowance,
      slip.overtime_hours, slip.overtime_pay, slip.bonus, slip.gross, slip.insurance, slip.dependents,
      slip.taxable, slip.tax, slip.penalty, slip.advance, slip.net]);
  audit(req.user, `Xuất bảng lương ${current.month}`);
  res.set({
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="bang-luong-${current.month}.csv"`,
  });
  res.send('\uFEFF' + [head, ...rows].map((row) => row.map(cell).join(',')).join('\r\n'));
}));

module.exports = router;
