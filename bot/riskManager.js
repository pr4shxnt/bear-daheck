'use strict';

/**
 * riskManager.js
 *
 * Implements the two core risk rules:
 *   1. If annualised funding rate < MIN_FUNDING_RATE → exit trade
 *   2. If annualised volatility > MAX_VOLATILITY_PCT → reduce position size
 *
 * Returns a RiskSignal object consumed by the strategy and rebalancer.
 */

require('dotenv').config();
const log = require('./logger');

const MIN_FUNDING_RATE  = parseFloat(process.env.MIN_FUNDING_RATE  || '0.01');
const MAX_VOLATILITY_PCT = parseFloat(process.env.MAX_VOLATILITY_PCT || '80');

// Number of price samples used for rolling-volatility calculation
const VOL_WINDOW = 20;
const priceHistory = [];

/**
 * @typedef {Object} RiskSignal
 * @property {'ok'|'reduce'|'exit'} action
 * @property {string}  reason
 * @property {number}  fundingRate   – annualised % (positive = longs pay shorts)
 * @property {number}  volatility    – annualised % (rolling std-dev of log returns)
 * @property {number}  positionScale – multiplier to apply to target size (0–1)
 */

/**
 * Record a new SOL price sample for volatility tracking.
 * @param {number} price
 */
function recordPrice(price) {
  priceHistory.push(price);
  if (priceHistory.length > VOL_WINDOW + 1) priceHistory.shift();
}

/**
 * Compute annualised volatility from the stored price history.
 * Uses log returns and assumes ~365 * 24 hourly candles per year.
 * Returns 0 when there is insufficient data.
 */
function computeVolatility() {
  if (priceHistory.length < 2) return 0;

  const logReturns = [];
  for (let i = 1; i < priceHistory.length; i++) {
    logReturns.push(Math.log(priceHistory[i] / priceHistory[i - 1]));
  }

  const mean  = logReturns.reduce((a, b) => a + b, 0) / logReturns.length;
  const variance = logReturns.reduce((acc, r) => acc + (r - mean) ** 2, 0) / logReturns.length;
  const stdDev = Math.sqrt(variance);

  // Annualise assuming hourly candles (365 * 24 periods/year)
  const annualisedVol = stdDev * Math.sqrt(365 * 24) * 100;
  return annualisedVol;
}

/**
 * Evaluate current market conditions and return a risk signal.
 *
 * @param {number} fundingRate  – annualised % (from driftClient.getFundingRate)
 * @param {number} currentPrice – latest SOL/USD price
 * @returns {RiskSignal}
 */
function evaluate(fundingRate, currentPrice) {
  recordPrice(currentPrice);
  const volatility = computeVolatility();

  log.debug('Risk evaluation', { fundingRate, volatility, MIN_FUNDING_RATE, MAX_VOLATILITY_PCT });

  // Rule 1: Exit if funding rate is too low (not worth holding the position)
  if (fundingRate < MIN_FUNDING_RATE) {
    log.warn('Funding rate below threshold – exiting trade', {
      fundingRate,
      threshold: MIN_FUNDING_RATE,
    });
    return {
      action:        'exit',
      reason:        `Funding rate ${fundingRate.toFixed(4)}% < threshold ${MIN_FUNDING_RATE}%`,
      fundingRate,
      volatility,
      positionScale: 0,
    };
  }

  // Rule 2: Reduce position if volatility is elevated
  if (volatility > MAX_VOLATILITY_PCT) {
    // Scale inversely: higher vol → smaller position
    const scale = Math.max(0.25, MAX_VOLATILITY_PCT / volatility);
    log.warn('High volatility detected – reducing position', {
      volatility,
      threshold: MAX_VOLATILITY_PCT,
      scale,
    });
    return {
      action:        'reduce',
      reason:        `Volatility ${volatility.toFixed(2)}% > threshold ${MAX_VOLATILITY_PCT}%`,
      fundingRate,
      volatility,
      positionScale: scale,
    };
  }

  return {
    action:        'ok',
    reason:        'All risk checks passed',
    fundingRate,
    volatility,
    positionScale: 1,
  };
}

/**
 * Clear stored price history.  Primarily used in tests.
 */
function resetHistory() {
  priceHistory.length = 0;
}

module.exports = { evaluate, computeVolatility, recordPrice, resetHistory };
