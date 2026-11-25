const router = require('express').Router();
const { auth, wrap } = require('../middleware');
const L = require('../lib');
const { attendanceForEmployees, attendanceByDate } = require('../attendance-client');
const {
  approvedLeavesForEmployees, countRequestsForEmployees, leaveBalance,
} = require('../leave-client');
const { payrollTrend } = require('../payroll-client');

router.use(auth);

router.get('/', wrap(async (req, res) => {
  const user = req.user;
  const today = L.today();
  const employees = await L.employeesInScope(user);
  const me = await L.meEmp(user);
  const active = employees.filter((employee) => employee.status !== 'Nghỉ việc');
  const out = { role: user.role, today };

  if (user.role !== 'employee') {
    out.headcount = active.length;
    const byDepartment = new Map();
    const byStatus = new Map();
    active.forEach((employee) => {
      const name = employee.department || 'Chưa phân bổ';
      byDepartment.set(name, (byDepartment.get(name) || 0) + 1);
    });
    employees.forEach((employee) => byStatus.set(employee.status, (byStatus.get(employee.status) || 0) + 1));
    out.by_department = [...byDepartment].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
    out.by_status = [...byStatus].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
    const attendance = await attendanceForEmployees(active.map((employee) => employee.id), today, today);
    out.present_today = attendance.filter((record) => record.check_in !== null).length;
    const leaveToday = await approvedLeavesForEmployees(active.map((employee) => employee.id), today, today);
    const fullDayLeave = new Set(leaveToday.filter((leave) => !leave.half).map((leave) => leave.employee_id));
    const workStart = L.getSettings().work_start;
    out.late_today = attendance.filter((record) => record.check_in && record.check_in > workStart
      && !fullDayLeave.has(record.employee_id)).length;
    out.on_leave_today = new Set(leaveToday.map((leave) => leave.employee_id)).size;
    const monthAgo = L.fmtDate(new Date(Date.now() - 30 * 86400000));
    out.new_hires_30d = active.filter((employee) => employee.start_date >= monthAgo && employee.start_date !== '').length;
  }

  if (L.isHr(user)) {
    const visibleIds = new Set(employees.filter((employee) => employee.email !== user.email).map((employee) => employee.id));
    out.pending_for_me = await countRequestsForEmployees([...visibleIds], 'Chờ HR');
  } else if (user.role === 'manager' && me && me.department_id) {
    const teamIds = employees.filter((employee) => employee.department_id === me.department_id && employee.id !== me.id)
      .map((employee) => employee.id);
    out.pending_for_me = await countRequestsForEmployees(teamIds, 'Chờ quản lý');
  }
  if (me) {
    out.my_pending = await countRequestsForEmployees([me.id], 'Chờ quản lý')
      + await countRequestsForEmployees([me.id], 'Chờ HR');
    const attendance = await attendanceByDate(me.id, today);
    out.my_today = { check_in: attendance ? attendance.check_in : null, check_out: attendance ? attendance.check_out : null };
    const balance = await leaveBalance(me.id, today.slice(0, 4),
      Number(L.getSettings().annual_leave_days));
    out.my_leave = {
      quota: balance.quota, used: balance.used, pending: balance.pending, remaining: balance.remaining,
    };
  }

  if (L.isHr(user)) {
    out.payroll_trend = await payrollTrend();
  }
  res.json(out);
}));

module.exports = router;
