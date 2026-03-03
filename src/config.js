import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const DEFAULTS = {
  recipient: 'Killtheclipboard',
  organization: {
    name: null,
    id: null,
  },
  output: {
    mode: 'file',
    directory: './shl-output',
    api: {
      url: null,
      headers: {},
    },
    drive: {
      folderId: null,
      clientId: null,
      clientSecret: null,
      refreshToken: null,
      redirectUri: null,
      serviceAccountKey: null,
    },
  },
  processing: {
    pdfScanScale: 2.0,
    pdfMaxPages: 10,
    maxDecompressedSize: 5_000_000,
  },
  server: {
    port: 3000,
    host: '0.0.0.0',
    publicUrl: null,
  },
  verbose: false,
};

function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(target[key] || {}, source[key]);
    } else if (source[key] !== undefined) {
      result[key] = source[key];
    }
  }
  return result;
}

function loadJsonFile(path) {
  try {
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, 'utf-8'));
    }
  } catch {
    // Ignore malformed config
  }
  return null;
}

export function loadConfig(cliOverrides = {}) {
  // Config resolution: defaults < global < local < CLI flags
  const globalPath = join(homedir(), '.killtheclipboard', 'config.json');
  const localPath = join(process.cwd(), 'config.json');

  let config = { ...DEFAULTS };

  const globalConfig = loadJsonFile(globalPath);
  if (globalConfig) config = deepMerge(config, globalConfig);

  const localConfig = loadJsonFile(localPath);
  if (localConfig) config = deepMerge(config, localConfig);

  // Apply environment variables (highest priority for deployed environments)
  const env = process.env;
  if (env.OUTPUT_MODE) {
    config.output.mode = env.OUTPUT_MODE;
  }
  if (env.OUTPUT_DIR) {
    config.output.directory = env.OUTPUT_DIR;
  }
  if (env.API_URL) {
    config.output.mode = config.output.mode === 'file' ? 'api' : config.output.mode;
    config.output.api.url = env.API_URL;
  }
  if (env.FHIR_SERVER) {
    config.output.mode = config.output.mode === 'file' ? 'api' : config.output.mode;
    config.output.api.fhirServerBase = env.FHIR_SERVER;
  }
  if (env.API_AUTH_HEADER) {
    config.output.api.headers.Authorization = env.API_AUTH_HEADER;
  }
  if (env.GOOGLE_DRIVE_FOLDER) {
    // Accept full URL or raw folder ID
    const match = env.GOOGLE_DRIVE_FOLDER.match(/\/folders\/([a-zA-Z0-9_-]+)/);
    config.output.drive.folderId = match ? match[1] : env.GOOGLE_DRIVE_FOLDER;
    if (config.output.mode === 'file') config.output.mode = 'drive';
  }
  if (env.GOOGLE_CLIENT_ID) {
    config.output.drive.clientId = env.GOOGLE_CLIENT_ID;
  }
  if (env.GOOGLE_CLIENT_SECRET) {
    config.output.drive.clientSecret = env.GOOGLE_CLIENT_SECRET;
  }
  if (env.GOOGLE_REFRESH_TOKEN) {
    config.output.drive.refreshToken = env.GOOGLE_REFRESH_TOKEN;
  }
  if (env.GOOGLE_SERVICE_ACCOUNT_KEY) {
    config.output.drive.serviceAccountKey = env.GOOGLE_SERVICE_ACCOUNT_KEY;
  }
  if (env.ORG_NAME) {
    config.organization.name = env.ORG_NAME;
  }
  if (env.ORG_ID) {
    config.organization.id = env.ORG_ID;
  }
  if (env.PUBLIC_URL) {
    config.server.publicUrl = env.PUBLIC_URL;
  }
  if (env.RECIPIENT) {
    config.recipient = env.RECIPIENT;
  }

  // Apply CLI overrides
  if (cliOverrides.output) {
    config.output.directory = cliOverrides.output;
  }
  if (cliOverrides.api) {
    config.output.mode = config.output.mode === 'file' ? 'api' : 'both';
    config.output.api.url = cliOverrides.api;
  }
  if (cliOverrides.fhirServer) {
    config.output.api.fhirServerBase = cliOverrides.fhirServer;
  }
  if (cliOverrides.recipient) {
    config.recipient = cliOverrides.recipient;
  }
  if (cliOverrides.passcode) {
    config.passcode = cliOverrides.passcode;
  }
  if (cliOverrides.driveFolder) {
    const match = cliOverrides.driveFolder.match(/\/folders\/([a-zA-Z0-9_-]+)/);
    config.output.drive.folderId = match ? match[1] : cliOverrides.driveFolder;
    if (!['drive', 'all'].includes(config.output.mode)) {
      config.output.mode = config.output.mode === 'file' ? 'drive' : 'all';
    }
  }
  if (cliOverrides.verbose) {
    config.verbose = true;
  }
  if (cliOverrides.configPath) {
    const customConfig = loadJsonFile(cliOverrides.configPath);
    if (customConfig) config = deepMerge(config, customConfig);
  }

  return config;
}
