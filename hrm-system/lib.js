// Hàm dùng chung cho chấm công, nghỉ phép, lương
const { getCachedSettings, getCachedHolidays } = require('./config-cache');
const { employeeQuery, employeeByEmail } = require('./employee-client');

/* ---------- Ngày giờ (theo múi giờ của server, mặc định Asia/Ho_Chi_Minh) ---------- */
const pad = (n) => String(n).padStart(2, '0');
const fmtDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseD = (s) => new Date(`${s}T00:00:00`);
const today = () => fmtDate(new Date());
const nowHM = () => { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const validDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s)) && fmtDate(parseD(s)) === s;
const validTime = (s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s));
const validMonth = (s) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(s));
const curMonth = () => today().slice(0, 7);
const monthRange = (m) => {
  const [y, mo] = m.split('-').map(Number);
  return { from: `${m}-01`, to: `${m}-${pad(new Date(y, mo, 0).getDate())}` };
};
function eachDay(from, to) {
  const out = [];
  for (let d = parseD(from); fmtDate(d) <= to; d.setDate(d.getDate() + 1)) out.push(fmtDate(d));
  return out;
}
const round2 = (n) => Math.round(n * 100) / 100;
const csvCell = (value) => {
  let text = String(value == null ? '' : value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return /[",\n;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

/* ---------- Cấu hình, ngày lễ, ngày làm việc ---------- */
const getSettings = getCachedSettings;
const holidays = getCachedHolidays;
function isWorkday(s, st, hol) {
  const w = parseD(s).getDay();
  return !hol.has(s) && w !== 0 && (w !== 6 || st.work_saturday === '1');
}
const workdays = (from, to, st, hol) => eachDay(from, to).filter((d) => isWorkday(d, st, hol));

/* ---------- Phạm vi xem hồ sơ ---------- */
const isHr = (u) => u.role === 'admin' || u.role === 'hr';
const meEmp = (u) => employeeByEmail(u.email);
// Nhân viên = chỉ mình; quản lý = cùng phòng ban + mình; HR/Admin = tất cả
const employeesInScope = (u, filters = {}) => employeeQuery(filters, u);
const canSeeEmp = async (u, id) => (await employeesInScope(u, { ids: id }))[0] || null;

module.exports = {
  today, nowHM, fmtDate, parseD, validDate, validTime, validMonth, curMonth, monthRange, eachDay, workdays, holidays, isWorkday,
  csvCell,
  getSettings, isHr, meEmp, employeesInScope, canSeeEmp, round2,
};
