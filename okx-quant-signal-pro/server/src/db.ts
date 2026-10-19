"use strict";

import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

const DB_DIR = path.join(process.cwd(), "data");
fs.mkdirSync(DB_DIR, { recursive: true });
const DB_PATH = path.join(DB_DIR, "signals.db");

export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

export function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS signals (
      id TEXT PRIMARY KEY,
      symbol TEXT NOT NULL,
      instType TEXT NOT NULL,
      side TEXT NOT NULL,
      signal TEXT NOT NULL,
      score INTEGER NOT NULL,
      price REAL NOT NULL,
      entry REAL,
      stopLoss REAL,
      tp1 REAL,
      tp2 REAL,
      tp3 REAL,
      rr TEXT,
      timeframe TEXT,
      timeframeEntry TEXT,
      generatedAt INTEGER NOT NULL,
      expiresAt INTEGER,
      rationale TEXT,
      invalidation TEXT,
      timeframes TEXT,
      indicators TEXT,
      status TEXT DEFAULT 'active',
      createdAt INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS trades (
      id TEXT PRIMARY KEY,
      symbol TEXT NOT NULL,
      instType TEXT NOT NULL,
      side TEXT NOT NULL,
      status TEXT NOT NULL,
      entryPrice REAL,
      exitPrice REAL,
      qty REAL,
      commission REAL,
      leverage REAL,
      openedAt INTEGER,
      closedAt INTEGER,
      pnlUsdt REAL,
      pnlPct REAL,
      rationale TEXT,
      signalId TEXT,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS scan_cache (
      key TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      ts INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_signals_symbol ON signals(symbol);
    CREATE INDEX IF NOT EXISTS idx_signals_created ON signals(createdAt);
    CREATE INDEX IF NOT EXISTS idx_trades_symbol ON trades(symbol);
  `);
}

initDb();
