import { beforeEach, describe, expect, it, vi } from 'vitest';

function makeShlQr({
  url = 'https://shl.example/manifest',
  key = Buffer.from(new Uint8Array(32).map((_, i) => i + 1)).toString('base64url'),
  flag = 'U',
  label = 'Test Link',
} = {}) {
  const payload = Buffer.from(
    JSON.stringify({
      url,
      key,
      flag,
      label,
    }),
    'utf-8',
  ).toString('base64url');
  return `shlink:/${payload}`;
}

async function loadScannerRuntime(fetchMock) {
  const bundleJson = JSON.stringify({ resourceType: 'Bundle', entry: [] });
  globalThis.window = {
    jose: {
      compactDecrypt: vi.fn(async () => ({
        plaintext: new TextEncoder().encode(bundleJson),
        protectedHeader: { cty: 'application/fhir+json' },
      })),
    },
    pako: {
      inflateRaw: vi.fn((input) => input),
    },
  };
  globalThis.pako = globalThis.window.pako;
  globalThis.fetch = fetchMock;
  globalThis.AbortSignal = { timeout: vi.fn(() => undefined) };

  // Import the real browser runtime file so coverage attribution is accurate.
  await import('../public/js/shl-client.js');
  return globalThis.window;
}

describe('core scanner runtime', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('returns not_shl for non-SHL QR text', async () => {
    const runtime = await loadScannerRuntime(vi.fn());
    const result = await runtime.processScanCore('hello-world');
    expect(result).toEqual({
      status: 'not_shl',
      message: 'QR code does not contain a SMART Health Link.',
    });
  });

  it('uses direct fetch by default in core mode', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      text: async () => 'ciphertext',
    });
    const runtime = await loadScannerRuntime(fetchMock);

    const result = await runtime.processScanCore(makeShlQr(), { orgName: 'Core Clinic' });

    expect(result.status).toBe('ok');
    expect(result.storageType).toBe('download');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain('https://shl.example/manifest');
    expect(fetchMock.mock.calls[0][0]).toContain('recipient=Core+Clinic');
  });

  it('falls back to proxy when direct fetch fails and proxy URL is configured', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('direct blocked'))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: 200, body: 'ciphertext' }),
      });
    const runtime = await loadScannerRuntime(fetchMock);

    const result = await runtime.processScanCore(makeShlQr(), {
      proxyBaseUrl: 'https://proxy.example/api/shl-proxy',
      orgName: 'Core Clinic',
    });

    expect(result.status).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe('https://proxy.example/api/shl-proxy');
    expect(fetchMock.mock.calls[1][1].method).toBe('POST');
  });

  it('uses direct fetch first in managed scanner mode', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
        text: async () => 'ciphertext',
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: 'success',
          summary: { fhirBundles: 1, pdfs: 0, rawEntries: 0 },
          fhirBundles: [{ resourceType: 'Bundle', entry: [] }],
          pdfs: [],
        }),
      });
    const runtime = await loadScannerRuntime(fetchMock);

    const result = await runtime.processScanClientSide(makeShlQr(), 'demo-org', 'test-token', {
      orgName: 'Demo Clinic',
    });

    expect(result.status).toBe('success');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toContain('https://shl.example/manifest');
    expect(fetchMock.mock.calls[0][0]).toContain('recipient=Demo+Clinic');
    expect(fetchMock.mock.calls[1][0]).toBe('/api/orgs/demo-org/route');
  });
});
