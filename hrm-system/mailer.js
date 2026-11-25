function getMailConfig() {
  const appUrl = String(process.env.APP_URL || '').replace(/\/+$/, '');
  if (!appUrl) return null;
  let url;
  try { url = new URL(appUrl); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
  const localHost = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && localHost)) return null;
  return { appUrl };
}

async function sendEmail(_config, message) {
  const serviceUrl = new URL(process.env.EMAIL_SERVICE_URL || 'http://127.0.0.1:3200');
  if (!['http:', 'https:'].includes(serviceUrl.protocol) || serviceUrl.username || serviceUrl.password) {
    throw new Error('EMAIL_SERVICE_URL must be an HTTP(S) URL without credentials');
  }
  const timeoutMs = Number(process.env.EMAIL_SERVICE_TIMEOUT_MS || 20000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error('EMAIL_SERVICE_TIMEOUT_MS must be a positive integer');
  const response = await fetch(new URL('/internal/v1/email', serviceUrl), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Service-Token': process.env.INTERNAL_SERVICE_TOKEN
        || (process.env.NODE_ENV === 'production' ? '' : 'dev-only-internal-service-token'),
    },
    body: JSON.stringify({
      to: message.to,
      subject: message.subject,
      ...(message.text ? { text: message.text } : {}),
      ...(message.html ? { html: message.html } : {}),
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(result.error || `Email service returned HTTP ${response.status}`);
  }
  return result;
}

let missingConfigReported = false;
function notifyWorkflowEmail(recipients, subject, text) {
  const config = getMailConfig();
  if (!config) {
    if (!missingConfigReported) {
      console.error('Không gửi được email quy trình: cấu hình SMTP hoặc APP_URL chưa đầy đủ.');
      missingConfigReported = true;
    }
    return;
  }
  missingConfigReported = false;
  [...new Set(recipients.map((email) => String(email || '').trim().toLowerCase()).filter(Boolean))]
    .forEach((to) => {
      sendEmail(config, { to, subject, text: `${text}\n\n${config.appUrl}` })
        .catch((error) => console.error(`Không gửi được email quy trình đến ${to}:`, error.message));
    });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

module.exports = { getMailConfig, sendEmail, notifyWorkflowEmail, escapeHtml };
