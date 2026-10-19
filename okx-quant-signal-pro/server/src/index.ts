"use strict";

import express from "express";
import cors from "cors";
import path from "path";
import { listInstruments, tickers, candles, historyCandles, books } from "./services/okxApi";
import { buildSignal } from "./services/signal";
import { runBacktestOnCandles } from "./services/backtest";
import { db } from "./db";

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: "1mb" }));

/* ---------- Health ---------- */
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "okx-quant-signal-pro", time: Date.now() });
});

/* ---------- Instruments ---------- */
app.get("/api/instruments", async (req, res, next) => {
  try {
    const instType = (req.query.instType as string) || "SPOT";
    if (!["SPOT", "SWAP", "FUTURES"].includes(instType)) {
      res.status(400).json({ error: "Geçersiz instType" });
      return;
    }
    const data = await listInstruments(instType);
    const mapped = data.map((i) => ({
      instId: i.instId,
      instType: i.instType,
      tickSz: i.tickSz,
      lotSz: i.lotSz,
      minSz: i.minSz,
      ctType: i.ctType,
      ctMult: i.ctMult,
      state: i.state,
    }));
    res.json({ ok: true, instType, count: mapped.length, data: mapped });
  } catch (e: any) {
    next(e);
  }
});

/* ---------- Tickers ---------- */
app.get("/api/tickers", async (req, res, next) => {
  try {
    const instType = (req.query.instType as string) || "SPOT";
    const data = await tickers(instType);
    const mapped = data.map((t: any) => ({
      instId: t.instId,
      last: Number(t.last),
      bidPx: Number(t.bidPx),
      askPx: Number(t.askPx),
      open24h: Number(t.open24h),
      high24h: Number(t.high24h),
      low24h: Number(t.low24h),
      vol24h: Number(t.vol24h),
      ts: Number(t.ts),
    }));
    res.json({ ok: true, instType, data: mapped });
  } catch (e: any) {
    next(e);
  }
});

/* ---------- Candles ---------- */
app.get("/api/candles", async (req, res, next) => {
  try {
    const instId = req.query.instId as string;
    const bar = (req.query.bar as string) || "15m";
    const limit = req.query.limit ? Number(req.query.limit) : 300;
    if (!instId) { res.status(400).json({ error: "instId gerekli" }); return; }
    const data = await candles(instId, bar, undefined, undefined, limit);
    res.json({ ok: true, instId, bar, count: data.length, data });
  } catch (e: any) {
    next(e);
  }
});

/* ---------- History candles ---------- */
app.get("/api/history-candles", async (req, res, next) => {
  try {
    const instId = req.query.instId as string;
    const bar = (req.query.bar as string) || "15m";
    const before = req.query.before as string;
    const after = req.query.after as string;
    const limit = req.query.limit ? Number(req.query.limit) : 300;
    if (!instId) { res.status(400).json({ error: "instId gerekli" }); return; }
    const data = await historyCandles(instId, bar, before, after, limit);
    res.json({ ok: true, instId, bar, count: data.length, data });
  } catch (e: any) {
    next(e);
  }
});

/* ---------- Order book ---------- */
app.get("/api/books", async (req, res, next) => {
  try {
    const instId = req.query.instId as string;
    const size = req.query.size ? Number(req.query.size) : 40;
    if (!instId) { res.status(400).json({ error: "instId gerekli" }); return; }
    const data = await books(instId, size);
    res.json({ ok: true, instId, ...data });
  } catch (e: any) {
    next(e);
  }
});

/* ---------- Signal ---------- */
app.get("/api/signal", async (req, res, next) => {
  try {
    const symbol = req.query.symbol as string;
    const instType = (req.query.instType as string) || "SPOT";
    const timeframe = (req.query.timeframe as string) || "15m";
    const strat = (req.query.strategy as string) || "multi";
    const limit = req.query.limit ? Number(req.query.limit) : 300;
    if (!symbol) { res.status(400).json({ error: "symbol gerekli" }); return; }
    const data = await candles(symbol, timeframe, undefined, undefined, limit);
    if (data.length < 200) {
      res.status(400).json({ error: "Sinyal için yetersiz mum verisi", have: data.length, need: 200 });
      return;
    }
    const strategies = (strat.split(",") as any).filter(Boolean);
    const signal = buildSignal({ symbol, instType, candles: data, timeframe: timeframe as any, strategy: strategies });
    res.json({ ok: true, signal });
  } catch (e: any) {
    next(e);
  }
});

/* ---------- Scanner ---------- */
app.get("/api/scan", async (req, res, next) => {
  try {
    const symbolsParam = req.query.symbols as string;
    const instType = (req.query.instType as string) || "SPOT";
    const timeframe = (req.query.timeframe as string) || "15m";
    const strat = (req.query.strategy as string) || "multi";
    const symbols = symbolsParam ? symbolsParam.split(",").filter(Boolean) : [];
    if (symbols.length === 0) {
      res.status(400).json({ error: "symbols gerekli (virgülle ayrılmış)" });
      return;
    }
    const strategies = (strat.split(",") as any).filter(Boolean);
    const results = [];
    const errors: string[] = [];
    // sırayla, rate limit'e düşmesin
    for (const symbol of symbols) {
      try {
        const data = await candles(symbol, timeframe, undefined, undefined, 300);
        if (data.length < 200) { errors.push(`${symbol}: yetersiz veri (${data.length})`); continue; }
        const signal = buildSignal({ symbol, instType, candles: data, timeframe: timeframe as any, strategy: strategies });
        results.push({
          symbol, side: signal.side, score: signal.score, price: signal.price,
          entry: signal.entry, stopLoss: signal.stopLoss, tp1: signal.tp1, tp2: signal.tp2, tp3: signal.tp3,
          rr: signal.rr, timeframe: signal.timeframe, generatedAt: signal.generatedAt,
          rationale: signal.rationale, strategy: signal.strategy,
        });
      } catch (e: any) {
        errors.push(`${symbol}: ${e.message}`);
      }
    }
    results.sort((a, b) => b.score - a.score);
    res.json({ ok: true, instType, timeframe, results, errors });
  } catch (e: any) {
    next(e);
  }
});

/* ---------- Backtest ---------- */
app.get("/api/backtest", async (req, res, next) => {
  try {
    const symbol = req.query.symbol as string;
    const instType = (req.query.instType as string) || "SPOT";
    const timeframe = (req.query.timeframe as string) || "15m";
    const strategy = (req.query.strategy as string) || "multi";
    const start = req.query.start ? Number(req.query.start) : 0;
    const end = req.query.end ? Number(req.query.end) : Date.now();
    const initialCapital = req.query.capital ? Number(req.query.capital) : 1000;
    if (!symbol) { res.status(400).json({ error: "symbol gerekli" }); return; }
    const data = await historyCandles(symbol, timeframe, undefined, undefined, 1000);
    const filtered = data.filter((c) => c.ts >= start && c.ts <= end);
    if (filtered.length < 210) {
      res.status(400).json({ error: "Yetersiz geçmiş mum (en az 210 gerekir)", have: filtered.length });
      return;
    }
    const result = runBacktestOnCandles({ candles: filtered, strategy, instType, initialCapital });
    result.symbol = symbol;
    result.timeframe = timeframe;
    res.json({ ok: true, ...result });
  } catch (e: any) {
    next(e);
  }
});

/* ---------- Signal history ---------- */
app.get("/api/signals", (_req, res) => {
  const rows = db.prepare("SELECT * FROM signals ORDER BY createdAt DESC LIMIT 100").all();
  res.json({ ok: true, data: rows });
});

app.post("/api/signals", (req, res) => {
  const { symbol, instType, side, score, price, entry, stopLoss, tp1, tp2, tp3, rr, timeframe, generatedAt, expiresAt, rationale, invalidation, strategy } = req.body;
  const id = uid();
  db.prepare(`INSERT INTO signals (id,symbol,instType,side,score,price,entry,stopLoss,tp1,tp2,tp3,rr,timeframe,generatedAt,expiresAt,rationale,invalidation,strategy,status,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, symbol, instType, side, score, price, entry ?? null, stopLoss ?? null, tp1 ?? null, tp2 ?? null, tp3 ?? null, rr ?? null,
    timeframe, generatedAt ?? Date.now(), expiresAt ?? null, rationale ? JSON.stringify(rationale) : null,
    invalidation ? JSON.stringify(invalidation) : null, strategy ? JSON.stringify(strategy) : null, "active", Date.now()
  );
  res.json({ ok: true, id });
});

/* ---------- Trades (journal) ---------- */
app.get("/api/trades", (_req, res) => {
  const rows = db.prepare("SELECT * FROM trades ORDER BY createdAt DESC LIMIT 500").all();
  res.json({ ok: true, data: rows });
});

app.post("/api/trades", (req, res) => {
  const { symbol, instType, side, status, entryPrice, exitPrice, qty, commission, leverage, openedAt, closedAt, rationale, signalId } = req.body;
  const id = uid();
  const now = Date.now();
  let pnlUsdt = null, pnlPct = null;
  if (entryPrice != null && exitPrice != null && qty != null) {
    const long = side === "LONG" || side === "AL";
    pnlUsdt = (long ? (exitPrice - entryPrice) : (entryPrice - exitPrice)) * qty;
    pnlPct = entryPrice ? ((exitPrice - entryPrice) / entryPrice) * 100 * (long ? 1 : -1) : null;
    if (leverage) pnlPct = pnlPct * leverage;
  }
  db.prepare(`INSERT INTO trades (id,symbol,instType,side,status,entryPrice,exitPrice,qty,commission,leverage,openedAt,closedAt,pnlUsdt,pnlPct,rationale,signalId,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, symbol, instType, side, status, entryPrice ?? null, exitPrice ?? null, qty ?? null, commission ?? null, leverage ?? null,
    openedAt ?? null, closedAt ?? null, pnlUsdt, pnlPct, rationale ?? null, signalId ?? null, now, now
  );
  res.json({ ok: true, id, pnlUsdt, pnlPct });
});

app.get("/api/trades/performance", (_req, res) => {
  const rows = db.prepare("SELECT * FROM trades WHERE status IN ('kapandi','stop','tp1','tp2','tp3','iptal') AND pnlUsdt IS NOT NULL").all() as any[];
  const total = rows.length;
  const wins = rows.filter((r) => (r.pnlUsdt || 0) > 0).length;
  const losses = rows.filter((r) => (r.pnlUsdt || 0) < 0).length;
  const grossProfit = rows.reduce((s, r) => s + Math.max(r.pnlUsdt || 0, 0), 0);
  const grossLoss = rows.reduce((s, r) => s + Math.min(r.pnlUsdt || 0, 0), 0);
  const net = grossProfit + grossLoss;
  const winRate = total ? (wins / total) * 100 : 0;
  const profitFactor = Math.abs(grossLoss) > 0 ? grossProfit / Math.abs(grossLoss) : grossProfit > 0 ? Infinity : 0;
  let maxDD = 0, peak = 0, running = 0;
  for (const r of rows) {
    running += r.pnlUsdt || 0;
    if (running > peak) peak = running;
    const dd = peak - running;
    if (dd > maxDD) maxDD = dd;
  }
  const totalCommission = rows.reduce((s, r) => s + (r.commission || 0), 0);
  res.json({ ok: true, total, wins, losses, winRate: round2(winRate), profitFactor: round2(profitFactor),
    grossProfit: round2(grossProfit), grossLoss: round2(grossLoss), net: round2(net),
    maxDrawdown: round2(maxDD), totalCommission: round2(totalCommission) });
});

function round2(n: number): number { return Math.round((n + Number.EPSILON) * 100) / 100; }

/* ---------- Error handler ---------- */
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("[API ERROR]", err.message);
  res.status(500).json({ ok: false, error: err.message || "Sunucu hatası" });
});

/* ---------- Static client (production) ---------- */
const clientDist = path.join(__dirname, "../../client/dist");
app.use(express.static(clientDist));
app.get("*", (_req, res) => {
  res.sendFile(path.join(clientDist, "index.html"));
});

app.listen(PORT, () => {
  console.log(`[server] OKX Quant Signal Pro listening on :${PORT}`);
});
