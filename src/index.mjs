import { loadConfig } from './config.mjs';
import { initDataDirectories, healthCheck } from './init.mjs';
import { logger, setLogLevel } from './logger.mjs';
import { getProjectRoot } from './paths.mjs';

/**
 * Minimal application entry point.
 * Loads config, initializes data dirs, runs health check, exits.
 * Supports --check flag for validation-only mode.
 */

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');

async function main() {
  try {
    logger.info('NEXORA / FabInvests foundation starting', { root: getProjectRoot() });

    const config = loadConfig();
    logger.info('Configuration loaded and validated', {
      mode: config.project.mode,
      loopSeconds: config.runtime.loopSeconds,
      dashboardPort: config.runtime.dashboardPort,
      capital: config.capital.initialVirtualCapital,
    });

    if (process.env.FABINVESTS_LOG_LEVEL) {
      setLogLevel(process.env.FABINVESTS_LOG_LEVEL);
    }

    const initResult = initDataDirectories();
    const health = healthCheck(config);

    logger.info('Health check', health);

    if (!health.ok) {
      logger.error('Health check failed — exiting');
      process.exit(1);
    }

    if (checkOnly) {
      logger.info('Check-only mode complete — exiting 0');
      process.exit(0);
    }

    logger.info('Foundation initialization complete. Paper trading only. Ready for future phases.');
    process.exit(0);
  } catch (err) {
    logger.errorObj('Startup failed', err);
    process.exit(1);
  }
}

main();
