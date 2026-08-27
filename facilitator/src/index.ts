import 'dotenv/config';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { logger } from './logger.js';

const config = loadConfig();
const app = createApp({ config, log: logger });
const server = app.listen(config.port, config.host, () => {
  logger.info('facilitator_listening', {
    host: config.host,
    port: config.port,
    network: config.network,
  });
});

function shutdown(signal: string) {
  logger.info('shutdown_started', { signal });
  const forced = setTimeout(() => {
    logger.error('shutdown_timeout', { timeoutMs: config.shutdownTimeoutMs });
    process.exit(1);
  }, config.shutdownTimeoutMs);
  forced.unref();
  server.close(error => {
    clearTimeout(forced);
    if (error) {
      logger.error('shutdown_failed', { reason: error.message });
      process.exit(1);
    }
    logger.info('shutdown_complete');
    process.exit(0);
  });
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
