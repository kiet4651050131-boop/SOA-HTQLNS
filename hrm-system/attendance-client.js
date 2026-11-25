const { callService } = require('./service-client');

function callAttendanceService(path, options = {}) {
  return callService(path, {
    ...options,
    baseUrl: process.env.ATTENDANCE_SERVICE_URL || 'http://127.0.0.1:3003',
    timeoutEnv: 'ATTENDANCE_SERVICE_TIMEOUT_MS',
    serviceName: 'Attendance Service',
    passThrough4xx: true,
  });
}

async function summarizeEmployees(month, employees) {
  if (!employees.length) return [];
  const summaries = [];
  for (let index = 0; index < employees.length; index += 100) {
    const batch = employees.slice(index, index + 100);
    summaries.push(...await callAttendanceService('/internal/v1/summary/batch', {
      method: 'POST',
      body: { month, employees: batch.map((employee) => ({ id: employee.id, start_date: employee.start_date || '' })) },
    }));
  }
  return summaries;
}

async function attendanceForEmployees(employeeIds, from, to) {
  const ids = [...new Set(employeeIds.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))];
  const records = [];
  for (let index = 0; index < ids.length; index += 500) {
    const query = new URLSearchParams({
      employee_ids: ids.slice(index, index + 500).join(','),
      from,
      to,
    });
    records.push(...await callAttendanceService(`/internal/v1/attendance?${query}`));
  }
  return records;
}

function attendanceByDate(employeeId, date) {
  const query = new URLSearchParams({ employee_id: String(employeeId), date });
  return callAttendanceService(`/internal/v1/attendance/by-date?${query}`);
}

function hasAttendanceForEmployee(employeeId) {
  const query = new URLSearchParams({ employee_id: String(employeeId) });
  return callAttendanceService(`/internal/v1/attendance/exists?${query}`)
    .then((result) => result.exists);
}

function upsertAttendance(record) {
  return callAttendanceService('/internal/v1/attendance', { method: 'POST', body: record });
}

function deleteAttendance(employeeId, date) {
  const query = new URLSearchParams({ employee_id: String(employeeId), date });
  return callAttendanceService(`/internal/v1/attendance?${query}`, { method: 'DELETE' });
}

function importAttendance(records) {
  return callAttendanceService('/internal/v1/attendance/import', {
    method: 'POST',
    body: { records },
  });
}

module.exports = {
  callAttendanceService,
  summarizeEmployees,
  attendanceForEmployees,
  attendanceByDate,
  hasAttendanceForEmployee,
  upsertAttendance,
  deleteAttendance,
  importAttendance,
};
