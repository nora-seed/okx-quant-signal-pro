"use strict";

/**
 * Backtest motoru.
 * Kural: sadece o ana kadar olan veriler kullanılır (gelecek veri sızası yok).
 * Sinyal, mum i'nin kapanışına dayanır; işlem i+1 mumunun açılışında gerçekleşir.
 * Aynı mumda SL ve TP ikişe de vurursa konservatif olarak ÖNCE SL'e vurduğu kabul edilir.
 */

import type { Candle, SignalSide } from "./signal";
import { buildSignal, MIN_RR_DEFAULT } from "./signal";
import type { Timeframe } from "./signal";

export type BacktestRequest = {
  symbol: string;
  instType: string;
  timeframe: Timeframe;
  strategy: string;
  startTs: number;
  endTs: number;
  initialCapital: number;
};

export type BacktestTrade = {
  entryTs: number;
  entryPrice: number;
  side: SignalSide;
  stopLoss: number | null;
  tp1: number | null;
  tp2: number | null;
  tp3: number | null;
  exitTs: number | null;
  exitPrice: number | null;
  exitReason: "stop" | "tp1" | "tp2" | "tp3" | "timeout" | null;
  pnlUsdt: number | null;
  pnlPct: number | null;
  qty: number | null;
};

export type BacktestResult = {
  symbol: string;
  instType: string;
  timeframe: string;
  strategy: string;
  candleCount: number;
  tradeCount: number;
  winCount: number;
  lossCount: number;
  winRate: number;
  profitFactor: number;
  grossProfit: number;
  grossLoss: number;
  netPnl: number;
  netPnlPct: number;
  maxDrawdown: number;
  maxDrawdownPct: number;
  avgRr: number | null;
  totalCommission: number;
  inSample: BacktestSlice | null;
  outOfSample: BacktestSlice | null;
  trades: BacktestTrade[];
  equity: { ts: number; equity: number }[];
};

export type BacktestSlice = {
  label: string;
  startTs: number;
  endTs: number;
  tradeCount: number;
  winRate: number;
  profitFactor: number;
  netPnl: number;
  maxDrawdown: number;
};

const COMMISSION_RATE = 0.0005; // %0.05 iki yön (tahmini)
const SLIPPAGE_TICKS = 0.0002; // %0.02 tahmini slippage

function commissionOn(notional: number): number {
  return notional * COMMISSION_RATE;
}

function runBacktestOnCandles({
  candles,
  strategy,
  instType,
  initialCapital,
  entryFeeBps = 5,
  exitFeeBps = 5,
}: {
  candles: Candle[];
  strategy: string;
  instType: string;
  initialCapital: number;
  entryFeeBps?: number;
  exitFeeBps?: number;
}): BacktestResult {
  const n = candles.length;
  const trades: BacktestTrade[] = [];
  let equity = initialCapital;
  const equityCurve: { ts: number; equity: number }[] = [{ ts: candles[0]?.ts ?? 0, equity }];
  let peak = initialCapital;
  let maxDrawdown = 0;
  let maxDrawdownPct = 0;

  const strategies = strategy.split(",").filter(Boolean);

  // Her mum i için: candles[0..i] ile sinyal üret, i+1'de giriş
  for (let i = 200; i < n - 1; i++) {
    const slice = candles.slice(0, i + 1);
    const signal = buildSignal({
      symbol: "",
      instType,
      candles: slice,
      timeframe: "15m" as any,
      strategy: strategies as any,
    });

    if (signal.side === "BEKLE" || !signal.entry || !signal.stopLoss) continue;

    const side = signal.side;
    const long = side === "FUTURES_LONG" || side === "SPOT_AL";
    const entryPrice = signal.entry;
    const sl = signal.stopLoss!;
    const tps = [signal.tp1, signal.tp2, signal.tp3].filter((t): t is number => t != null);

    // Giriş commissions
    const entryNotional = entryPrice; // 1 birim bazlı, sonra qty ile ölçekle
    // Risk bazlı qty: sermaye %1 risk
    const riskUsdt = initialCapital * 0.01;
    const riskPerUnit = Math.abs(entryPrice - sl);
    let qty = riskPerUnit > 0 ? riskUsdt / riskPerUnit : 0;
    if (qty <= 0) continue;

    let exitPrice: number | null = null;
    let exitTs: number | null = null;
    let exitReason: BacktestTrade["exitReason"] = null;

    // i+1'den itibaren izle
    for (let j = i + 1; j < n; j++) {
      const c = candles[j];
      const longHitSL = c.low <= sl;
      const shortHitSL = c.high >= sl;
      const hitSL = long ? longHitSL : shortHitSL;

      // TP kontrolü (sıralı: TP1 -> TP2 -> TP3)
      let hitTP: number | null = null;
      for (const tp of tps) {
        const longHit = c.high >= tp;
        const shortHit = c.low <= tp;
        if ((long ? longHit : shortHit)) { hitTP = tp; break; }
      }

      if (hitSL && hitTP != null) {
        // Aynı mum: konservatif = önce SL
        exitPrice = sl;
        exitTs = c.ts;
        exitReason = "stop";
      } else if (hitSL) {
        exitPrice = sl;
        exitTs = c.ts;
        exitReason = "stop";
      } else if (hitTP != null) {
        exitPrice = hitTP;
        exitTs = c.ts;
        exitReason = hitTP === signal.tp1 ? "tp1" : hitTP === signal.tp2 ? "tp2" : "tp3";
      }

      if (exitPrice != null) break;
    }

    if (exitPrice === null) {
      // Zamanla çıkamaz, son kapanışla kıyasıya (timeout - gerçekleşmemiş işlem sayılmaz)
      continue;
    }

    const grossPnl = long ? (exitPrice - entryPrice) * qty : (entryPrice - exitPrice) * qty;
    const entryComm = commissionOn(entryPrice * qty);
    const exitComm = commissionOn(exitPrice * qty);
    const slippage = (entryPrice * SLIPPAGE_TICKS + exitPrice * SLIPPAGE_TICKS) * qty;
    const pnlUsdt = grossPnl - entryComm - exitComm - slippage;
    const pnlPct = entryPrice ? (pnlUsdt / (entryPrice * qty)) * 100 : 0;

    equity += pnlUsdt;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    const ddPct = peak ? (dd / peak) * 100 : 0;
    if (dd > maxDrawdown) maxDrawdown = dd;
    if (ddPct > maxDrawdownPct) maxDrawdownPct = ddPct;

    equityCurve.push({ ts: exitTs!, equity });

    trades.push({
      entryTs: candles[i].ts,
      entryPrice,
      side,
      stopLoss: sl,
      tp1: signal.tp1,
      tp2: signal.tp2,
      tp3: signal.tp3,
      exitTs,
      exitPrice,
      exitReason,
      pnlUsdt: round2(pnlUsdt),
      pnlPct: round2(pnlPct),
      qty: round2(qty),
    });
  }

  const wins = trades.filter((t) => (t.pnlUsdt || 0) > 0).length;
  const losses = trades.filter((t) => (t.pnlUsdt || 0) < 0).length;
  const grossProfit = trades.reduce((s, t) => s + Math.max(t.pnlUsdt || 0, 0), 0);
  const grossLoss = trades.reduce((s, t) => s + Math.min(t.pnlUsdt || 0, 0), 0);
  const net = grossProfit + grossLoss;
  const winRate = trades.length ? (wins / trades.length) * 100 : 0;
  const profitFactor = Math.abs(grossLoss) > 0 ? grossProfit / Math.abs(grossLoss) : grossProfit > 0 ? Infinity : 0;
  const totalCommission = trades.reduce((s, t) => {
    const notional = (t.entryPrice || 0) * (t.qty || 0) + (t.exitPrice || 0) * (t.qty || 0);
    return s + commissionOn(notional);
  }, 0);
  const avgRr = trades.length
    ? trades.reduce((s, t) => {
        const risk = t.entryPrice != null && t.stopLoss != null ? Math.abs(t.entryPrice - t.stopLoss) : 0;
        const reward = t.entryPrice != null && t.exitPrice != null ? Math.abs(t.exitPrice - t.entryPrice) : 0;
        return s + (risk > 0 ? reward / risk : 0);
      }, 0) / trades.length
    : null;

  const netPnlPct = initialCapital ? (net / initialCapital) * 100 : 0;

  // In-sample / out-of-sample (ilk %60 / son %40)
  const splitIdx = Math.floor(trades.length * 0.6);
  const inSampleTrades = trades.slice(0, splitIdx);
  const oosTrades = trades.slice(splitIdx);

  const sliceStats = (list: BacktestTrade[], label: string): BacktestSlice => {
    const w = list.filter((t) => (t.pnlUsdt || 0) > 0).length;
    const l = list.filter((t) => (t.pnlUsdt || 0) < 0).length;
    const gp = list.reduce((s, t) => s + Math.max(t.pnlUsdt || 0, 0), 0);
    const gl = list.reduce((s, t) => s + Math.min(t.pnlUsdt || 0, 0), 0);
    const pf = Math.abs(gl) > 0 ? gp / Math.abs(gl) : gp > 0 ? Infinity : 0;
    let peakE = initialCapital, mdd = 0, eq = initialCapital;
    for (const t of list) { eq += t.pnlUsdt || 0; if (eq > peakE) peakE = eq; const dd = peakE - eq; if (dd > mdd) mdd = dd; }
    return {
      label,
      startTs: list[0]?.entryTs ?? 0,
      endTs: list[list.length - 1]?.exitTs ?? 0,
      tradeCount: list.length,
      winRate: round2(list.length ? (w / list.length) * 100 : 0),
      profitFactor: round2(pf),
      netPnl: round2(gp + gl),
      maxDrawdown: round2(mdd),
    };
  };

  return {
    symbol: "",
    instType,
    timeframe: "15m",
    strategy,
    candleCount: n,
    tradeCount: trades.length,
    winCount: wins,
    lossCount: losses,
    winRate: round2(winRate),
    profitFactor: round2(profitFactor),
    grossProfit: round2(grossProfit),
    grossLoss: round2(grossLoss),
    netPnl: round2(net),
    netPnlPct: round2(netPnlPct),
    maxDrawdown: round2(maxDrawdown),
    maxDrawdownPct: round2(maxDrawdownPct),
    avgRr: round2(avgRr ?? 0),
    totalCommission: round2(totalCommission),
    inSample: sliceStats(inSampleTrades, "in-sample"),
    outOfSample: sliceStats(oosTrades, "out-of-sample"),
    trades,
    equity: equityCurve,
  };
}

function round2(n: number): number { return Math.round((n + Number.EPSILON) * 100) / 100; }

export { runBacktestOnCandles };
