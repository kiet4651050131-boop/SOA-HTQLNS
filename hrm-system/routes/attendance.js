const router = require('express').Router();
const { audit } = require('../db');
const { auth, need, wrap } = require('../middleware');
const L = require('../lib');
const { employeeById, employeesByCodes, organization } = require('../employee-client');
const {
  attendanceByDate, summarizeEmployees, upsertAttendance, deleteAttendance, importAttendance,
} = require('../attendance-client');
const { approvedLeavesForEmployees } = require('../leave-client');
const { isPayrollLocked } = require('../payroll-client');

router.use(auth);

// Chấm công của chính mình hôm nay
router.get('/today', wrap(async (req, res) => {
  const e = await L.meEmp(req.user);
  if (!e) return res.json({ employee: false });
  const a = await attendanceByDate(e.id, L.today());
  res.json({ employee: true, date: L.today(), check_in: a ? a.check_in : null, check_out: a ? a.check_out : null });
}));

router.get('/export', wrap(async (req, res) => {
  const month = String(req.query.month || L.curMonth());
  if (!L.validMonth(month)) return res.status(400).json({ error: 'Tháng không hợp lệ (YYYY-MM)' });
  let departmentId;
  if (req.query.department_id) {
    departmentId = Number(req.query.department_id);
    const departments = await organization('departments');
    if (!Number.isInteger(departmentId) || !departments.some((department) => department.id === departmentId)) {
      return res.status(400).json({ error: 'Phòng ban không hợp lệ' });
    }
  }
  const employees = await L.employeesInScope(req.user, departmentId ? { department_id: departmentId } : {});
  const rows = [['Mã nhân viên', 'Họ tên', 'Phòng ban', 'Ngày', 'Giờ vào', 'Giờ ra', 'Số giờ', 'Trạng thái', 'Ghi chú']];
  const summaries = await summarizeEmployees(month, employees);
  const summaryById = new Map(summaries.map((summary) => [summary.employee_id, summary]));
  employees.forEach((employee) => {
    summaryById.get(employee.id).days.forEach((day) => {
      rows.push([
        employee.code, employee.name, employee.department, day.date, day.check_in, day.check_out,
        day.hours == null ? '' : day.hours.toFixed(2), day.status, day.note,
      ]);
    });
  });
  audit(req.user, `Xuất bảng chấm công ${month}: ${employees.length} nhân viên`);
  res.set({
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="bang-cham-cong-${month}.csv"`,
  });
  res.send('\uFEFF' + rows.map((row) => row.map(L.csvCell).join(',')).join('\r\n'));
}));

router.post('/check-in', wrap(async (req, res) => {
  const e = await L.meEmp(req.user);
  if (!e) return res.status(404).json({ error: 'Tài khoản chưa có hồ sơ nhân viên' });
  if (e.status === 'Nghỉ việc') return res.status(403).json({ error: 'Hồ sơ đã ở trạng thái nghỉ việc' });
  const d = L.today();
  if (await isPayrollLocked(d.slice(0, 7))) return res.status(409).json({ error: 'Kỳ lương tháng này đã chốt, không thể chấm công bổ sung' });
  const leaves = await approvedLeavesForEmployees([e.id], d, d);
  if (leaves.some((leave) => !leave.half)) return res.status(400).json({ error: 'Bạn đã được duyệt nghỉ cả ngày hôm nay, không thể check-in' });
  const cur = await attendanceByDate(e.id, d);
  if (cur && cur.check_in) return res.status(400).json({ error: `Hôm nay bạn đã check-in lúc ${cur.check_in}` });
  const checkIn = L.nowHM();
  await upsertAttendance({
    employee_id: e.id, date: d, check_in: checkIn, check_out: cur ? cur.check_out : null,
    note: cur ? cur.note : '', source: cur ? cur.source : 'web',
  });
  audit(req.user, `Check-in ${d}`);
  res.json({ ok: true, check_in: checkIn });
}));

router.post('/check-out', wrap(async (req, res) => {
  const e = await L.meEmp(req.user);
  if (!e) return res.status(404).json({ error: 'Tài khoản chưa có hồ sơ nhân viên' });
  const d = L.today();
  if (await isPayrollLocked(d.slice(0, 7))) return res.status(409).json({ error: 'Kỳ lương tháng này đã chốt, không thể sửa chấm công' });
  const cur = await attendanceByDate(e.id, L.today());
  if (!cur || !cur.check_in) return res.status(400).json({ error: 'Bạn chưa check-in hôm nay' });
  if (cur.check_out) return res.status(400).json({ error: `Bạn đã check-out lúc ${cur.check_out}. Cần sửa hãy liên hệ HR` });
  const checkOut = L.nowHM();
  await upsertAttendance({
    employee_id: e.id, date: d, check_in: cur.check_in, check_out: checkOut,
    note: cur.note, source: cur.source,
  });
  audit(req.user, `Check-out ${L.today()}`);
  res.json({ ok: true, check_out: checkOut });
}));

// Bảng công tổng hợp của tất cả nhân viên trong phạm vi được xem
router.get('/month', wrap(async (req, res) => {
  const month = req.query.month || L.curMonth();
  if (!L.validMonth(month)) return res.status(400).json({ error: 'Tháng không hợp lệ (định dạng YYYY-MM)' });
  let departmentId;
  if (req.query.department_id) {
    departmentId = Number(req.query.department_id);
    const departments = await organization('departments');
    if (!Number.isInteger(departmentId) || !departments.some((department) => department.id === departmentId)) {
      return res.status(400).json({ error: 'Phòng ban không hợp lệ' });
    }
  }
  const emps = await L.employeesInScope(req.user, departmentId ? { department_id: departmentId } : {});
  const summaries = await summarizeEmployees(month, emps);
  const summaryById = new Map(summaries.map((summary) => [summary.employee_id, summary]));
  res.json(emps.map((e) => ({
    employee_id: e.id, code: e.code, name: e.name, department: e.department, status: e.status,
    ...summaryById.get(e.id).summary,
  })));
}));

// Chi tiết từng ngày của một nhân viên
router.get('/month/:employeeId', wrap(async (req, res) => {
  const month = req.query.month || L.curMonth();
  if (!L.validMonth(month)) return res.status(400).json({ error: 'Tháng không hợp lệ (định dạng YYYY-MM)' });
  const e = await L.canSeeEmp(req.user, req.params.employeeId);
  if (!e) return res.status(404).json({ error: 'Không tìm thấy hồ sơ' });
  const [r] = await summarizeEmployees(month, [e]);
  res.json({ employee: { id: e.id, code: e.code, name: e.name }, month, ...r });
}));

// HR/Admin sửa tay một ngày công (để trống cả giờ vào và giờ ra = xóa)
router.put('/', need('admin', 'hr'), wrap(async (req, res) => {
  const b = req.body || {};
  const e = await employeeById(b.employee_id);
  if (!e) return res.status(404).json({ error: 'Không tìm thấy nhân viên' });
  if (!L.validDate(b.date)) return res.status(400).json({ error: 'Ngày không hợp lệ' });
  if (await isPayrollLocked(b.date.slice(0, 7))) return res.status(409).json({ error: `Kỳ lương tháng ${b.date.slice(0, 7)} đã chốt, không thể sửa chấm công` });
  const ci = String(b.check_in || '').trim(), co = String(b.check_out || '').trim();
  if (ci && !L.validTime(ci)) return res.status(400).json({ error: 'Giờ vào không hợp lệ (HH:MM)' });
  if (co && !L.validTime(co)) return res.status(400).json({ error: 'Giờ ra không hợp lệ (HH:MM)' });
  if (co && !ci) return res.status(400).json({ error: 'Có giờ ra thì phải có giờ vào' });
  if (ci && co && co < ci) return res.status(400).json({ error: 'Giờ ra phải sau giờ vào' });
  if (!ci && !co) {
    await deleteAttendance(e.id, b.date);
  } else {
    await upsertAttendance({
      employee_id: e.id, date: b.date, check_in: ci || null, check_out: co || null,
      note: String(b.note || '').slice(0, 200), source: 'manual',
    });
  }
  audit(req.user, `Sửa công ${e.code} ngày ${b.date}`);
  res.json({ ok: true });
}));

// Import file máy chấm công: mã NV, ngày, giờ vào, giờ ra (ngày dạng YYYY-MM-DD hoặc DD/MM/YYYY)
function normDate(s) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : s;
}
function normTime(s) {
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(String(s || '').trim());
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : '';
}
router.post('/import', need('admin', 'hr'), wrap(async (req, res) => {
  const lines = String(req.body.csv || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  if (!lines.length) return res.status(400).json({ error: 'Chưa có dữ liệu' });
  if (lines.length > 5000) return res.status(400).json({ error: 'Tối đa 5000 dòng mỗi lần import' });
  const errors = [];
  let imported = 0;
  const parsed = lines.map((line, index) => {
    if (index === 0 && /m[ãa]|code|date|ng[àa]y/i.test(line)) return null;
    const [code, d0, ci0, co0] = line.split(/[,;\t]/).map((value) => value.trim());
    return { code: code || '', date: normDate(d0 || ''), ci: normTime(ci0), co: normTime(co0), line: index + 1 };
  }).filter(Boolean);
  const employeeRows = await employeesByCodes(parsed.map((row) => row.code));
  const employeesByCode = new Map(employeeRows.map((employee) => [employee.code, employee]));
  const validRecords = [];
  for (const { code, date, ci, co, line } of parsed) {
    const e = employeesByCode.get(code);
    if (!e) { errors.push(`Dòng ${line}: không có mã nhân viên "${code}"`); continue; }
    if (!L.validDate(date)) { errors.push(`Dòng ${line}: ngày không hợp lệ`); continue; }
    if (await isPayrollLocked(date.slice(0, 7))) {
      errors.push(`Dòng ${line}: kỳ lương tháng ${date.slice(0, 7)} đã chốt`);
      continue;
    }
    if (!ci) { errors.push(`Dòng ${line}: thiếu hoặc sai giờ vào`); continue; }
    if (!L.validTime(ci) || (co && !L.validTime(co)) || (!co && String(lines[line - 1]).split(/[,;\t]/)[3])) {
      errors.push(`Dòng ${line}: giờ vào/ra không hợp lệ`);
      continue;
    }
    if (co && co < ci) { errors.push(`Dòng ${line}: giờ ra trước giờ vào`); continue; }
    validRecords.push({ employee_id: e.id, date, check_in: ci, check_out: co || null });
  }
  if (validRecords.length) {
    const result = await importAttendance(validRecords);
    imported = result.imported;
  }
  audit(req.user, `Import chấm công: ${imported} thành công, ${errors.length} lỗi`);
  res.json({ imported, errors });
}));

module.exports = router;
