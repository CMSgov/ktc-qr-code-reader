import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const DEFAULTS = {
  recipient: 'Killtheclipboard',
  organization: { name: null, id: null },
  output: {
    mode: 'file',
    directory: './shl-output',
    api: { url: null, headers: {} },
    drive: {
      folderId: null,
      clientId: null,
      clientSecret: null,
      refreshToken: null,
      redirectUri: null,
      serviceAccountKey: null,
    },
  },
  processing: { pdfScanScale: 2.0, pdfMaxPages: 10, maxDecompressedSize: 5_000_000 },
  server: { port: 3090, host: '0.0.0.0', publicUrl: null },
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
    if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {}
  return null;
}

export function loadConfig(cliOverrides = {}) {
  const globalPath = join(homedir(), '.killtheclipboard', 'config.json');
  const localPath = join(process.cwd(), 'config.json');
  let config = { ...DEFAULTS };
  const globalConfig = loadJsonFile(globalPath);
  if (globalConfig) config = deepMerge(config, globalConfig);
  const localConfig = loadJsonFile(localPath);
  if (localConfig) config = deepMerge(config, localConfig);

  const env = process.env;
  if (env.API_URL) {
    config.output.api.url = env.API_URL;
  }
  if (env.API_AUTH_HEADER) config.output.api.headers.Authorization = env.API_AUTH_HEADER;
  if (env.GOOGLE_DRIVE_FOLDER) {
    const match = env.GOOGLE_DRIVE_FOLDER.match(/\/folders\/([a-zA-Z0-9_-]+)/);
    config.output.drive.folderId = match ? match[1] : env.GOOGLE_DRIVE_FOLDER;
  }
  if (env.GOOGLE_CLIENT_ID) config.output.drive.clientId = env.GOOGLE_CLIENT_ID;
  if (env.GOOGLE_CLIENT_SECRET) config.output.drive.clientSecret = env.GOOGLE_CLIENT_SECRET;
  if (env.GOOGLE_REFRESH_TOKEN) config.output.drive.refreshToken = env.GOOGLE_REFRESH_TOKEN;
  if (env.PUBLIC_URL) config.server.publicUrl = env.PUBLIC_URL;
  if (env.RECIPIENT) config.recipient = env.RECIPIENT;

  if (cliOverrides.verbose) config.verbose = true;
  if (cliOverrides.configPath) {
    const customConfig = loadJsonFile(cliOverrides.configPath);
    if (customConfig) config = deepMerge(config, customConfig);
  }
  return config;
}
