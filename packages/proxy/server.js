/**
 * Minimal CORS proxy for SHL manifest fetches.
 * Encrypted traffic only — the proxy never decrypts; it forwards requests and returns responses.
 * SSRF protection blocks private/internal URLs.
 */
import express from 'express';
import { randomUUID } from 'node:crypto';
import rateLimit from 'express-rate-limit';
import pinoHttp from 'pino-http';
import { isPrivateUrl, resolvesToPrivateAddress } from './ssrf.js';
import { logger } from './lib/logger.js';

const app = express();
app.set('trust proxy', Number(process.env.TRUST_PROXY ?? 1));
app.use(express.json({ limit: '1mb' }));

const PORT = Number(process.env.PORT) || 3080;
const SHL_PROXY_TIMEOUT_MS = 30_000; // 30s
const MAX_REDIRECTS = 3;
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',')
      .map((o) => o.trim())
      .filter(Boolean)
  : null;

// --- Crash handlers (set up early to catch startup errors) ---
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'uncaught exception');
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  logger.fatal({ error: String(reason) }, 'unhandled rejection');
  process.exit(1);
});

// --- Security headers ---
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '0');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

// --- Middleware ---
app.use(
  pinoHttp({
    logger,
    genReqId: (req, res) => {
      const id = req.headers['x-request-id'] || randomUUID();
      res.setHeader('X-Request-Id', id);
      return id;
    },
    serializers: {
      req: (req) => ({ id: req.id, method: req.method, url: req.url }),
      res: (res) => ({ statusCode: res.statusCode }),
    },
  }),
);

const proxyLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down.' },
});

function corsMiddleware(req, res, next) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS) {
    if (origin && ALLOWED_ORIGINS.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
  } else {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
}
app.use(corsMiddleware);

export async function handleShlProxyRequest(req, res) {
  const { url, method = 'GET', body = null, headers = {} } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  if (isPrivateUrl(url)) {
    return res
      .status(403)
      .json({ error: 'Requests to private/internal addresses are not allowed' });
  }
  if (await resolvesToPrivateAddress(url)) {
    return res.status(403).json({ error: 'Target hostname resolves to private/internal address' });
  }

  try {
    const fetchOptions = {
      method: method.toUpperCase(),
      headers: {},
      redirect: 'manual',
    };

    const safeHeaders = ['content-type', 'accept'];
    for (const [key, value] of Object.entries(headers)) {
      if (safeHeaders.includes(key.toLowerCase())) {
        fetchOptions.headers[key] = value;
      }
    }

    if (body && ['POST', 'PUT'].includes(fetchOptions.method)) {
      fetchOptions.body = typeof body === 'string' ? body : JSON.stringify(body);
      if (!fetchOptions.headers['Content-Type'] && !fetchOptions.headers['content-type']) {
        fetchOptions.headers['Content-Type'] = 'application/json';
      }
    }

    fetchOptions.signal = AbortSignal.timeout(SHL_PROXY_TIMEOUT_MS);

    let currentUrl = url;
    let proxyResp = await fetch(currentUrl, fetchOptions);

    let redirectCount = 0;
    while (proxyResp.status >= 300 && proxyResp.status < 400 && redirectCount < MAX_REDIRECTS) {
      const location = proxyResp.headers.get('location');
      if (!location) break;

      const redirectUrl = new URL(location, currentUrl).toString();
      if (isPrivateUrl(redirectUrl)) {
        return res.status(403).json({ error: 'Redirect to private/internal address blocked' });
      }
      if (await resolvesToPrivateAddress(redirectUrl)) {
        return res
          .status(403)
          .json({ error: 'Redirect target resolves to private/internal address' });
      }

      currentUrl = redirectUrl;
      proxyResp = await fetch(currentUrl, { ...fetchOptions, method: 'GET' });
      redirectCount++;
    }

    if (redirectCount >= MAX_REDIRECTS) {
      return res.status(502).json({ error: 'Too many redirects from SHL server' });
    }

    const responseText = await proxyResp.text();

    let parsedBody = null;
    try {
      parsedBody = JSON.parse(responseText);
    } catch {
      // Not JSON — e.g. JWE string
    }

    res.json({
      status: proxyResp.status,
      body: responseText,
      parsedBody,
    });
  } catch (err) {
    req.log.error({ err }, 'SHL proxy error');
    res.status(502).json({ error: `Failed to reach SHL server: ${err.message}` });
  }
}

// --- Routes ---
app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));
app.post('/api/shl-proxy', proxyLimiter, handleShlProxyRequest);

// --- Global error handler ---
app.use((err, req, res, _next) => {
  req.log?.error({ err }, 'unhandled error');
  if (!res.headersSent) {
    res.status(500).json({ error: 'Internal server error', requestId: req.id });
  }
});

// --- Start server ---
let server = null;
export function startServer(port = PORT) {
  if (server) return server;
  server = app.listen(port, () => {
    logger.info({ port }, 'SHL CORS proxy started');
  });
  return server;
}

export async function stopServer() {
  if (!server) return;
  await new Promise((resolve) => server.close(resolve));
  server = null;
}

// --- Graceful shutdown ---
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutdown signal received');
  if (!server) {
    process.exit(0);
  }
  server.close(() => {
    logger.info('HTTP server closed');
    process.exit(0);
  });
  setTimeout(() => {
    logger.error('graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

if (process.env.NODE_ENV !== 'test') {
  startServer();
}

export { app };
