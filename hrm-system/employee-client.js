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

module.exports = { callEmployeeService, employeeScopeQuery };
