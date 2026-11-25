const { callService } = require('./service-client');

function callEmployeeService(path, options = {}) {
  return callService(path, {
    ...options,
    baseUrl: process.env.EMPLOYEE_SERVICE_URL || 'http://127.0.0.1:3002',
    timeoutEnv: 'EMPLOYEE_SERVICE_TIMEOUT_MS',
    serviceName: 'Employee Service',
    passThrough4xx: true,
  });
}

function employeeScopeQuery(user) {
  return `scope_email=${encodeURIComponent(user.email)}&scope_role=${encodeURIComponent(user.role)}`;
}

function employeeQuery(filters = {}, user) {
  const query = new URLSearchParams();
  Object.entries(filters).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') query.set(key, String(value));
  });
  if (user) {
    query.set('scope_email', user.email);
    query.set('scope_role', user.role);
  }
  const suffix = query.toString();
  return callEmployeeService(`/internal/v1/employees${suffix ? `?${suffix}` : ''}`);
}

async function employeeById(id, user) {
  if (!user) return callEmployeeService(`/internal/v1/employees/${encodeURIComponent(id)}`);
  const employees = await employeeQuery({ ids: id }, user);
  return employees[0] || null;
}

async function employeeByEmail(email) {
  const employees = await employeeQuery({ email });
  return employees[0] || null;
}

async function employeesByCodes(codes) {
  const unique = [...new Set(codes.map((code) => String(code || '').trim()).filter(Boolean))];
  if (!unique.length) return [];
  const results = [];
  for (let i = 0; i < unique.length; i += 100) {
    results.push(...await employeeQuery({ codes: unique.slice(i, i + 100).join(',') }));
  }
  return results;
}

async function employeesByIds(ids) {
  const unique = [...new Set(ids.map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  if (!unique.length) return [];
  const results = [];
  for (let i = 0; i < unique.length; i += 100) {
    results.push(...await employeeQuery({ ids: unique.slice(i, i + 100).join(',') }));
  }
  return results;
}

async function organization(table) {
  if (table !== 'departments' && table !== 'positions') throw new Error('Invalid organization table');
  return callEmployeeService(`/internal/v1/${table}`);
}

async function recordEmployeeHistory(employee, actor, entity, changes) {
  if (!changes || !Object.keys(changes).length) return;
  await callEmployeeService('/internal/v1/history', {
    method: 'POST',
    body: {
      employee_id: employee.id || null,
      employee_code: employee.code || '',
      employee_name: employee.name || '',
      entity,
      actor_email: actor ? actor.email : '-',
      changes,
    },
  });
}

function employeeHistory(employeeId, user) {
  const query = new URLSearchParams({
    scope_email: user.email,
    scope_role: user.role,
  });
  if (employeeId) query.set('employee_id', String(employeeId));
  return callEmployeeService(`/internal/v1/history?${query.toString()}`);
}

module.exports = {
  callEmployeeService, employeeScopeQuery, employeeQuery, employeeById, employeeByEmail,
  employeesByCodes, employeesByIds, organization, recordEmployeeHistory, employeeHistory,
};
