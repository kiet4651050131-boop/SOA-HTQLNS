class ServiceUnavailableError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = 'ServiceUnavailableError';
    this.statusCode = 503;
    this.code = 'DEPENDENCY_UNAVAILABLE';
  }
}

class ServiceResponseError extends Error {
  constructor(statusCode, message, payload) {
    super(message);
    this.name = 'ServiceResponseError';
    this.statusCode = statusCode;
    this.code = payload && typeof payload.code === 'string' ? payload.code : undefined;
  }
}

async function callService(path, options = {}) {
  const method = options.method || 'GET';
  const baseUrl = options.baseUrl || process.env.EMAIL_SERVICE_URL || 'http://127.0.0.1:3200';
  const serviceUrl = new URL(path, baseUrl);
  const timeoutEnv = options.timeoutEnv || 'NOTIFICATION_SERVICE_TIMEOUT_MS';
  const timeoutMs = Number(process.env[timeoutEnv] || 3000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error(`${timeoutEnv} must be a positive integer`);
  }
  const serviceName = options.serviceName || 'Notification Service';
  const token = process.env.INTERNAL_SERVICE_TOKEN
    || (process.env.NODE_ENV === 'production' ? '' : 'dev-only-internal-service-token');
  const attempts = method === 'GET' ? 3 : 1;
  let lastError;

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetch(serviceUrl, {
        method,
        headers: {
          ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
          'X-Internal-Service-Token': token,
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const payload = await response.json().catch(() => null);
      if (response.ok) return payload;
      const serviceMessage = payload && (payload.message || payload.error);
      lastError = new Error(`${serviceName} returned HTTP ${response.status}`);
      if (options.passThrough4xx && response.status >= 400 && response.status < 500
        && (response.status !== 401 || options.passThrough401)) {
        throw new ServiceResponseError(response.status, Array.isArray(serviceMessage)
          ? serviceMessage.join(', ')
          : (serviceMessage || `${serviceName} rejected the request`), payload);
      }
      if (response.status < 500 || attempt === attempts - 1) {
        throw new ServiceUnavailableError(`${serviceName} hiện không khả dụng`, lastError);
      }
    } catch (error) {
      if (error instanceof ServiceUnavailableError || error instanceof ServiceResponseError) throw error;
      lastError = error;
      if (attempt === attempts - 1) {
        throw new ServiceUnavailableError(`${serviceName} hiện không khả dụng`, lastError);
      }
    }
  }

  throw new ServiceUnavailableError(`${serviceName} hiện không khả dụng`, lastError);
}

function publishServiceEvent(path, body) {
  callService(path, { method: 'POST', body }).catch((error) => {
    console.error(`Không gửi được sự kiện tới Notification Service: ${error.message}`);
  });
}

module.exports = { callService, publishServiceEvent, ServiceUnavailableError, ServiceResponseError };
