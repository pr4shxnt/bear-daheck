'use strict';

/**
 * tests/strategy.test.js
 *
 * Unit tests for the strategy module.
 * Drift client is mocked so no real network calls are made.
 */

// ── Mock driftClient before requiring strategy ────────────────────────────
jest.mock('../bot/driftClient', () => ({
  getSolPrice:   jest.fn().mockResolvedValue(150),
  getFundingRate: jest.fn().mockResolvedValue(5),
  openShort:     jest.fn().mockResolvedValue('mock-tx-open'),
  closeShort:    jest.fn().mockResolvedValue('mock-tx-close'),
  getPosition:   jest.fn().mockResolvedValue({
    rawBaseAmount: -3_333_333_333,
    baseAmount:    -3.333,
    notionalUsd:   500,
    unrealizedPnl: 0,
    isShort:       true,
  }),
  getFundingPnl: jest.fn().mockResolvedValue(2.5),
  getCollateral: jest.fn().mockResolvedValue(500),
}));

const driftClient = require('../bot/driftClient');
const strategy    = require('../bot/strategy');

describe('strategy', () => {
  beforeEach(() => {
    // Reset state between tests
    strategy.state.isActive        = false;
    strategy.state.spotSolAmount   = 0;
    strategy.state.shortNotionalUsd = 0;
    strategy.state.entryTime       = null;
    strategy.state.totalFundingEarned = 0;
    strategy.state.trades          = [];
    jest.clearAllMocks();
    // Restore default mock return values after clearAllMocks
    driftClient.getSolPrice.mockResolvedValue(150);
    driftClient.getFundingRate.mockResolvedValue(5);
    driftClient.openShort.mockResolvedValue('mock-tx-open');
    driftClient.closeShort.mockResolvedValue('mock-tx-close');
    driftClient.getPosition.mockResolvedValue({
      rawBaseAmount: -3_333_333_333,
      baseAmount:    -3.333,
      notionalUsd:   500,
      unrealizedPnl: 0,
      isShort:       true,
    });
    driftClient.getFundingPnl.mockResolvedValue(2.5);
  });

  // ── openPosition ──────────────────────────────────────────────────────────

  describe('openPosition()', () => {
    test('sets isActive = true', async () => {
      await strategy.openPosition();
      expect(strategy.state.isActive).toBe(true);
    });

    test('calls driftClient.openShort with half the vault size', async () => {
      await strategy.openPosition();
      // VAULT_SIZE_USDC defaults to 1000, half = 500
      expect(driftClient.openShort).toHaveBeenCalledWith(500);
    });

    test('records spotSolAmount > 0', async () => {
      await strategy.openPosition();
      expect(strategy.state.spotSolAmount).toBeGreaterThan(0);
    });

    test('does not open a second position when already active', async () => {
      await strategy.openPosition();
      await strategy.openPosition(); // second call should be ignored
      expect(driftClient.openShort).toHaveBeenCalledTimes(1);
    });

    test('respects scale parameter', async () => {
      await strategy.openPosition(0.5); // 50% scale → notional = 250
      expect(driftClient.openShort).toHaveBeenCalledWith(250);
    });
  });

  // ── closePosition ─────────────────────────────────────────────────────────

  describe('closePosition()', () => {
    test('sets isActive = false', async () => {
      await strategy.openPosition();
      await strategy.closePosition();
      expect(strategy.state.isActive).toBe(false);
    });

    test('calls driftClient.closeShort', async () => {
      await strategy.openPosition();
      await strategy.closePosition();
      expect(driftClient.closeShort).toHaveBeenCalledTimes(1);
    });

    test('does nothing when position is not active', async () => {
      await strategy.closePosition();
      expect(driftClient.closeShort).not.toHaveBeenCalled();
    });

    test('resets spotSolAmount to 0', async () => {
      await strategy.openPosition();
      await strategy.closePosition();
      expect(strategy.state.spotSolAmount).toBe(0);
    });
  });

  // ── runCycle ──────────────────────────────────────────────────────────────

  describe('runCycle()', () => {
    test('opens position when not active and funding is healthy', async () => {
      const result = await strategy.runCycle();
      expect(result.action).toBe('opened');
      expect(strategy.state.isActive).toBe(true);
    });

    test('returns "hold" when position is already active and risk is ok', async () => {
      await strategy.openPosition();
      const result = await strategy.runCycle();
      expect(result.action).toBe('hold');
    });

    test('returns "exit" and closes position when funding is too low', async () => {
      driftClient.getFundingRate.mockResolvedValue(0); // below threshold
      await strategy.openPosition();
      const result = await strategy.runCycle();
      expect(result.action).toBe('exit');
      expect(strategy.state.isActive).toBe(false);
    });

    test('cycle result contains solPrice and fundingRate', async () => {
      const result = await strategy.runCycle();
      expect(result).toHaveProperty('solPrice');
      expect(result).toHaveProperty('fundingRate');
      expect(result).toHaveProperty('riskSignal');
    });
  });

  // ── getSnapshot ───────────────────────────────────────────────────────────

  describe('getSnapshot()', () => {
    test('returns required fields when no position is open', async () => {
      const snap = await strategy.getSnapshot();
      expect(snap).toHaveProperty('isActive');
      expect(snap).toHaveProperty('apyEstimate');
      expect(snap).toHaveProperty('totalPnl');
      expect(snap).toHaveProperty('recentTrades');
    });

    test('isActive reflects strategy state', async () => {
      await strategy.openPosition();
      const snap = await strategy.getSnapshot();
      expect(snap.isActive).toBe(true);
    });
  });
});
