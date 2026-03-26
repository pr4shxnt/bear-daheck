'use strict';

/**
 * index.js – Bot entry point
 *
 * Orchestrates:
 *   1. Connect to Drift
 *   2. Run initial strategy cycle (opens the delta-neutral position)
 *   3. Schedule periodic rebalance using node-cron
 *   4. Schedule periodic strategy cycles (funding / risk checks)
 *   5. Start the dashboard HTTP server
 *   6. Handle graceful shutdown
 */

require('dotenv').config();
const cron        = require('node-cron');
const driftClient = require('./driftClient');
const strategy    = require('./strategy');
const { rebalance } = require('./rebalance');
const riskManager = require('./riskManager');
const log         = require('./logger');

const REBALANCE_INTERVAL_HOURS = parseFloat(process.env.REBALANCE_INTERVAL_HOURS || '6');
// Convert hours to a cron expression.
// Note: The `*/N` step syntax only works cleanly for values that divide 24
// (e.g. 1, 2, 3, 4, 6, 8, 12, 24). For other values (e.g. 7) consider
// setting REBALANCE_INTERVAL_HOURS to a divisor of 24.
const rebalanceCron = `0 */${Math.max(1, Math.floor(REBALANCE_INTERVAL_HOURS))} * * *`;

// Strategy cycle: run every 5 minutes to check funding rate + risk
const strategyCron = '*/5 * * * *';

let dashboardServer = null;

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  log.info('========================================');
  log.info('  Bear-DaHeck Delta Neutral Vault Bot   ');
  log.info('========================================');
  log.info('Configuration', {
    vaultSizeUsdc:          process.env.VAULT_SIZE_USDC    || '1000',
    minFundingRate:         process.env.MIN_FUNDING_RATE   || '0.01',
    rebalanceIntervalHours: REBALANCE_INTERVAL_HOURS,
    maxVolatilityPct:       process.env.MAX_VOLATILITY_PCT || '80',
    rpcUrl:                 process.env.RPC_URL            || 'https://api.devnet.solana.com',
    driftEnv:               process.env.DRIFT_ENV          || 'devnet',
  });

  // 1. Connect to Drift
  await driftClient.connect();

  // 2. Initial strategy cycle – open the position (if conditions allow)
  log.info('Running initial strategy cycle…');
  const initialCycle = await strategy.runCycle();
  log.info('Initial cycle result', initialCycle);

  // 3. Schedule strategy cycles (risk + funding rate check) every 5 min
  log.info('Scheduling strategy cycles', { cron: strategyCron });
  cron.schedule(strategyCron, async () => {
    try {
      log.info('─── Strategy cycle ───');
      const result = await strategy.runCycle();
      log.info('Cycle result', result);
    } catch (err) {
      log.error('Strategy cycle failed', { message: err.message, stack: err.stack });
    }
  });

  // 4. Schedule rebalance
  log.info('Scheduling rebalance', { cron: rebalanceCron });
  cron.schedule(rebalanceCron, async () => {
    try {
      log.info('─── Rebalancing… ───');
      const solPrice    = await driftClient.getSolPrice();
      const fundingRate = await driftClient.getFundingRate();
      const riskSignal  = riskManager.evaluate(fundingRate, solPrice);

      const result = await rebalance(riskSignal.positionScale);
      log.info('Rebalance result', result);
    } catch (err) {
      log.error('Rebalance failed', { message: err.message, stack: err.stack });
    }
  });

  // 5. Start dashboard server
  try {
    dashboardServer = require('../dashboard/server');
    log.info('Dashboard server started', {
      port: process.env.DASHBOARD_PORT || 3000,
    });
  } catch (err) {
    log.warn('Dashboard server failed to start', { message: err.message });
  }

  log.info('Bot is running. Press Ctrl+C to stop.');
}

// ─── Graceful shutdown ──────────────────────────────────────────────────────

async function shutdown(signal) {
  log.info(`Received ${signal} – shutting down gracefully…`);

  try {
    if (strategy.state.isActive) {
      log.info('Closing open position before shutdown…');
      await strategy.closePosition();
    }
    await driftClient.disconnect();
  } catch (err) {
    log.error('Error during shutdown', { message: err.message });
  }

  if (dashboardServer && typeof dashboardServer.close === 'function') {
    dashboardServer.close();
  }

  process.exit(0);
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

main().catch((err) => {
  log.error('Fatal error in main', { message: err.message, stack: err.stack });
  process.exit(1);
});
