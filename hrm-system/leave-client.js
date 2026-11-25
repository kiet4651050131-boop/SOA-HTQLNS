const { callService } = require('./service-client');

function callLeaveService(path, options = {}) {
  return callService(path, {
    ...options,
    baseUrl: process.env.LEAVE_SERVICE_URL || 'http://127.0.0.1:3004',
    timeoutEnv: 'LEAVE_SERVICE_TIMEOUT_MS',
    serviceName: 'Leave Service',
    passThrough4xx: true,
  });
}

function chunked(ids) {
  const unique = [...new Set(ids.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))];
  const batches = [];
  for (let index = 0; index < unique.length; index += 100) batches.push(unique.slice(index, index + 100));
  return batches;
}

async function requestsForEmployees(ids, status) {
  const rows = [];
  for (const batch of chunked(ids)) {
    const query = new URLSearchParams({ ids: batch.join(',') });
    if (status) query.set('status', status);
    rows.push(...await callLeaveService(`/internal/v1/leave/requests?${query}`));
  }
  return rows.sort((a, b) => {
    const pendingOrder = (['Chờ quản lý', 'Chờ HR'].includes(a.status) ? 0 : 1)
      - (['Chờ quản lý', 'Chờ HR'].includes(b.status) ? 0 : 1);
    return pendingOrder || b.from_date.localeCompare(a.from_date) || b.id - a.id;
  }).slice(0, 500);
}

async function countRequestsForEmployees(ids, status) {
  let count = 0;
  for (const batch of chunked(ids)) {
    const query = new URLSearchParams({ ids: batch.join(','), status });
    const result = await callLeaveService(`/internal/v1/leave/count?${query}`);
    count += result.count;
  }
  return count;
}

async function overtimeRequestsForEmployees(ids) {
  const rows = [];
  for (const batch of chunked(ids)) {
    const query = new URLSearchParams({ ids: batch.join(',') });
    rows.push(...await callLeaveService(`/internal/v1/overtime/requests?${query}`));
  }
  return rows.sort((a, b) => {
    const pendingOrder = (['Chờ quản lý', 'Chờ HR'].includes(a.status) ? 0 : 1)
      - (['Chờ quản lý', 'Chờ HR'].includes(b.status) ? 0 : 1);
    return pendingOrder || b.date.localeCompare(a.date) || b.id - a.id;
  }).slice(0, 500);
}

async function approvedLeavesForEmployees(ids, from, to) {
  const rows = [];
  for (const batch of chunked(ids)) {
    const query = new URLSearchParams({ ids: batch.join(','), from, to });
    rows.push(...await callLeaveService(`/internal/v1/leave/approved?${query}`));
  }
  return rows;
}

async function reportForEmployees(ids, from, to) {
  const leaveByStatus = new Map();
  const overtime = { requests: 0, hours: 0 };
  for (const batch of chunked(ids)) {
    const query = new URLSearchParams({ ids: batch.join(','), from, to });
    const result = await callLeaveService(`/internal/v1/reports?${query}`);
    for (const row of result.leave) {
      const current = leaveByStatus.get(row.status) || { status: row.status, requests: 0, days: 0 };
      current.requests += row.requests;
      current.days += row.days;
      leaveByStatus.set(row.status, current);
    }
    overtime.requests += result.overtime.requests;
    overtime.hours += result.overtime.hours;
  }
  return {
    leave: [...leaveByStatus.values()].sort((a, b) => a.status < b.status ? -1 : (a.status > b.status ? 1 : 0)),
    overtime,
  };
}

async function approvedOvertimeHours(month, to) {
  const query = new URLSearchParams({ month });
  if (to) query.set('to', to);
  const rows = await callLeaveService(`/internal/v1/overtime/approved-hours?${query}`);
  return new Map(rows.map((row) => [row.employee_id, row.hours]));
}

function leaveTypes() {
  return callLeaveService('/internal/v1/leave/types');
}

function leaveBalance(employeeId, year, quota) {
  const query = new URLSearchParams({
    employee_id: String(employeeId),
    year: String(year),
    quota: String(quota),
  });
  return callLeaveService(`/internal/v1/leave/balance?${query}`);
}

function hasOverlappingLeave(employeeId, from, to) {
  const query = new URLSearchParams({ employee_id: String(employeeId), from, to });
  return callLeaveService(`/internal/v1/leave/conflict?${query}`).then((result) => result.conflict);
}

function createLeaveRequest(input) {
  return callLeaveService('/internal/v1/leave/requests', { method: 'POST', body: input });
}

function leaveRequestById(id) {
  return callLeaveService(`/internal/v1/leave/requests/${encodeURIComponent(id)}`);
}

function updateLeaveRequest(id, input) {
  return callLeaveService(`/internal/v1/leave/requests/${encodeURIComponent(id)}`, { method: 'PUT', body: input });
}

function createOvertimeRequest(input) {
  return callLeaveService('/internal/v1/overtime/requests', { method: 'POST', body: input });
}

function overtimeRequestById(id) {
  return callLeaveService(`/internal/v1/overtime/requests/${encodeURIComponent(id)}`);
}

function updateOvertimeRequest(id, input) {
  return callLeaveService(`/internal/v1/overtime/requests/${encodeURIComponent(id)}`, { method: 'PUT', body: input });
}

function hasLeaveOrOvertimeRequests(employeeId) {
  return callLeaveService(`/internal/v1/employees/${encodeURIComponent(employeeId)}/has-requests`)
    .then((result) => result.has_requests);
}

module.exports = {
  callLeaveService,
  requestsForEmployees,
  countRequestsForEmployees,
  overtimeRequestsForEmployees,
  approvedLeavesForEmployees,
  reportForEmployees,
  approvedOvertimeHours,
  leaveTypes,
  leaveBalance,
  hasOverlappingLeave,
  createLeaveRequest,
  leaveRequestById,
  updateLeaveRequest,
  createOvertimeRequest,
  overtimeRequestById,
  updateOvertimeRequest,
  hasLeaveOrOvertimeRequests,
};
