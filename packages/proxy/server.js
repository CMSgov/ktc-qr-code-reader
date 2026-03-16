/**
 * Minimal CORS proxy for SHL manifest fetches.
 * Encrypted traffic only — the proxy never decrypts; it forwards requests and returns responses.
 * SSRF protection blocks private/internal URLs.
 */
import express from 'express';
import rateLimit from 'express-rate-limit';
import { isPrivateUrl, resolvesToPrivateAddress } from './ssrf.js';

const app = express();
app.use(express.json({ limit: '1mb' }));

const PORT = Number(process.env.PORT) || 3080;
const SHL_PROXY_TIMEOUT_MS = 30_000; // 30s
const MAX_REDIRECTS = 3;

const proxyLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down.' },
});

// CORS: allow browser clients from any origin to POST and read response
function corsMiddleware(req, res, next) {
  const origin = req.headers.origin;
  res.setHeader('Access-Control-Allow-Origin', origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
}
app.use(corsMiddleware);

async function handleShlProxyRequest(req, res) {
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
    console.error('SHL proxy error:', err.message);
    res.status(502).json({ error: `Failed to reach SHL server: ${err.message}` });
  }
}

app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));
app.post('/api/shl-proxy', proxyLimiter, handleShlProxyRequest);

app.listen(PORT, () => {
  console.log(`SHL CORS proxy listening on port ${PORT}`);
});
