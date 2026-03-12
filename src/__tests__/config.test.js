/**
 * Unit tests for config (loadConfig with env and CLI overrides). No file I/O; mocks fs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// No config files on disk
vi.mock('node:fs', () => ({
  existsSync: () => false,
  readFileSync: () => {},
}));

const { loadConfig } = await import('../config.js');

describe('loadConfig', () => {
  const envBackup = { ...process.env };

  afterEach(() => {
    process.env = { ...envBackup };
  });

  beforeEach(() => {
    delete process.env.OUTPUT_MODE;
    delete process.env.OUTPUT_DIR;
    delete process.env.PORT;
    delete process.env.API_URL;
    delete process.env.API_AUTH_HEADER;
    delete process.env.FHIR_SERVER;
    delete process.env.GOOGLE_DRIVE_FOLDER;
    delete process.env.ORG_NAME;
    delete process.env.ORG_ID;
    delete process.env.PUBLIC_URL;
    delete process.env.RECIPIENT;
  });

  it('returns defaults when no env or CLI overrides', () => {
    const config = loadConfig();
    expect(config.recipient).toBe('Killtheclipboard');
    expect(config.output.mode).toBe('file');
    expect(config.output.directory).toBe('./shl-output');
    expect(config.server.port).toBe(3000);
    expect(config.server.host).toBe('0.0.0.0');
    expect(config.verbose).toBe(false);
  });

  it('applies OUTPUT_MODE from env', () => {
    process.env.OUTPUT_MODE = 'api';
    const config = loadConfig();
    expect(config.output.mode).toBe('api');
  });

  it('applies OUTPUT_DIR from env', () => {
    process.env.OUTPUT_DIR = '/tmp/out';
    const config = loadConfig();
    expect(config.output.directory).toBe('/tmp/out');
  });

  it('applies API_URL and sets mode to api when current mode is file', () => {
    process.env.API_URL = 'https://api.example.com';
    const config = loadConfig();
    expect(config.output.mode).toBe('api');
    expect(config.output.api.url).toBe('https://api.example.com');
  });

  it('applies GOOGLE_DRIVE_FOLDER as raw folder ID', () => {
    process.env.OUTPUT_MODE = 'file'; // so GOOGLE_DRIVE_FOLDER can set mode to drive
    process.env.GOOGLE_DRIVE_FOLDER = 'folderId123';
    delete process.env.API_URL;
    delete process.env.FHIR_SERVER;
    const config = loadConfig();
    expect(config.output.drive.folderId).toBe('folderId123');
    expect(config.output.mode).toBe('drive');
  });

  it('applies GOOGLE_DRIVE_FOLDER URL and extracts folder ID', () => {
    process.env.GOOGLE_DRIVE_FOLDER = 'https://drive.google.com/drive/folders/abc123xyz';
    const config = loadConfig();
    expect(config.output.drive.folderId).toBe('abc123xyz');
  });

  it('applies ORG_NAME and ORG_ID from env', () => {
    process.env.ORG_NAME = 'Test Org';
    process.env.ORG_ID = 'org-uuid';
    const config = loadConfig();
    expect(config.organization.name).toBe('Test Org');
    expect(config.organization.id).toBe('org-uuid');
  });

  it('applies RECIPIENT and PUBLIC_URL from env', () => {
    process.env.RECIPIENT = 'MyApp';
    process.env.PUBLIC_URL = 'https://example.com';
    const config = loadConfig();
    expect(config.recipient).toBe('MyApp');
    expect(config.server.publicUrl).toBe('https://example.com');
  });

  it('applies CLI overrides (output directory)', () => {
    const config = loadConfig({ output: '/cli/output' });
    expect(config.output.directory).toBe('/cli/output');
  });

  it('applies CLI overrides (api url sets mode to api or both)', () => {
    const config = loadConfig({ api: 'https://cli-api.example.com' });
    expect(config.output.mode).toBe('both');
    expect(config.output.api.url).toBe('https://cli-api.example.com');
  });

  it('applies CLI overrides (driveFolder extracts ID and sets mode)', () => {
    const config = loadConfig({ driveFolder: 'https://drive.google.com/drive/folders/fid999' });
    expect(config.output.drive.folderId).toBe('fid999');
    expect(['drive', 'all']).toContain(config.output.mode);
  });

  it('applies CLI verbose', () => {
    const config = loadConfig({ verbose: true });
    expect(config.verbose).toBe(true);
  });

  it('applies CLI recipient and passcode', () => {
    const config = loadConfig({ recipient: 'CLI Recipient', passcode: 'secret' });
    expect(config.recipient).toBe('CLI Recipient');
    expect(config.passcode).toBe('secret');
  });

  it('applies API_AUTH_HEADER from env', () => {
    process.env.API_AUTH_HEADER = 'Bearer token123';
    const config = loadConfig();
    expect(config.output.api.headers.Authorization).toBe('Bearer token123');
  });

  it('applies FHIR_SERVER and sets mode to api when file', () => {
    process.env.OUTPUT_MODE = 'file';
    process.env.FHIR_SERVER = 'https://fhir.example.com';
    const config = loadConfig();
    expect(config.output.mode).toBe('api');
    expect(config.output.api.fhirServerBase).toBe('https://fhir.example.com');
  });
});
