'use strict';

/**
 * rebalance.js
 *
 * Periodically checks whether the delta-neutral ratio has drifted and
 * adjusts positions to restore the 1:1 spot/short balance.
 *
 * Rebalance is triggered when:
 *   - Hedge ratio deviates more than REBALANCE_THRESHOLD from 1.0
 *   - Funding rate drops below the configured minimum (handled by riskManager)
 *
 * Hedge ratio = |short notional| / spot notional
 *   • Ratio > 1 → short is larger than spot → reduce short (or buy more spot)
 *   • Ratio < 1 → spot is larger than short → increase short (or sell some spot)
 */

require('dotenv').config();
const { getMarketOrderParams, PositionDirection, BASE_PRECISION } = require('@drift-labs/sdk');
const BN          = require('bn.js');
const driftClient = require('./driftClient');
const { state }   = require('./strategy');
const log         = require('./logger');

// Allowed deviation before triggering a rebalance (e.g. 0.05 = 5%)
const REBALANCE_THRESHOLD = parseFloat(process.env.REBALANCE_THRESHOLD || '0.05');

/**
 * Compute the current hedge ratio.
 *
 * @param {number} solPrice – current SOL/USD price
 * @returns {{ hedgeRatio: number, spotNotional: number, shortNotional: number }}
 */
async function computeHedgeRatio(solPrice) {
  const position = await driftClient.getPosition();

  const spotNotional  = state.spotSolAmount * solPrice;
  const shortNotional = position ? Math.abs(position.notionalUsd) : 0;

  const hedgeRatio = spotNotional > 0 ? shortNotional / spotNotional : 0;
  return { hedgeRatio, spotNotional, shortNotional };
}

/**
 * Run a rebalance check.  Adjusts the Drift short if the hedge ratio has
 * drifted outside the acceptable band.
 *
 * @param {number} [positionScale=1] – scale factor from risk manager
 * @returns {Object} rebalance result
 */
async function rebalance(positionScale = 1) {
  if (!state.isActive) {
    log.debug('Rebalance skipped – no active position');
    return { skipped: true, reason: 'no active position' };
  }

  const solPrice = await driftClient.getSolPrice();
  const { hedgeRatio, spotNotional, shortNotional } = await computeHedgeRatio(solPrice);

  log.info('Rebalance check', {
    hedgeRatio: hedgeRatio.toFixed(4),
    spotNotional: spotNotional.toFixed(2),
    shortNotional: shortNotional.toFixed(2),
    threshold: REBALANCE_THRESHOLD,
  });

  const deviation = Math.abs(hedgeRatio - 1);

  if (deviation <= REBALANCE_THRESHOLD) {
    log.info('Hedge ratio within threshold – no rebalance needed', { hedgeRatio });
    return { rebalanced: false, hedgeRatio, deviation };
  }

  log.info('Rebalancing…', { hedgeRatio, deviation, positionScale });

  // Target: short notional === spot notional * positionScale
  const targetShortNotional = spotNotional * positionScale;
  const delta               = targetShortNotional - shortNotional;

  if (Math.abs(delta) < 1) {
    log.debug('Delta too small – skipping rebalance', { delta });
    return { rebalanced: false, hedgeRatio, deviation, reason: 'delta too small' };
  }

  let txSig;
  if (delta > 0) {
    // Need MORE short – open additional short
    log.info('Adding to short position', { additionalNotional: delta });
    txSig = await driftClient.openShort(delta);
    state.shortNotionalUsd += delta;
  } else {
    // Need LESS short – close part of the short by placing a reduce-only long
    const reduceAmount = Math.abs(delta);
    log.info('Reducing short position', { reduceAmount });
    const baseAmount = reduceAmount / solPrice;
    const orderParams = getMarketOrderParams({
      marketIndex:     0, // SOL-PERP
      direction:       PositionDirection.LONG,
      baseAssetAmount: new BN(Math.floor(baseAmount * BASE_PRECISION.toNumber())),
      reduceOnly:      true,
    });
    txSig = await driftClient.client.placePerpOrder(orderParams);
    state.shortNotionalUsd = Math.max(0, state.shortNotionalUsd - reduceAmount);
  }

  log.info('Rebalance complete', {
    previousShortNotional: shortNotional,
    newShortNotional:      state.shortNotionalUsd,
    delta,
    txSig,
  });

  return {
    rebalanced:     true,
    hedgeRatio,
    deviation,
    delta,
    txSig,
  };
}

module.exports = { rebalance, computeHedgeRatio };
