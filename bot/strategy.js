'use strict';

/**
 * strategy.js
 *
 * Delta-Neutral Strategy: SOL Spot Long + SOL-PERP Short
 *
 * Execution flow:
 *   1. Receive VAULT_SIZE_USDC
 *   2. ~50% → buy SOL spot  (tracked as spotSolAmount)
 *   3. ~50% → open SOL-PERP short on Drift
 *   4. Collect funding fees from the short
 *
 * The spot buy is executed via Jupiter aggregator (or, in devnet / test mode,
 * simply recorded in state so the rest of the logic can run without a live
 * Jupiter quote). Replace _buySpotSol with a real Jupiter call for mainnet.
 */

require('dotenv').config();
const driftClient = require('./driftClient');
const riskManager = require('./riskManager');
const log         = require('./logger');

const VAULT_SIZE_USDC  = parseFloat(process.env.VAULT_SIZE_USDC  || '1000');
const MS_PER_DAY       = 86_400_000;

/**
 * In-memory state – persisted between rebalance cycles within the same
 * process. For production you would store this in a database.
 */
const state = {
  isActive:        false,
  entryTime:       null,
  spotSolAmount:   0,       // SOL held spot
  spotEntryPrice:  0,       // USD price when spot was bought
  shortNotionalUsd: 0,      // Target short notional in USD
  totalFundingEarned: 0,    // Accumulated funding PnL
  trades: [],               // Trade log
};

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Record a trade event in the in-memory log.
 */
function _logTrade(type, details) {
  const trade = { ts: new Date().toISOString(), type, ...details };
  state.trades.push(trade);
  log.info('Trade', trade);
}

/**
 * Simulate buying SOL spot.
 * In production replace with a real Jupiter swap.
 *
 * @param {number} usdcAmount
 * @param {number} solPrice
 * @returns {number} SOL received
 */
function _buySpotSol(usdcAmount, solPrice) {
  // Assume 0.1% slippage on devnet
  const slippage  = 0.001;
  const solAmount = (usdcAmount / solPrice) * (1 - slippage);
  _logTrade('SPOT_BUY', { usdcAmount, solPrice, solAmount });
  return solAmount;
}

/**
 * Simulate selling SOL spot back to USDC.
 *
 * @param {number} solAmount
 * @param {number} solPrice
 * @returns {number} USDC received
 */
function _sellSpotSol(solAmount, solPrice) {
  const slippage   = 0.001;
  const usdcAmount = solAmount * solPrice * (1 - slippage);
  _logTrade('SPOT_SELL', { solAmount, solPrice, usdcAmount });
  return usdcAmount;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Open the delta-neutral position.
 * Called once at bot startup (or after an exit triggered by risk rules).
 *
 * @param {number} [scale=1] – position scale factor from risk manager (0–1)
 */
async function openPosition(scale = 1) {
  if (state.isActive) {
    log.warn('Position already open – skipping openPosition');
    return;
  }

  const effectiveSize = VAULT_SIZE_USDC * scale;
  const halfSize      = effectiveSize / 2;

  log.info('Opening delta-neutral position', {
    vaultSizeUsdc: VAULT_SIZE_USDC,
    effectiveSize,
    halfSize,
  });

  const solPrice = await driftClient.getSolPrice();

  // 1. Buy SOL spot
  state.spotSolAmount  = _buySpotSol(halfSize, solPrice);
  state.spotEntryPrice = solPrice;

  // 2. Open Drift short
  const txSig = await driftClient.openShort(halfSize);
  state.shortNotionalUsd = halfSize;

  _logTrade('OPEN_SHORT', { notionalUsd: halfSize, solPrice, txSig });

  state.isActive  = true;
  state.entryTime = new Date().toISOString();

  log.info('Delta-neutral position opened', {
    spotSol:        state.spotSolAmount,
    shortNotional:  state.shortNotionalUsd,
    solPrice,
  });
}

/**
 * Close the delta-neutral position entirely.
 */
async function closePosition() {
  if (!state.isActive) {
    log.warn('No active position – skipping closePosition');
    return;
  }

  log.info('Closing delta-neutral position');

  const solPrice = await driftClient.getSolPrice();

  // 1. Close Drift short
  const txSig = await driftClient.closeShort();
  _logTrade('CLOSE_SHORT', { solPrice, txSig });

  // 2. Sell spot SOL
  const usdcReceived = _sellSpotSol(state.spotSolAmount, solPrice);

  // 3. Capture funding PnL
  const fundingPnl = await driftClient.getFundingPnl();
  state.totalFundingEarned += fundingPnl;

  _logTrade('POSITION_CLOSED', {
    spotSolAmount:   state.spotSolAmount,
    solPrice,
    usdcReceived,
    fundingPnl,
    totalFundingEarned: state.totalFundingEarned,
  });

  state.isActive         = false;
  state.spotSolAmount    = 0;
  state.shortNotionalUsd = 0;
}

/**
 * Run a single strategy cycle:
 *   - fetch price + funding rate
 *   - evaluate risk
 *   - open / hold / exit accordingly
 *
 * @returns {Object} cycle summary
 */
async function runCycle() {
  const solPrice    = await driftClient.getSolPrice();
  const fundingRate = await driftClient.getFundingRate();
  const riskSignal  = riskManager.evaluate(fundingRate, solPrice);

  log.info('Strategy cycle', { solPrice, fundingRate, riskSignal });

  if (riskSignal.action === 'exit') {
    if (state.isActive) await closePosition();
    return { action: 'exit', riskSignal, solPrice, fundingRate };
  }

  if (!state.isActive) {
    await openPosition(riskSignal.positionScale);
    return { action: 'opened', riskSignal, solPrice, fundingRate };
  }

  // Position is already open and risk is ok / reduce – rebalancing handled
  // separately by rebalance.js.
  return { action: 'hold', riskSignal, solPrice, fundingRate };
}

/**
 * Return a snapshot of current strategy state (used by dashboard).
 */
async function getSnapshot() {
  const position    = await driftClient.getPosition();
  const fundingPnl  = state.isActive ? await driftClient.getFundingPnl() : 0;
  const solPrice    = state.isActive ? await driftClient.getSolPrice()   : 0;
  const fundingRate = state.isActive ? await driftClient.getFundingRate() : 0;

  // Rough APY: (fundingEarned / (VAULT_SIZE_USDC * 0.5)) * (365 / daysElapsed) * 100
  let apyEstimate = 0;
  if (state.entryTime && state.totalFundingEarned > 0) {
    const daysElapsed = (Date.now() - new Date(state.entryTime).getTime()) / MS_PER_DAY;
    if (daysElapsed > 0) {
      apyEstimate = (state.totalFundingEarned / (VAULT_SIZE_USDC / 2)) * (365 / daysElapsed) * 100;
    }
  }

  const spotPnl = state.isActive
    ? (solPrice - state.spotEntryPrice) * state.spotSolAmount
    : 0;

  return {
    isActive:           state.isActive,
    entryTime:          state.entryTime,
    solPrice,
    fundingRate,
    spotSolAmount:      state.spotSolAmount,
    shortNotionalUsd:   state.shortNotionalUsd,
    perpPosition:       position,
    fundingPnl,
    spotPnl,
    totalPnl:           spotPnl + fundingPnl,
    totalFundingEarned: state.totalFundingEarned,
    apyEstimate,
    recentTrades:       state.trades.slice(-10),
  };
}

module.exports = { openPosition, closePosition, runCycle, getSnapshot, state };
