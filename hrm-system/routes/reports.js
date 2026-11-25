const router = require('express').Router();
const { auth, wrap } = require('../middleware');
const L = require('../lib');
const { organization } = require('../employee-client');
const { summarizeEmployees } = require('../attendance-client');
const { reportForEmployees } = require('../leave-client');
const { payrollCost } = require('../payroll-client');

router.use(auth);

async function getData(user, month, departmentId) {
  const { from, to } = L.monthRange(month);
  const filters = departmentId ? { department_id: departmentId } : {};
  const employees = await L.employeesInScope(user, filters);
  const active = employees.filter((employee) => employee.status !== 'Nghỉ việc');
  const byDepartment = {};
  const byStatus = {};
  active.forEach((employee) => {
    const department = employee.department || 'Chưa phân bổ';
    byDepartment[department] = (byDepartment[department] || 0) + 1;
  });
  employees.forEach((employee) => { byStatus[employee.status] = (byStatus[employee.status] || 0) + 1; });

  const attendance = { present: 0, paid_leave: 0, unpaid_leave: 0, absent: 0, late: 0, missing_checkout: 0 };
  const attendanceSummaries = await summarizeEmployees(month, active);
  attendanceSummaries.forEach(({ summary }) => {
    Object.keys(attendance).forEach((key) => { attendance[key] += summary[key] || 0; });
  });

  const leaveAndOvertime = employees.length
    ? await reportForEmployees(employees.map((employee) => employee.id), from, to)
    : { leave: [], overtime: { requests: 0, hours: 0 } };
  let payroll = [];
  if (L.isHr(user)) {
    payroll = await payrollCost(month, departmentId ? employees[0]?.department || '' : undefined);
  }
  return {
    month,
    headcount: active.length,
    by_department: Object.entries(byDepartment).map(([name, count]) => ({ name, count })),
    by_status: Object.entries(byStatus).map(([name, count]) => ({ name, count })),
    attendance,
    overtime: leaveAndOvertime.overtime,
    leave: leaveAndOvertime.leave,
    payroll,
  };
}

async function params(req, res) {
  const month = String(req.query.month || L.curMonth());
  if (!L.validMonth(month)) {
    res.status(400).json({ error: 'Tháng không hợp lệ (YYYY-MM)' });
    return null;
  }
  let departmentId = null;
  if (req.query.department_id) {
    departmentId = Number(req.query.department_id);
    const departments = await organization('departments');
    if (!Number.isInteger(departmentId) || !departments.some((department) => department.id === departmentId)) {
      res.status(400).json({ error: 'Phòng ban không hợp lệ' });
      return null;
    }
  }
  return { month, departmentId };
}

router.get('/', wrap(async (req, res) => {
  if (req.user.role === 'employee') return res.status(403).json({ error: 'Bạn không đủ quyền xem báo cáo HR' });
  const query = await params(req, res);
  if (!query) return;
  res.json(await getData(req.user, query.month, query.departmentId));
}));

const csvCell = (value) => {
  let text = String(value == null ? '' : value);
  if (/^[=+\-@]/.test(text) && Number.isNaN(Number(text))) text = `'${text}`;
  return /[",\n;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

router.get('/export', wrap(async (req, res) => {
  if (req.user.role === 'employee') return res.status(403).json({ error: 'Bạn không đủ quyền xuất báo cáo HR' });
  const query = await params(req, res);
  if (!query) return;
  const report = await getData(req.user, query.month, query.departmentId);
  const rows = [
    ['Báo cáo HR', query.month],
    [],
    ['Nhân sự', 'Số lượng'],
    ...report.by_department.map((row) => [row.name, row.count]),
    [],
    ['Trạng thái nhân sự', 'Số lượng'],
    ...report.by_status.map((row) => [row.name, row.count]),
    [],
    ['Chấm công', 'Số ngày'],
    ...Object.entries(report.attendance).map(([name, count]) => [name, count]),
    [],
    ['Tăng ca đã duyệt', 'Số đề nghị', 'Số giờ'],
    ['Tổng', report.overtime.requests, report.overtime.hours],
    [],
    ['Đơn nghỉ', 'Số đơn', 'Số ngày'],
    ...report.leave.map((row) => [row.status, row.requests, row.days]),
  ];
  if (L.isHr(req.user)) {
    rows.push([], ['Bảng lương đã chốt', 'Số phiếu', 'Tổng thu nhập', 'Thực nhận']);
    report.payroll.forEach((row) => rows.push([row.department || 'Chưa phân bổ', row.headcount, row.gross, row.net]));
  }
  res.set({
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="bao-cao-hr-${query.month}.csv"`,
  });
  res.send('\uFEFF' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n'));
}));

module.exports = router;
