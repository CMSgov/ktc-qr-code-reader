import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';

const ssrfMocks = vi.hoisted(() => ({
  isPrivateUrl: vi.fn(),
  resolvesToPrivateAddress: vi.fn(),
}));

vi.mock('../ssrf.js', () => ssrfMocks);
vi.mock('pino-http', () => ({
  default: vi.fn(() => (req, _res, next) => {
    req.log = { error: vi.fn(), info: vi.fn() };
    next();
  }),
}));
vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

let app;
let testServer;
let baseUrl;
let startServer;
let stopServer;

async function requestJson(path, init = {}) {
  const url = new URL(`${baseUrl}${path}`);
  const method = init.method || 'GET';
  const headers = init.headers || {};
  const body = init.body || null;

  return await new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method,
        headers,
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          text += chunk;
        });
        res.on('end', () => {
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            json = null;
          }
          resolve({
            response: {
              status: res.statusCode,
              headers: {
                get: (name) => {
                  const value = res.headers[name.toLowerCase()];
                  return Array.isArray(value) ? value[0] : value || null;
                },
              },
            },
            json,
            text,
          });
        });
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  ({ app, startServer, stopServer } = await import('../server.js'));
  testServer = app.listen(0);
  await new Promise((resolve) => testServer.once('listening', resolve));
  const addr = testServer.address();
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

beforeEach(() => {
  vi.restoreAllMocks();
  ssrfMocks.isPrivateUrl.mockReturnValue(false);
  ssrfMocks.resolvesToPrivateAddress.mockResolvedValue(false);
});

afterAll(async () => {
  if (!testServer) return;
  await new Promise((resolve) => testServer.close(resolve));
});

describe('proxy server routes', () => {
  it('returns health response with security headers', async () => {
    const { response, json } = await requestJson('/healthz');
    expect(response.status).toBe(200);
    expect(json).toEqual({ status: 'ok' });
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
  });

  it('rejects proxy request when URL is missing', async () => {
    const { response, json } = await requestJson('/api/shl-proxy', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(400);
    expect(json).toEqual({ error: 'URL is required' });
  });

  it('proxies allowed SHL request and returns response payload', async () => {
    const upstreamBody = JSON.stringify({ manifest: 'ok' });
    global.fetch = vi.fn().mockResolvedValue({
      status: 200,
      headers: new Headers(),
      text: async () => upstreamBody,
    });

    const { response, json } = await requestJson('/api/shl-proxy', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        url: 'https://example.org/shl',
        method: 'GET',
      }),
    });

    expect(response.status).toBe(200);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(json).toEqual({
      status: 200,
      body: upstreamBody,
      parsedBody: { manifest: 'ok' },
    });
  });

  it('returns CORS preflight response for OPTIONS requests', async () => {
    const { response, text } = await requestJson('/api/shl-proxy', {
      method: 'OPTIONS',
      headers: { origin: 'https://example.org' },
    });
    expect(response.status).toBe(204);
    expect(text).toBe('');
    expect(response.headers.get('access-control-allow-methods')).toBe('POST, OPTIONS');
  });

  it('blocks requests to private URLs', async () => {
    ssrfMocks.isPrivateUrl.mockReturnValue(true);
    const { response, json } = await requestJson('/api/shl-proxy', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        url: 'http://127.0.0.1/private',
        method: 'GET',
      }),
    });

    expect(response.status).toBe(403);
    expect(json).toEqual({ error: 'Requests to private/internal addresses are not allowed' });
  });

  it('blocks requests when hostname resolves to private address', async () => {
    ssrfMocks.resolvesToPrivateAddress.mockResolvedValue(true);
    const { response, json } = await requestJson('/api/shl-proxy', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        url: 'https://example.org/shl',
        method: 'GET',
      }),
    });

    expect(response.status).toBe(403);
    expect(json).toEqual({ error: 'Target hostname resolves to private/internal address' });
  });

  it('blocks redirects to private/internal addresses', async () => {
    ssrfMocks.isPrivateUrl.mockImplementation((url) => String(url).includes('127.0.0.1'));
    global.fetch = vi.fn().mockResolvedValue({
      status: 302,
      headers: new Headers({ location: 'http://127.0.0.1/secret' }),
      text: async () => '',
    });

    const { response, json } = await requestJson('/api/shl-proxy', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        url: 'https://example.org/shl',
        method: 'GET',
      }),
    });

    expect(response.status).toBe(403);
    expect(json).toEqual({ error: 'Redirect to private/internal address blocked' });
  });

  it('returns 502 when upstream redirects too many times', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      status: 302,
      headers: new Headers({ location: '/next' }),
      text: async () => '',
    });

    const { response, json } = await requestJson('/api/shl-proxy', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        url: 'https://example.org/shl',
        method: 'GET',
      }),
    });

    expect(response.status).toBe(502);
    expect(json).toEqual({ error: 'Too many redirects from SHL server' });
    expect(global.fetch).toHaveBeenCalledTimes(4);
  });

  it('returns 502 when upstream fetch throws', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('network down'));

    const { response, json } = await requestJson('/api/shl-proxy', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        url: 'https://example.org/shl',
        method: 'GET',
      }),
    });

    expect(response.status).toBe(502);
    expect(json.error).toContain('Failed to reach SHL server: network down');
  });
});

describe('proxy server lifecycle', () => {
  it('startServer is idempotent and stopServer closes it', async () => {
    const started = startServer(0);
    await new Promise((resolve) => started.once('listening', resolve));
    const startedAgain = startServer(0);
    expect(startedAgain).toBe(started);

    await stopServer();
    await stopServer();
  });
});
