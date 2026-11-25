import express from 'express';
import type { Request, Response } from 'express';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';

export interface GatewayOptions {
  coreServiceUrl?: string;
  identityServiceUrl?: string;
  internalServiceToken?: string;
  timeoutMs?: number;
  identityTimeoutMs?: number;
  publicDir?: string;
}

interface IdentityUser {
  id: number;
  email: string;
  name: string;
  role: string;
  must_change_password: number;
}

class IdentityRejectedError extends Error {}

export function createGateway(options: GatewayOptions = {}) {
  const coreServiceUrl = options.coreServiceUrl ?? process.env.CORE_SERVICE_URL ?? 'http://127.0.0.1:3100';
  const core = new URL(coreServiceUrl);
  if (core.protocol !== 'http:' && core.protocol !== 'https:') {
    throw new Error('CORE_SERVICE_URL must use HTTP or HTTPS');
  }
  const identityServiceUrl = options.identityServiceUrl ?? process.env.IDENTITY_SERVICE_URL ?? 'http://127.0.0.1:3001';
  const identity = new URL(identityServiceUrl);
  if (identity.protocol !== 'http:' && identity.protocol !== 'https:') {
    throw new Error('IDENTITY_SERVICE_URL must use HTTP or HTTPS');
  }
  const timeoutMs = options.timeoutMs ?? Number(process.env.GATEWAY_TIMEOUT_MS ?? 5000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error('GATEWAY_TIMEOUT_MS must be a positive integer');
  }
  const identityTimeoutMs = options.identityTimeoutMs ?? Number(process.env.IDENTITY_SERVICE_TIMEOUT_MS ?? 3000);
  if (!Number.isInteger(identityTimeoutMs) || identityTimeoutMs < 1) {
    throw new Error('IDENTITY_SERVICE_TIMEOUT_MS must be a positive integer');
  }
  const internalToken = options.internalServiceToken ?? process.env.INTERNAL_SERVICE_TOKEN
    ?? (process.env.NODE_ENV === 'production' ? '' : 'dev-only-internal-service-token');
  if (!internalToken) throw new Error('INTERNAL_SERVICE_TOKEN is required by the API Gateway');

  const identityCache = new Map<string, { expiresAt: number; user: IdentityUser }>();
  const app = express();
  app.disable('x-powered-by');
  const trustedProxy = process.env.GATEWAY_TRUST_PROXY;
  if (trustedProxy) {
    app.set('trust proxy', /^\d+$/.test(trustedProxy) ? Number(trustedProxy) : trustedProxy);
  }
  app.use((_req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
    });
    next();
  });

  function isPublicAuthRoute(req: Request) {
    const route = req.path.replace(/\/+$/, '') || '/';
    return (req.method === 'GET' && route === '/auth/status')
      || (req.method === 'POST' && [
        '/auth/login',
        '/auth/register',
        '/auth/forgot-password',
        '/auth/reset-password',
      ].includes(route));
  }

  function invalidateIdentity(userId: number) {
    for (const [token, cached] of identityCache) {
      if (cached.user.id === userId) identityCache.delete(token);
    }
  }

  async function introspect(token: string): Promise<IdentityUser> {
    const now = Date.now();
    const cached = identityCache.get(token);
    if (cached && cached.expiresAt > now) return cached.user;
    if (cached) identityCache.delete(token);

    const response = await fetch(new URL('/internal/v1/introspect', identity).toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Service-Token': internalToken,
      },
      body: JSON.stringify({ token }),
      signal: AbortSignal.timeout(identityTimeoutMs),
    });
    const result = await response.json().catch(() => null);
    if (response.status === 401) {
      const message = result && (result.message || result.error);
      throw new IdentityRejectedError(Array.isArray(message) ? message.join(', ') : message || 'Phiên đăng nhập hết hạn');
    }
    if (!response.ok) throw new Error(`Identity Service returned HTTP ${response.status}`);
    const user = result as IdentityUser;
    if (!user || !Number.isSafeInteger(user.id) || !user.email || !user.name
      || !['admin', 'hr', 'manager', 'employee'].includes(user.role)
      || ![0, 1].includes(Number(user.must_change_password))) {
      throw new Error('Identity Service returned invalid identity data');
    }
    const validUser = { ...user, must_change_password: Number(user.must_change_password) };
    if (identityCache.size >= 1000) {
      const first = identityCache.keys().next().value;
      if (first) identityCache.delete(first);
    }
    identityCache.set(token, { user: validUser, expiresAt: now + 30000 });
    return validUser;
  }

  async function proxyApi(req: Request, res: Response) {
    let user: IdentityUser | undefined;
    if (!isPublicAuthRoute(req)) {
      const match = /^Bearer (.+)$/.exec(req.headers.authorization || '');
      if (!match) {
        res.status(401).json({ error: 'Chưa đăng nhập' });
        return;
      }
      try {
        user = await introspect(match[1]);
      } catch (error) {
        if (error instanceof IdentityRejectedError) {
          res.status(401).json({ error: error.message });
          return;
        }
        console.error(`Identity Service request failed: ${error instanceof Error ? error.message : String(error)}`);
        res.status(503).json({
          error: 'Dịch vụ xác thực tạm thời không khả dụng',
          code: 'IDENTITY_SERVICE_UNAVAILABLE',
        });
        return;
      }
      const route = req.path.replace(/\/+$/, '') || '/';
      const allowedDuringPasswordChange = (req.method === 'GET' && route === '/auth/me')
        || (req.method === 'POST' && route === '/auth/change-password');
      if (user.must_change_password && !allowedDuringPasswordChange) {
        res.status(403).json({
          error: 'Bạn cần đổi mật khẩu trước khi tiếp tục',
          code: 'PASSWORD_CHANGE_REQUIRED',
        });
        return;
      }
    }

    const headers: http.OutgoingHttpHeaders = {
      ...req.headers,
      host: core.host,
      'x-forwarded-for': req.ip,
    };
    [
      'authorization',
      'x-internal-service-token',
      'x-user-id',
      'x-user-email',
      'x-user-name',
      'x-user-role',
      'x-user-must-change-password',
    ].forEach((header) => { delete headers[header]; });
    headers['x-internal-service-token'] = internalToken;
    if (user) {
      headers['x-user-id'] = String(user.id);
      headers['x-user-email'] = user.email;
      headers['x-user-name'] = user.name;
      headers['x-user-role'] = user.role;
      headers['x-user-must-change-password'] = String(user.must_change_password);
    }

    const transport = core.protocol === 'https:' ? https : http;
    let deadline: ReturnType<typeof setTimeout>;
    const upstream = transport.request({
      hostname: core.hostname,
      port: core.port || undefined,
      method: req.method,
      path: req.originalUrl,
      headers,
    }, (upstreamRes) => {
      res.statusCode = upstreamRes.statusCode ?? 502;
      for (const [name, value] of Object.entries(upstreamRes.headers)) {
        if (value !== undefined && !['connection', 'keep-alive', 'transfer-encoding'].includes(name.toLowerCase())) {
          res.setHeader(name, value);
        }
      }
      upstreamRes.pipe(res);
      upstreamRes.on('end', () => {
        clearTimeout(deadline);
        const statusCode = upstreamRes.statusCode ?? 500;
        if (statusCode < 200 || statusCode >= 300) return;
        const route = req.path.replace(/\/+$/, '') || '/';
        const userMutation = /^\/users\/(\d+)\/(?:role|reset-password)$/.exec(route);
        const deleteUser = /^\/users\/(\d+)$/.exec(route);
        const changesOwnPassword = req.method === 'POST' && route === '/auth/change-password';
        if ((req.method === 'PUT' && userMutation)
          || (req.method === 'POST' && userMutation)
          || (req.method === 'DELETE' && deleteUser)) {
          invalidateIdentity(Number((userMutation || deleteUser)![1]));
        } else if (changesOwnPassword && user) {
          invalidateIdentity(user.id);
        }
      });
      upstreamRes.on('error', (error: Error) => {
        if (!res.destroyed) res.destroy(error);
      });
    });

    deadline = setTimeout(() => {
      upstream.destroy(new Error(`Core service timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    upstream.setTimeout(timeoutMs, () => {
      upstream.destroy(new Error(`Core service timed out after ${timeoutMs}ms`));
    });
    upstream.on('error', (error: Error) => {
      clearTimeout(deadline);
      if (res.headersSent) {
        res.destroy(error);
        return;
      }
      console.error(`Core service request failed: ${error.message}`);
      res.status(503).json({
        error: 'Dịch vụ HRM tạm thời không khả dụng',
        code: 'CORE_SERVICE_UNAVAILABLE',
      });
    });
    req.on('aborted', () => upstream.destroy());
    res.on('close', () => {
      if (!res.writableEnded) upstream.destroy();
    });
    req.pipe(upstream);
  }

  app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'hrm-api-gateway' }));
  app.use('/api', (req: Request, res: Response) => {
    void proxyApi(req, res).catch((error: unknown) => {
      console.error(`API Gateway request failed: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) {
        res.status(503).json({
          error: 'Dịch vụ HRM tạm thời không khả dụng',
          code: 'CORE_SERVICE_UNAVAILABLE',
        });
      }
    });
  });

  app.use('/api', (_req, res) => res.status(404).json({ error: 'Không tìm thấy API' }));
  app.use(express.static(options.publicDir ?? path.join(__dirname, '..', 'public')));
  return app;
}
