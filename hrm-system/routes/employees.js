const router = require('express').Router();
const { audit } = require('../db');
const { auth, need, EMAIL_RE, wrap } = require('../middleware');
const L = require('../lib');
const {
  callEmployeeService, employeeById, employeeQuery, organization, recordEmployeeHistory,
} = require('../employee-client');
const { hasAttendanceForEmployee } = require('../attendance-client');
const { hasLeaveOrOvertimeRequests } = require('../leave-client');
const { payrollDataForEmployee } = require('../payroll-client');

router.use(auth);

const STATUSES = ['Thử việc', 'Chính thức', 'Nghỉ việc', 'Chờ cập nhật'];
const isHr = (user) => user.role === 'admin' || user.role === 'hr';
const validPhone = (value) => {
  const phone = String(value || '').trim();
  if (!phone) return true;
  const digits = phone.replace(/\D/g, '');
  return /^[+()\d.\-\s]+$/.test(phone) && digits.length >= 7 && digits.length <= 15;
};

router.get('/export', wrap(async (req, res) => {
  if (req.user.role === 'employee') return res.status(403).json({ error: 'Bạn không đủ quyền xuất danh sách nhân viên' });
  const departmentId = req.query.department_id ? Number(req.query.department_id) : null;
  if (departmentId) {
    const departments = await organization('departments');
    if (!Number.isInteger(departmentId) || !departments.some((department) => department.id === departmentId)) {
      return res.status(400).json({ error: 'Phòng ban không hợp lệ' });
    }
  }
  const employees = await employeeQuery(departmentId ? { department_id: departmentId } : {}, req.user);
  const rows = [
    ['Mã nhân viên', 'Họ tên', 'Email', 'Số điện thoại', 'Phòng ban', 'Chức danh', 'Trạng thái', 'Ngày vào làm'],
    ...employees.map((employee) => [
      employee.code, employee.name, employee.email, employee.phone, employee.department,
      employee.position, employee.status, employee.start_date,
    ]),
  ];
  audit(req.user, `Xuất danh sách nhân viên: ${employees.length}`);
  res.set({
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': 'attachment; filename="danh-sach-nhan-vien.csv"',
  });
  res.send('\uFEFF' + rows.map((row) => row.map(L.csvCell).join(',')).join('\r\n'));
}));

router.get('/', wrap(async (req, res) => {
  const filters = {};
  if (req.query.q) filters.q = String(req.query.q);
  if (req.query.department_id) filters.department_id = String(req.query.department_id);
  res.json(await employeeQuery(filters, req.user));
}));

async function validate(input, id) {
  const name = String(input.name || '').trim();
  const email = String(input.email || '').trim().toLowerCase();
  const code = String(input.code || '').trim();
  if (!name) return 'Vui lòng nhập họ tên';
  if (!code) return 'Vui lòng nhập mã nhân viên';
  if (!EMAIL_RE.test(email)) return 'Email không hợp lệ';
  if (!validPhone(input.phone)) return 'Số điện thoại không hợp lệ (7–15 chữ số)';
  if (input.start_date && !L.validDate(String(input.start_date))) return 'Ngày vào làm không hợp lệ';
  if (input.status && !STATUSES.includes(input.status)) return 'Trạng thái không hợp lệ';
  const [sameEmail, sameCode] = await Promise.all([
    employeeQuery({ email }),
    employeeQuery({ codes: code }),
  ]);
  if ([...sameEmail, ...sameCode].some((employee) => employee.id !== id)) return 'Mã hoặc email bị trùng';
  const [departments, positions] = await Promise.all([organization('departments'), organization('positions')]);
  if (input.department_id && !departments.some((department) => department.id === Number(input.department_id))) {
    return 'Phòng ban không tồn tại';
  }
  if (input.position_id && !positions.some((position) => position.id === Number(input.position_id))) {
    return 'Chức danh không tồn tại';
  }
  return null;
}

router.post('/', need('admin', 'hr'), wrap(async (req, res) => {
  const error = await validate(req.body || {});
  if (error) return res.status(400).json({ error });
  const input = req.body;
  const result = await callEmployeeService('/internal/v1/employees', {
    method: 'POST',
    body: {
      code: String(input.code).trim(), name: String(input.name).trim(),
      email: String(input.email).trim().toLowerCase(), phone: String(input.phone || ''),
      department_id: input.department_id || null, position_id: input.position_id || null,
      status: input.status || 'Thử việc', start_date: String(input.start_date || ''),
    },
  });
  const created = await employeeById(result.id);
  await recordEmployeeHistory(created, req.user, 'employee', { profile: { old: null, new: {
    code: created.code, name: created.name, email: created.email, department_id: created.department_id,
    position_id: created.position_id, status: created.status, start_date: created.start_date,
  } } });
  audit(req.user, `Thêm nhân viên ${created.code}`);
  res.status(201).json({ id: result.id });
}));

router.put('/:id', wrap(async (req, res) => {
  const current = await employeeById(req.params.id, req.user);
  if (!current) return res.status(404).json({ error: 'Không tìm thấy hồ sơ' });
  if (isHr(req.user)) {
    const input = { ...current, ...req.body };
    const error = await validate(input, current.id);
    if (error) return res.status(400).json({ error });
    await callEmployeeService(`/internal/v1/employees/${current.id}`, {
      method: 'PUT',
      body: {
        code: String(input.code).trim(), name: String(input.name).trim(),
        email: String(input.email).trim().toLowerCase(), phone: String(input.phone || ''),
        department_id: input.department_id || null, position_id: input.position_id || null,
        status: input.status, start_date: String(input.start_date || ''),
      },
    });
    const labels = {
      code: 'Mã nhân viên', name: 'Họ tên', email: 'Email', phone: 'Số điện thoại',
      department_id: 'Phòng ban', position_id: 'Chức danh', status: 'Trạng thái', start_date: 'Ngày vào làm',
    };
    const changes = {};
    Object.keys(labels).forEach((key) => {
      const oldValue = current[key] == null ? '' : String(current[key]);
      const newValue = input[key] == null ? '' : String(input[key]);
      if (oldValue !== newValue) changes[labels[key]] = { old: oldValue, new: newValue };
    });
    await recordEmployeeHistory(current, req.user, 'employee', changes);
  } else if (current.email === req.user.email) {
    const phone = String(req.body.phone || '');
    if (!validPhone(phone)) return res.status(400).json({ error: 'Số điện thoại không hợp lệ (7–15 chữ số)' });
    await callEmployeeService(`/internal/v1/employees/${current.id}/phone`, { method: 'PUT', body: { phone } });
    await recordEmployeeHistory(current, req.user, 'employee', current.phone !== phone
      ? { 'Số điện thoại': { old: current.phone, new: phone } } : {});
  } else {
    return res.status(403).json({ error: 'Bạn không đủ quyền sửa hồ sơ này' });
  }
  audit(req.user, `Sửa hồ sơ ${current.code}`);
  res.json({ ok: true });
}));

router.delete('/:id', need('admin', 'hr'), wrap(async (req, res) => {
  const current = await employeeById(req.params.id);
  if (!current) return res.status(404).json({ error: 'Không tìm thấy hồ sơ' });
  const payrollData = await payrollDataForEmployee(current.id);
  if (payrollData.has_payslips) {
    return res.status(409).json({ error: 'Nhân viên đã có phiếu lương nên không thể xóa. Hãy chuyển trạng thái sang "Nghỉ việc"' });
  }
  if (payrollData.has_advances) {
    return res.status(409).json({ error: 'Nhân viên đã có lịch sử ứng lương nên không thể xóa. Hãy chuyển trạng thái sang "Nghỉ việc"' });
  }
  if (await hasAttendanceForEmployee(current.id)) {
    return res.status(409).json({ error: 'Nhân viên có dữ liệu chấm công nên không thể xóa. Hãy chuyển trạng thái sang "Nghỉ việc"' });
  }
  if (payrollData.has_salary || payrollData.has_adjustments) {
    return res.status(409).json({ error: 'Nhân viên có dữ liệu chấm công, nghỉ phép hoặc lương nên không thể xóa. Hãy chuyển trạng thái sang "Nghỉ việc"' });
  }
  if (await hasLeaveOrOvertimeRequests(current.id)) {
    return res.status(409).json({ error: 'Nhân viên có dữ liệu chấm công, nghỉ phép hoặc lương nên không thể xóa. Hãy chuyển trạng thái sang "Nghỉ việc"' });
  }
  await recordEmployeeHistory(current, req.user, 'employee', { profile: { old: 'Đang làm việc', new: 'Đã xóa hồ sơ' } });
  await callEmployeeService(`/internal/v1/employees/${current.id}`, { method: 'DELETE' });
  audit(req.user, `Xóa nhân viên ${current.code}`);
  res.json({ ok: true });
}));

router.post('/import', need('admin', 'hr'), wrap(async (req, res) => {
  const lines = String(req.body.csv || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return res.status(400).json({ error: 'Chưa có dữ liệu' });
  if (lines.length > 2000) return res.status(400).json({ error: 'Tối đa 2000 dòng mỗi lần import' });
  const errors = [];
  let imported = 0;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (index === 0 && /email/i.test(line)) continue;
    const [code, name, emailValue, departmentName, positionName] = line.split(/[,;\t]/).map((value) => value.trim());
    const email = String(emailValue || '').toLowerCase();
    if (!code || !name || !emailValue) { errors.push(`Dòng ${index + 1}: thiếu mã, họ tên hoặc email`); continue; }
    if (!EMAIL_RE.test(email)) { errors.push(`Dòng ${index + 1}: email không hợp lệ`); continue; }
    const [sameEmail, sameCode] = await Promise.all([employeeQuery({ email }), employeeQuery({ codes: code })]);
    if (sameEmail.length || sameCode.length) { errors.push(`Dòng ${index + 1}: trùng mã hoặc email`); continue; }
    const [departments, positions] = await Promise.all([organization('departments'), organization('positions')]);
    const ensureOrganization = async (rows, table, nameValue) => {
      if (!nameValue) return null;
      const found = rows.find((row) => row.name.toLowerCase() === nameValue.toLowerCase());
      if (found) return found.id;
      const created = await callEmployeeService(`/internal/v1/${table}`, { method: 'POST', body: { name: nameValue } });
      return created.id;
    };
    try {
      const [departmentId, positionId] = await Promise.all([
        ensureOrganization(departments, 'departments', departmentName),
        ensureOrganization(positions, 'positions', positionName),
      ]);
      const created = await callEmployeeService('/internal/v1/employees', {
        method: 'POST',
        body: { code, name, email, department_id: departmentId, position_id: positionId },
      });
      const employee = await employeeById(created.id);
      await recordEmployeeHistory(employee, req.user, 'employee', { profile: { old: null, new: {
        code: employee.code, name: employee.name, email: employee.email,
        department_id: employee.department_id, position_id: employee.position_id,
        status: employee.status, start_date: employee.start_date,
      } } });
      imported++;
    } catch (error) {
      if (error.statusCode === 409) errors.push(`Dòng ${index + 1}: trùng mã hoặc email`);
      else throw error;
    }
  }
  audit(req.user, `Import CSV: ${imported} thành công, ${errors.length} lỗi`);
  res.json({ imported, errors });
}));

module.exports = router;
