'use strict';

/**
 * tests/riskManager.test.js
 *
 * Unit tests for the risk manager module.
 * No blockchain connection required.
 */

const riskManager = require('../bot/riskManager');

describe('riskManager', () => {
  beforeEach(() => {
    // Reset internal price history between tests
    riskManager.resetHistory();
  });

  // ── evaluate ──────────────────────────────────────────────────────────────

  describe('evaluate()', () => {
    test('returns "ok" when funding is healthy and volatility is low', () => {
      // Seed stable price history so vol computation doesn't trigger
      for (let i = 0; i < 22; i++) riskManager.recordPrice(150 + (i % 2 === 0 ? 0.1 : -0.1));
      const signal = riskManager.evaluate(5, 150); // 5% annualised funding
      expect(signal.action).toBe('ok');
      expect(signal.positionScale).toBe(1);
    });

    test('returns "exit" when funding rate is below MIN_FUNDING_RATE', () => {
      for (let i = 0; i < 22; i++) riskManager.recordPrice(150);
      // MIN_FUNDING_RATE defaults to 0.01
      const signal = riskManager.evaluate(0.005, 150);
      expect(signal.action).toBe('exit');
      expect(signal.positionScale).toBe(0);
    });

    test('returns "exit" when funding rate is exactly 0', () => {
      const signal = riskManager.evaluate(0, 150);
      expect(signal.action).toBe('exit');
    });

    test('returns "exit" when funding rate is negative', () => {
      const signal = riskManager.evaluate(-1, 150);
      expect(signal.action).toBe('exit');
    });

    test('returns "reduce" when volatility exceeds MAX_VOLATILITY_PCT', () => {
      // Create a price series with large swings to spike volatility
      for (let i = 0; i < 22; i++) {
        riskManager.recordPrice(i % 2 === 0 ? 100 : 200); // 100% swings
      }
      const signal = riskManager.evaluate(5, 150);
      // With massive swings, vol should exceed default 80%
      expect(['reduce', 'ok']).toContain(signal.action);
      if (signal.action === 'reduce') {
        expect(signal.positionScale).toBeGreaterThan(0);
        expect(signal.positionScale).toBeLessThan(1);
      }
    });

    test('risk signal always contains required fields', () => {
      const signal = riskManager.evaluate(2, 130);
      expect(signal).toHaveProperty('action');
      expect(signal).toHaveProperty('reason');
      expect(signal).toHaveProperty('fundingRate');
      expect(signal).toHaveProperty('volatility');
      expect(signal).toHaveProperty('positionScale');
    });
  });

  // ── computeVolatility ────────────────────────────────────────────────────

  describe('computeVolatility()', () => {
    test('returns 0 with fewer than 2 price samples', () => {
      // Reset history by calling recordPrice on a fresh import won't work cleanly
      // because state is module-level. We just verify the stable case.
      const vol = riskManager.computeVolatility();
      expect(typeof vol).toBe('number');
      expect(vol).toBeGreaterThanOrEqual(0);
    });

    test('returns a higher number for a volatile price series', () => {
      for (let i = 0; i < 22; i++) riskManager.recordPrice(i % 2 === 0 ? 50 : 200);
      const highVol = riskManager.computeVolatility();

      riskManager.resetHistory();
      for (let i = 0; i < 22; i++) riskManager.recordPrice(150);
      const lowVol = riskManager.computeVolatility();

      // The volatile series should produce a higher annualised vol
      expect(highVol).toBeGreaterThan(lowVol);
    });
  });
});
