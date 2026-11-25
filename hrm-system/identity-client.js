const { callService } = require('./service-client');

function callIdentityService(path, options = {}) {
  return callService(path, {
    ...options,
    baseUrl: process.env.IDENTITY_SERVICE_URL || 'http://127.0.0.1:3001',
    timeoutEnv: 'IDENTITY_SERVICE_TIMEOUT_MS',
    serviceName: 'Identity Service',
    passThrough4xx: true,
    passThrough401: path === '/internal/v1/auth/login',
  });
}

async function usersByRoles(roles) {
  const query = encodeURIComponent(roles.join(','));
  return callIdentityService(`/internal/v1/users?roles=${query}`);
}

async function usersByEmails(emails) {
  const unique = [...new Set(emails.map((email) => String(email || '').trim().toLowerCase()).filter(Boolean))];
  if (!unique.length) return [];
  const users = [];
  for (let i = 0; i < unique.length; i += 100) {
    const batch = unique.slice(i, i + 100);
    users.push(...await callIdentityService(`/internal/v1/users?emails=${encodeURIComponent(batch.join(','))}`));
  }
  return users;
}

async function userByEmail(email) {
  const users = await usersByEmails([email]);
  return users[0] || null;
}

module.exports = { callIdentityService, usersByRoles, usersByEmails, userByEmail };
