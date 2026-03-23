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
  ({ app } = await import('../server.js'));
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
});
