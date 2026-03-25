'use strict';

/**
 * dashboard/server.js
 *
 * Lightweight Express API + static file server for the MVP dashboard.
 *
 * Endpoints:
 *   GET /         → serves dashboard/index.html
 *   GET /api/status → returns current strategy snapshot (JSON)
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const express  = require('express');
const path     = require('path');
const strategy = require('../bot/strategy');
const log      = require('../bot/logger');

const PORT = parseInt(process.env.DASHBOARD_PORT || '3000', 10);
const app  = express();

// ─── Static ─────────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname)));

// ─── API ────────────────────────────────────────────────────────────────────

app.get('/api/status', async (req, res) => {
  try {
    const snapshot = await strategy.getSnapshot();
    res.json({ ok: true, data: snapshot });
  } catch (err) {
    log.error('Dashboard /api/status error', { message: err.message });
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Health check
app.get('/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// ─── Start ───────────────────────────────────────────────────────────────────
const server = app.listen(PORT, () => {
  log.info(`Dashboard running at http://localhost:${PORT}`);
});

module.exports = server;
