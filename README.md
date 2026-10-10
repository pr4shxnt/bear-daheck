# MVP Adaptive Delta Neutral Vault

A lean, production-ready delta-neutral yield bot for **Solana / Drift Protocol**.

## Strategy Overview

| Leg | Action | Size |
|-----|--------|------|
| Spot | Buy SOL | ~50% of vault USDC |
| Perp | Short SOL-PERP on Drift | ~50% of vault USDC notional |

Both legs cancel out directional SOL exposure (delta ≈ 0), leaving only **funding fee yield** as profit. When funding is positive, shorts (us) **receive** funding from longs.

### Execution Flow

```
START
  → Deposit USDC
  → Buy SOL spot           (50%)
  → Short SOL-PERP Drift   (50%)
  → Monitor every 5 min:
      - SOL price (oracle)
      - Funding rate
      - Portfolio volatility
  → Every 6 h (configurable):
      - Rebalance if hedge ratio ≠ 1:1
  → Risk rules (always on):
      - If funding_rate < 0.01% → exit trade
      - If volatility > 80%     → reduce position
  → Log: trades, PnL, funding earned
END
```

## Repository Structure

```
/bot
  ├── index.js        – main entry point + cron scheduler
  ├── strategy.js     – delta-neutral open/close/cycle logic
  ├── driftClient.js  – Drift SDK wrapper (price, funding, orders)
  ├── rebalance.js    – hedge ratio check + position adjustments
  ├── riskManager.js  – rule-based risk engine
  └── logger.js       – structured JSON-line logger

/dashboard
  ├── server.js       – Express API server
  └── index.html      – single-page dashboard UI

/tests
  ├── strategy.test.js
  ├── riskManager.test.js
  └── logger.test.js

.env.example          – configuration template
README.md
```

## Quick Start

### 1. Prerequisites

- Node.js ≥ 18
- A Solana wallet keypair (JSON file)
- SOL for transaction fees + USDC for the vault
- A Drift Protocol sub-account (create at [app.drift.trade](https://app.drift.trade))

### 2. Install

```bash
npm install
```

### 3. Configure

```bash
cp .env.example .env
# Edit .env with your settings
```

Key variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `KEYPAIR_PATH` | `./keypair.json` | Path to Solana keypair |
| `RPC_URL` | devnet | Solana RPC endpoint |
| `VAULT_SIZE_USDC` | `1000` | Total USDC to deploy |
| `MIN_FUNDING_RATE` | `0.01` | Exit if funding (ann. %) drops below this |
| `REBALANCE_INTERVAL_HOURS` | `6` | How often to rebalance |
| `MAX_VOLATILITY_PCT` | `80` | Reduce position if vol exceeds this |
| `DRIFT_ENV` | `devnet` | `devnet` or `mainnet` |
| `DASHBOARD_PORT` | `3000` | Dashboard HTTP port |

### 4. Run the Bot

```bash
npm start
```

The bot will:
1. Connect to Solana + Drift Protocol
2. Open the delta-neutral position
3. Run strategy cycles every 5 minutes
4. Rebalance every 6 hours (configurable)

### 5. View the Dashboard

While the bot is running, open **http://localhost:3000** in your browser.

You will see:

- 🟢 **Status** (Active / Inactive)
- 💲 **SOL Price** (live oracle)
- 📈 **Funding Rate** (annualised %)
- 🔄 **APY Estimate**
- 💰 **Total PnL** (Spot + Funding)
- 📊 **Recent Trades** table

## Risk Management

Two rules are always active:

```javascript
// Rule 1 – low funding → not worth holding
if (funding_rate < MIN_FUNDING_RATE) exit_trade();

// Rule 2 – high volatility → reduce exposure
if (volatility > MAX_VOLATILITY_PCT) reduce_position(scale);
```

Volatility is computed as a rolling 20-period annualised standard deviation of log-returns sampled every 5 minutes.

## Tests

```bash
npm test
```

All core modules (strategy, risk manager, logger) are unit-tested with mocked Drift client — no blockchain connection required.

## Proof of Performance

When running on-chain, every trade emits a Solana transaction signature logged as:

```json
{"ts":"...","level":"info","message":"Trade","type":"OPEN_SHORT","txSig":"<TX_SIG>"}
```

Paste the `txSig` into [Solscan](https://solscan.io) or [SolanaFM](https://solana.fm) to verify on-chain activity.

## Strategy Limitations

- **Single asset**: SOL only
- **Basic rebalancing**: rule-based (not ML)
- **Spot leg simulated**: real mainnet deployment requires a Jupiter swap call in `strategy.js::_buySpotSol`
- **Short test duration**: APY estimate gains accuracy over time

## Architecture Notes

- No smart contract needed — bot controls a single wallet/sub-account
- Restart-safe: close position cleanly on SIGINT / SIGTERM
- Stateless between restarts (extend with a DB for production)
