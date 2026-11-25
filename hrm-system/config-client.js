const { callService } = require('./service-client');

function callConfigService(path, options = {}) {
  return callService(path, {
    ...options,
    baseUrl: process.env.CONFIG_SERVICE_URL || 'http://127.0.0.1:3300',
    timeoutEnv: 'CONFIG_SERVICE_TIMEOUT_MS',
    serviceName: 'Config Service',
    passThrough4xx: true,
  });
}

module.exports = { callConfigService };
