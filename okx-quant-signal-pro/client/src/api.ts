"use strict";

/**
 * Tarayıcı-içi API katmanı.
 * CORS doğrulandı: OKX public API doğrudan tarayıcıdan erişilebilir (proxy GEREKMEZ).
 * Erişim mümkün değilse: hata gösterilir, UYDURMA veri ÜRETİLMEZ.
 * Sinyal motoru tarayıcıda çalışır (lib/signalEngine.ts).
 * Geçmiş ve ayarlar IndexedDB'de tutulur.
 */

import {
  fetchTickers, fetchInstruments, fetchCandles, fetchHistoryCandles, fetchBooks, fetchFunding,
  idbPut, idbAll, idbClear, IDB_STORES,
} from "./lib/okxPublic";
import { buildSignal } from "./lib/signalEngine";
import type { Timeframe, StrategyId } from "./lib/signalEngine";

export type { Ticker } from "./lib/okxPublic";

const SIGNALS = IDB_STORES.signals;
const TRADES_STORE = IDB_STORES.settings; // trades ayrı store yerine settings ile ayrı id prefix
const SCAN = IDB_STORES.scanState;

function genId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export const api = {
  /* Bağlantı denetimi: gerçek istek, sahte cevap yok */
  async health(): Promise<{ ok: boolean }> {
    await fetchInstruments("SPOT");
    return { ok: true };
  },

  async tickers(instType: "SPOT" | "SWAP") {
    const data = await fetchTickers(instType);
    return { code: "0", data };
  },

  async instruments(instType: "SPOT" | "SWAP") {
    const data = await fetchInstruments(instType);
    return { code: "0", data };
  },

  async candles(instId: string, tf: string, limit: number) {
    const data = await fetchCandles(instId, tf, limit);
    return { code: "0", data };
  },

  async historyCandles(instId: string, tf: string, limit: number) {
    const data = await fetchHistoryCandles(instId, tf, limit);
    return { code: "0", data };
  },

  async books(instId: string, size = 40) {
    const data = await fetchBooks(instId, size);
    return { code: "0", data };
  },

  async funding(instId: string) {
    return { code: "0", data: await fetchFunding(instId) };
  },

  /* Sinyal motoru tarayıcıda */
  async signal(symbol: string, instType: "SPOT" | "SWAP", timeframe: Timeframe, strategy: string[], minRr = 2) {
    const candles = await fetchCandles(symbol, timeframe, 300);
    if (candles.length < 200) {
      throw new Error(`Mum verisi yetersiz: ${candles.length}/200. Daha kısa zaman dilimi seçin.`);
    }
    const signal = buildSignal({ symbol, instType, candles, timeframe, strategy: strategy as StrategyId[], minRr });
    await this.saveSignal(signal);
    return { code: "0", signal };
  },

  async scan(symbols: string[], instType: "SPOT" | "SWAP", timeframe: Timeframe, strategy: string[]) {
    const results: any[] = [];
    const errors: string[] = [];
    for (const sym of symbols) {
      try {
        const candles = await fetchCandles(sym, timeframe, 300);
        if (candles.length < 200) {
          results.push({ symbol: sym, side: "BEKLE", score: 0, price: candles.at(-1)?.close ?? 0, timeframe, strategy, error: "Yetersiz veri" });
          continue;
        }
        const r = buildSignal({ symbol: sym, instType, candles, timeframe, strategy: strategy as StrategyId[] });
        results.push(r);
      } catch (e: any) {
        errors.push(`${sym}: ${e?.message || "tarama hatası"}`);
      }
    }
    return { code: "0", results, errors };
  },

  /* ---- Sinyal geçmişi (IndexedDB) ---- */
  async saveSignal(s: any) {
    const rec = { ...s, id: s.id ?? `${s.symbol}-${s.timeframe}-${Date.now()}-${genId()}` };
    await idbPut(SIGNALS, rec);
    return rec;
  },

  async signals(): Promise<{ data: any[] }> {
    let data = await idbAll(SIGNALS);
    data = data.sort((a, b) => (b.generatedAt || 0) - (a.generatedAt || 0));
    return { data };
  },

  async clearSignals() {
    await idbClear(SIGNALS);
  },

  /* ---- Manuel işlem günlüğü (IndexedDB, settings store id-prefix ile) ---- */
  async tradeList(): Promise<Trade[]> {
    const all = await idbAll(IDB_STORES.settings);
    return all.filter((t: any) => t.kind === "trade") as Trade[];
  },

  async saveTrade(t: any) {
    const rec = { ...t, kind: "trade", id: t.id ?? genId(), id2: undefined };
    rec.id = `${TRADES_STORE}-trade-${rec.id}`;
    await idbPut(IDB_STORES.settings, rec);
    return rec;
  },

  async deleteTrade(id: string) {
    const all = await idbAll(IDB_STORES.settings);
    const rec = all.find((t: any) => t.id === id);
    if (rec) await idbPut(IDB_STORES.settings, { ...rec, deleted: true });
  },

  async trades(): Promise<{ data: Trade[] }> {
    if (typeof document === "undefined") return { data: [] };
    const data = (await this.tradeList()).filter((t: any) => !t.deleted)
      .sort((a, b) => (b.openedAt || 0) - (a.openedAt || 0));
    return { data };
  },

  async performance(): Promise<{ data: Perf | null }> {
    const trades = (await this.trades()).data;
    let wins: number = 0, losses = 0, grossProfit = 0, grossLoss = 0, commission = 0;
    let maxDD = 0, cum = 0, peak = 0;
    for (const t of trades) {
      const c = Number(t.commission) || 0;
      commission += c;
      if (t.status === "girdi" && t.exitPrice == null) continue;
      const pnl = Number(t.pnlUsdt) || 0;
      if (pnl >= 0) { wins += 1; grossProfit += pnl; } else { losses += 1; grossLoss += Math.abs(pnl); }
      cum += pnl;
      if (cum > peak) peak = cum;
      const dd = peak - cum;
      if (dd > maxDD) maxDD = dd;
    }
    const total = trades.length;
    const winRate = total > 0 ? (wins / total) * 100 : 0;
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : 0);
    return {
      data: {
        total, wins, losses, winRate: Math.round(winRate * 10) / 10,
        profitFactor: profitFactor === Infinity ? Infinity : Math.round(profitFactor * 100) / 100,
        grossProfit, grossLoss, maxDrawdown: maxDD, net: cum - commission, totalCommission: commission,
      } as Perf,
    };
  },

  /* ---- Ayarlar (strateji toggle vb.) ---- */
  async saveSettings(patch: Record<string, unknown>) {
    const cur = { ...(await this.loadSettings()), ...patch };
    await idbPut(IDB_STORES.settings, { ...cur, kind: "settings", id: "settings-main" });
    return cur;
  },

  async loadSettings(): Promise<Record<string, any>> {
    try {
      const all = await idbAll(IDB_STORES.settings);
      const rec: any = all.find((x) => x.id === "settings-main");
      return rec ? { ...rec } : {};
    } catch { return {}; }
  },

  /* ---- Tarama durumu (IndexedDB; tarayıcı-dışı ortamda no-op) ---- */
  async saveScanState(state: any) {
    if (typeof indexedDB === "undefined") return state;
    try {
      await idbPut(SCAN, { ...state, id: "current" });
    } catch { /* yarıda kalırsa sonraki sefere kaldığı yerden devam edemeyebilir; sessiz */ }
    return state;
  },

  async loadScanState(): Promise<any | null> {
    if (typeof indexedDB === "undefined") return null;
    try {
      const all = await idbAll(SCAN);
      return all.find((x) => x.id === "current") ?? null;
    } catch {
      return null;
    }
  },

  async clearScanState() {
    if (typeof indexedDB === "undefined") return;
    try { await idbClear(SCAN); } catch { /* yok say */ }
  },
};

export type Trade = {
  id: string;
  symbol: string;
  instType: string;
  side: string;
  status: string;
  entryPrice: number | null;
  exitPrice: number | null;
  qty: number | null;
  commission: number | null;
  leverage: number | null;
  openedAt: number | null;
  closedAt: number | null;
  pnlUsdt: number | null;
  pnlPct: number | null;
  rationale: string | null;
  createdAt: number;
};

export type Perf = {
  total: number; wins: number; losses: number; winRate: number;
  profitFactor: number; grossProfit: number; grossLoss: number; net: number;
  maxDrawdown: number; totalCommission: number;
};
