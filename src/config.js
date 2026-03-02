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
  },
  processing: {
    pdfScanScale: 2.0,
    pdfMaxPages: 10,
    maxDecompressedSize: 5_000_000,
  },
  server: {
    port: 3000,
    host: '0.0.0.0',
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
  if (cliOverrides.verbose) {
    config.verbose = true;
  }
  if (cliOverrides.configPath) {
    const customConfig = loadJsonFile(cliOverrides.configPath);
    if (customConfig) config = deepMerge(config, customConfig);
  }

  return config;
}
