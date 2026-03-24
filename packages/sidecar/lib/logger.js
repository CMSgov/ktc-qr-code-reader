/**
 * Structured JSON logger backed by pino.
 * Outputs one JSON object per line to stdout — ready for Grafana Cloud / Loki ingestion.
 *
 * Set LOG_LEVEL env var to control verbosity: trace | debug | info (default) | warn | error | fatal
 */
import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label }),
  },
  redact: {
    paths: ['req.headers.authorization', 'req.headers.cookie'],
    censor: '[REDACTED]',
  },
});
