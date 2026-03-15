/**
 * Unit tests for config file loading paths (deep merge + malformed JSON handling).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

function clearConfigEnv() {
  delete process.env.OUTPUT_MODE;
  delete process.env.OUTPUT_DIR;
  delete process.env.API_URL;
  delete process.env.FHIR_SERVER;
  delete process.env.API_AUTH_HEADER;
  delete process.env.GOOGLE_DRIVE_FOLDER;
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  delete process.env.GOOGLE_REFRESH_TOKEN;
  delete process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  delete process.env.ORG_NAME;
  delete process.env.ORG_ID;
  delete process.env.PUBLIC_URL;
  delete process.env.RECIPIENT;
}

afterEach(() => {
  clearConfigEnv();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('loadConfig file loading branches', () => {
  it('deep merges custom config file into defaults', async () => {
    const customPath = '/tmp/custom-config.json';
    const customJson = JSON.stringify({
      organization: { name: 'From File' },
      output: {
        mode: 'api',
        api: { url: 'https://api.from-file.example.com', headers: { 'X-Source': 'file' } },
      },
      server: { host: '127.0.0.1' },
      verbose: true,
    });

    vi.doMock('node:fs', () => ({
      existsSync: (path) => path === customPath,
      readFileSync: (path) => {
        if (path === customPath) return customJson;
        return '';
      },
    }));

    const { loadConfig } = await import('../config.js');
    const config = loadConfig({ configPath: customPath });

    expect(config.organization.name).toBe('From File');
    expect(config.output.mode).toBe('api');
    expect(config.output.api.url).toBe('https://api.from-file.example.com');
    expect(config.output.api.headers['X-Source']).toBe('file');
    expect(config.output.directory).toBe('./shl-output'); // retained default
    expect(config.server.host).toBe('127.0.0.1');
    expect(config.server.port).toBe(3000); // retained default
    expect(config.verbose).toBe(true);
  });

  it('ignores malformed config JSON and falls back to defaults', async () => {
    const badPath = '/tmp/bad-config.json';

    vi.doMock('node:fs', () => ({
      existsSync: (path) => path === badPath,
      readFileSync: (path) => {
        if (path === badPath) return '{invalid-json';
        return '';
      },
    }));

    const { loadConfig } = await import('../config.js');
    const config = loadConfig({ configPath: badPath });

    expect(config.output.mode).toBe('file');
    expect(config.output.directory).toBe('./shl-output');
    expect(config.server.host).toBe('0.0.0.0');
  });
});
