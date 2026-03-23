import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const dbMocks = vi.hoisted(() => ({
  initDb: vi.fn(),
  getDb: vi.fn(),
  getOrgBySlug: vi.fn(),
  getDecryptedToken: vi.fn(),
  prepareTokenForStorage: vi.fn(),
  updateOrgSettings: vi.fn(),
  logAuditEvent: vi.fn(),
}));

const authMocks = vi.hoisted(() => ({
  authMiddleware: vi.fn(() => (_req, _res, next) => next()),
}));

const validatorMocks = vi.hoisted(() => ({
  validateFhirBundles: vi.fn(() => ({ valid: true, errors: [] })),
}));

const connectorMocks = vi.hoisted(() => ({
  uploadToDrive: vi.fn(),
  uploadToOnedrive: vi.fn(),
  uploadToBox: vi.fn(),
  sendEmail: vi.fn(),
  sendViaGmail: vi.fn(),
  sendViaOutlook: vi.fn(),
  postToApi: vi.fn(),
}));

vi.mock('pino-http', () => ({
  default: vi.fn(() => (req, _res, next) => {
    req.log = { error: vi.fn(), info: vi.fn() };
    next();
  }),
}));
vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));
vi.mock('../db.js', () => dbMocks);
vi.mock('../auth.js', () => authMocks);
vi.mock('../config.js', () => ({
  loadConfig: vi.fn(() => ({
    server: { port: 3090 },
    output: { drive: { clientId: null, clientSecret: null } },
  })),
}));
vi.mock('../lib/fhir-validator.js', () => validatorMocks);
vi.mock('../connectors/google-drive.js', () => ({ uploadToDrive: connectorMocks.uploadToDrive }));
vi.mock('../connectors/onedrive.js', () => ({ uploadToOnedrive: connectorMocks.uploadToOnedrive }));
vi.mock('../connectors/box.js', () => ({ uploadToBox: connectorMocks.uploadToBox }));
vi.mock('../connectors/email-sender.js', () => ({ sendEmail: connectorMocks.sendEmail }));
vi.mock('../connectors/gmail.js', () => ({ sendViaGmail: connectorMocks.sendViaGmail }));
vi.mock('../connectors/outlook.js', () => ({ sendViaOutlook: connectorMocks.sendViaOutlook }));
vi.mock('../connectors/api-poster.js', () => ({ postToApi: connectorMocks.postToApi }));

let app;
let testServer;
let baseUrl;

async function requestJson(path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, init);
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { response, json, text };
}

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.SESSION_SECRET = '12345678901234567890123456789012';
  ({ app } = await import('../server.js'));
  testServer = app.listen(0);
  await new Promise((resolve) => testServer.once('listening', resolve));
  const addr = testServer.address();
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.getDb.mockReturnValue({
    prepare: vi.fn(() => ({ get: vi.fn(() => 1) })),
  });
  dbMocks.getOrgBySlug.mockReturnValue({
    id: 'org-1',
    slug: 'acme',
    storage_type: 'api',
    save_format: 'both',
    api_url: 'https://api.example.com/intake',
    api_headers: '{"X-Test":"1"}',
    email_to: null,
  });
  connectorMocks.postToApi.mockResolvedValue({ posted: true });
});

afterAll(async () => {
  if (!testServer) return;
  await new Promise((resolve) => testServer.close(resolve));
});

describe('sidecar server routes', () => {
  it('reports health when database check succeeds', async () => {
    const { response, json } = await requestJson('/healthz');
    expect(response.status).toBe(200);
    expect(json).toEqual({ status: 'ok', checks: { database: 'ok' } });
  });

  it('returns validation error for malformed route request payload', async () => {
    const { response, json } = await requestJson('/api/orgs/acme/route', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-token' },
      body: JSON.stringify({ pdfs: 'not-an-array' }),
    });
    expect(response.status).toBe(400);
    expect(json.status).toBe('validation_failed');
    expect(json.error).toContain('pdfs must be an array');
  });

  it('returns not found when organization slug does not exist', async () => {
    dbMocks.getOrgBySlug.mockReturnValueOnce(null);
    const { response, json } = await requestJson('/api/orgs/missing/route', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-token' },
      body: JSON.stringify({ fhirBundles: [], pdfs: [] }),
    });
    expect(response.status).toBe(404);
    expect(json).toEqual({ error: 'Organization not found.' });
  });

  it('routes payload to API storage and returns success summary', async () => {
    const { response, json } = await requestJson('/api/orgs/acme/route', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-token' },
      body: JSON.stringify({
        label: 'test-scan',
        fhirBundles: [{ resourceType: 'Bundle', entry: [] }],
        pdfs: [{ filename: 'record.pdf', dataBase64: Buffer.from('pdf').toString('base64') }],
      }),
    });

    expect(response.status).toBe(200);
    expect(connectorMocks.postToApi).toHaveBeenCalledTimes(1);
    expect(json.status).toBe('success');
    expect(json.storageType).toBe('api');
    expect(json.apiPosted).toBe(true);
    expect(json.summary).toEqual({ fhirBundles: 1, pdfs: 1, rawEntries: 0 });
    expect(dbMocks.logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        orgSlug: 'acme',
        eventType: 'scan_route',
        storageType: 'api',
        success: true,
      }),
    );
  });
});
