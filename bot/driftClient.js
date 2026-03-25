'use strict';

/**
 * driftClient.js
 *
 * Thin wrapper around the Drift SDK.
 * Exposes only what the strategy needs:
 *   - connect / disconnect
 *   - openShort / closeShort / getPosition
 *   - getFundingRate
 *   - getSolPrice
 */

require('dotenv').config();
const { Connection, Keypair, PublicKey } = require('@solana/web3.js');
const {
  DriftClient,
  User,
  Wallet,
  getMarketOrderParams,
  PositionDirection,
  BulkAccountLoader,
  getDriftStateAccountPublicKey,
  PerpMarkets,
  convertToNumber,
  PRICE_PRECISION,
  BASE_PRECISION,
  QUOTE_PRECISION,
  DriftEnv,
  DRIFT_PROGRAM_ID,
} = require('@drift-labs/sdk');
const fs   = require('fs');
const BN   = require('bn.js');
const log  = require('./logger');

// SOL-PERP market index on Drift
const SOL_PERP_MARKET_INDEX = 0;

class DriftClientWrapper {
  constructor() {
    this.client     = null;
    this.user       = null;
    this.connection = null;
    this.wallet     = null;
  }

  /**
   * Initialise connection to Solana + Drift protocol.
   */
  async connect() {
    const rpcUrl     = process.env.RPC_URL || 'https://api.devnet.solana.com';
    const keypairPath = process.env.KEYPAIR_PATH || './keypair.json';
    const driftEnv   = (process.env.DRIFT_ENV || 'devnet');

    log.info('Connecting to Solana', { rpcUrl, driftEnv });

    this.connection = new Connection(rpcUrl, 'confirmed');

    // Load keypair
    const raw = JSON.parse(fs.readFileSync(keypairPath, 'utf-8'));
    const keypair = Keypair.fromSecretKey(Uint8Array.from(raw));
    this.wallet   = new Wallet(keypair);

    log.info('Wallet loaded', { pubkey: keypair.publicKey.toBase58() });

    const accountLoader = new BulkAccountLoader(this.connection, 'confirmed', 1000);

    this.client = new DriftClient({
      connection:    this.connection,
      wallet:        this.wallet,
      programID:     new PublicKey(DRIFT_PROGRAM_ID),
      env:           driftEnv,
      accountSubscription: {
        type:          'polling',
        accountLoader,
      },
    });

    await this.client.subscribe();

    this.user = this.client.getUser();
    await this.user.subscribe();

    log.info('Connected to Drift protocol');
  }

  async disconnect() {
    if (this.user)   await this.user.unsubscribe();
    if (this.client) await this.client.unsubscribe();
    log.info('Disconnected from Drift protocol');
  }

  /**
   * Return current SOL price in USD (from Drift oracle).
   */
  async getSolPrice() {
    const oracleData = this.client.getOracleDataForPerpMarket(SOL_PERP_MARKET_INDEX);
    const price = convertToNumber(oracleData.price, PRICE_PRECISION);
    return price;
  }

  /**
   * Return current funding rate for SOL-PERP (annualised %).
   */
  async getFundingRate() {
    const market = this.client.getPerpMarketAccount(SOL_PERP_MARKET_INDEX);
    // lastFundingRate is in QUOTE_PRECISION per BASE_PRECISION per hour
    const rawRate = convertToNumber(market.amm.lastFundingRate, PRICE_PRECISION);
    // Annualise: rate * 24 hours * 365 days * 100 for %
    const annualisedPct = rawRate * 24 * 365 * 100;
    return annualisedPct;
  }

  /**
   * Open a short position on SOL-PERP.
   * @param {number} usdcNotional – size in USD notional (e.g. 500)
   */
  async openShort(usdcNotional) {
    const solPrice = await this.getSolPrice();
    const baseAmount = usdcNotional / solPrice; // SOL quantity

    log.info('Opening SOL-PERP short', { usdcNotional, solPrice, baseAmount });

    const orderParams = getMarketOrderParams({
      marketIndex:    SOL_PERP_MARKET_INDEX,
      direction:      PositionDirection.SHORT,
      baseAssetAmount: new BN(Math.floor(baseAmount * BASE_PRECISION.toNumber())),
    });

    const txSig = await this.client.placePerpOrder(orderParams);
    log.info('Short order placed', { txSig });
    return txSig;
  }

  /**
   * Close the current SOL-PERP short position entirely.
   */
  async closeShort() {
    const position = await this.getPosition();
    if (!position || position.baseAssetAmount === 0) {
      log.warn('No open position to close');
      return null;
    }

    log.info('Closing SOL-PERP short', { position });

    const orderParams = getMarketOrderParams({
      marketIndex:    SOL_PERP_MARKET_INDEX,
      direction:      PositionDirection.LONG,   // buy to close short
      baseAssetAmount: new BN(Math.abs(position.rawBaseAmount)),
      reduceOnly:     true,
    });

    const txSig = await this.client.placePerpOrder(orderParams);
    log.info('Close order placed', { txSig });
    return txSig;
  }

  /**
   * Return current SOL-PERP position details.
   */
  async getPosition() {
    try {
      const perpPosition = this.user.getPerpPosition(SOL_PERP_MARKET_INDEX);
      if (!perpPosition) return null;

      const solPrice     = await this.getSolPrice();
      const rawBase      = perpPosition.baseAssetAmount.toNumber();
      const baseAmount   = rawBase / BASE_PRECISION.toNumber();
      const notionalUsd  = Math.abs(baseAmount) * solPrice;
      const unrealizedPnl = convertToNumber(
        this.user.getUnrealizedPNL(true, SOL_PERP_MARKET_INDEX),
        QUOTE_PRECISION
      );

      return {
        rawBaseAmount: rawBase,
        baseAmount,
        notionalUsd,
        unrealizedPnl,
        isShort: rawBase < 0,
      };
    } catch {
      return null;
    }
  }

  /**
   * Return total collateral (free USDC) in the Drift sub-account.
   */
  async getCollateral() {
    const collateral = convertToNumber(
      this.user.getTotalCollateral(),
      QUOTE_PRECISION
    );
    return collateral;
  }

  /**
   * Return total accumulated funding PnL.
   */
  async getFundingPnl() {
    try {
      const fundingPnl = convertToNumber(
        this.user.getUnrealizedFundingPNL(SOL_PERP_MARKET_INDEX),
        QUOTE_PRECISION
      );
      return fundingPnl;
    } catch {
      return 0;
    }
  }
}

module.exports = new DriftClientWrapper();
