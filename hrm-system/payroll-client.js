const { callService } = require('./service-client');

function callPayrollService(path, options = {}) {
  return callService(path, {
    ...options,
    baseUrl: process.env.PAYROLL_SERVICE_URL || 'http://127.0.0.1:3005',
    timeoutEnv: 'PAYROLL_SERVICE_TIMEOUT_MS',
    serviceName: 'Payroll Service',
    passThrough4xx: true,
  });
}

function payrollSalaries(employeeIds) {
  const query = employeeIds && employeeIds.length
    ? `?employee_ids=${encodeURIComponent(employeeIds.join(','))}`
    : '';
  return callPayrollService(`/internal/v1/payroll/salaries${query}`);
}

function upsertPayrollSalary(employeeId, salary) {
  return callPayrollService(`/internal/v1/payroll/salaries/${encodeURIComponent(employeeId)}`, {
    method: 'PUT',
    body: salary,
  });
}

function payrollPeriods(employeeId) {
  const query = employeeId ? `?employee_id=${encodeURIComponent(employeeId)}` : '';
  return callPayrollService(`/internal/v1/payroll/periods${query}`);
}

function payrollPeriod(id) {
  return callPayrollService(`/internal/v1/payroll/periods/${encodeURIComponent(id)}`);
}

function createPayrollPeriod(month, createdBy) {
  return callPayrollService('/internal/v1/payroll/periods', {
    method: 'POST',
    body: { month, created_by: createdBy },
  });
}

function payrollPayslips(periodId, employeeId) {
  const query = employeeId ? `?employee_id=${encodeURIComponent(employeeId)}` : '';
  return callPayrollService(`/internal/v1/payroll/periods/${encodeURIComponent(periodId)}/payslips${query}`);
}

function payrollAdjustments(periodId) {
  return callPayrollService(`/internal/v1/payroll/periods/${encodeURIComponent(periodId)}/adjustments`);
}

function createPayrollAdjustment(periodId, body) {
  return callPayrollService(`/internal/v1/payroll/periods/${encodeURIComponent(periodId)}/adjustments`, {
    method: 'POST',
    body,
  });
}

function deletePayrollAdjustment(periodId, adjustmentId) {
  return callPayrollService(`/internal/v1/payroll/periods/${encodeURIComponent(periodId)}/adjustments/${encodeURIComponent(adjustmentId)}`, {
    method: 'DELETE',
  });
}

function payrollAdvances(employeeId) {
  const query = employeeId ? `?employee_id=${encodeURIComponent(employeeId)}` : '';
  return callPayrollService(`/internal/v1/payroll/advances${query}`);
}

function payrollAdvance(id) {
  return callPayrollService(`/internal/v1/payroll/advances/${encodeURIComponent(id)}`);
}

function createPayrollAdvance(body) {
  return callPayrollService('/internal/v1/payroll/advances', { method: 'POST', body });
}

function decidePayrollAdvance(id, body) {
  return callPayrollService(`/internal/v1/payroll/advances/${encodeURIComponent(id)}/decision`, {
    method: 'PUT',
    body,
  });
}

function payrollAdvanceSummary(employeeId, month, excludeRequestId, asOf) {
  const query = new URLSearchParams({ employee_id: String(employeeId), month });
  if (excludeRequestId) query.set('exclude_request_id', String(excludeRequestId));
  if (asOf) query.set('as_of', asOf);
  return callPayrollService(`/internal/v1/payroll/advance-summary?${query}`);
}

function calculatePayrollPeriod(id) {
  return callPayrollService(`/internal/v1/payroll/periods/${encodeURIComponent(id)}/calculate`, { method: 'POST' });
}

function lockPayrollPeriod(id) {
  return callPayrollService(`/internal/v1/payroll/periods/${encodeURIComponent(id)}/lock`, { method: 'POST' });
}

function unlockPayrollPeriod(id) {
  return callPayrollService(`/internal/v1/payroll/periods/${encodeURIComponent(id)}/unlock`, { method: 'POST' });
}

function deletePayrollPeriod(id) {
  return callPayrollService(`/internal/v1/payroll/periods/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

async function isPayrollLocked(month) {
  const result = await callPayrollService(`/internal/v1/payroll/lock-status?month=${encodeURIComponent(month)}`);
  return result.locked;
}

async function hasLockedPayrollInRange(from, to) {
  const query = new URLSearchParams({ from, to });
  const result = await callPayrollService(`/internal/v1/payroll/lock-status?${query}`);
  return result.locked;
}

function payrollDataForEmployee(employeeId) {
  return callPayrollService(`/internal/v1/payroll/employees/${encodeURIComponent(employeeId)}/has-data`);
}

function payrollCost(month, department) {
  const query = new URLSearchParams({ month });
  if (department !== undefined) query.set('department', department);
  return callPayrollService(`/internal/v1/payroll/stats/cost?${query}`);
}

function payrollTrend() {
  return callPayrollService('/internal/v1/payroll/stats/trend');
}

module.exports = {
  callPayrollService,
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
  isPayrollLocked,
  hasLockedPayrollInRange,
  payrollDataForEmployee,
  payrollCost,
  payrollTrend,
};
