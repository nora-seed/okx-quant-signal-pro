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

/* ---------- Fırsat takibi + Sanal işlem (IndexedDB) ---------- */

export type Opportunity = {
  id: string; // symbol|triggerTf
  symbol: string;
  triggerTf: string;
  firstSeenTs: number;
  lastSeenTs: number;
  firstScore: number;
  maxScore: number;
  firstPhase: string;
  curPhase: string;
  maxPhase: string;
  phaseHistory: string[];
  breakoutTs?: number;
  invalidTs?: number;
  lastEntry?: number | null;
  lastStop?: number | null;
  lastT1?: number | null;
  lastT2?: number | null;
  lastRvol?: number | null;
  lastBbwPct?: number | null;
  lastReasons?: string[];
};

const OPS = "opportunities", PAPERS = "paperTrades";

export type PaperTrade = {
  id: string;
  symbol: string;
  triggerTf: string;
  side: "AL";
  openedTs: number;
  entry: number;
  stop: number;
  t1: number;
  t2: number;
  quantity: number; // sanal adet
  feeBps: number;
  slippageBps: number;
  status: "open" | "kapandi";
  closeReason?: "t1" | "t2" | "stop" | "manuel" | "sure";
  closedTs?: number;
  exitPrice?: number;
  pnlUsdt?: number;
  barsEvaluated?: number;
};

export const apiExtras = {
  /** Fırsatı güncelleme: aynı fırsatın ilerlemesini kaydet (yeni ilgisiz sinyal yerine). */
  async upsertOpportunity(sym: string, tf: string, nowTs: number, row: {
    score: number; phase: string; entryTrigger: number | null; stop: number | null;
    t1: number | null; t2: number | null; rvol: number | null; bbwPctile: number | null;
    reasons: string[];
  }): Promise<Opportunity> {
    const id = sym + "|" + tf;
    let cur: Opportunity | undefined;
    try {
      const all = typeof indexedDB !== "undefined" ? await idbAll<Opportunity>(OPS) : [];
      cur = all.find((o) => o.id === id);
    } catch { /* yok say */ }
    const phases = ["VERI_HATASI", "BEKLE", "GEC_KALINDI", "HAZIRLIK", "ERKEN_IZLE", "AL_ADAYI", "ONAYLI_AL"];
    const maxPh = (a: string, b: string) => (phases.indexOf(a) >= phases.indexOf(b) ? a : b);
    if (!cur) {
      cur = {
        id, symbol: sym, triggerTf: tf,
        firstSeenTs: nowTs, lastSeenTs: nowTs,
        firstScore: row.score, maxScore: row.score,
        firstPhase: row.phase, curPhase: row.phase, maxPhase: row.phase,
        phaseHistory: [row.phase],
      };
    } else {
      if (row.score > cur.maxScore) cur.maxScore = row.score;
      const prevPh = cur.curPhase;
      cur.curPhase = row.phase;
      if (row.phase !== prevPh && !cur.phaseHistory.includes(row.phase)) cur.phaseHistory.push(row.phase);
      // yeni aşama yükseldiğinde kırılım anını kaydet
      if (prevPh !== "ONAYLI_AL" && row.phase === "ONAYLI_AL" && !cur.breakoutTs) cur.breakoutTs = nowTs;
      if (prevPh !== "GEC_KALINDI" && row.phase === "GEC_KALINDI" && !cur.invalidTs) cur.invalidTs = nowTs;
    }
    cur.lastSeenTs = nowTs;
    cur.maxPhase = maxPh(cur.maxPhase, row.phase);
    cur.lastEntry = row.entryTrigger; cur.lastStop = row.stop;
    cur.lastT1 = row.t1; cur.lastT2 = row.t2;
    cur.lastRvol = row.rvol; cur.lastBbwPct = row.bbwPctile;
    cur.lastReasons = row.reasons.slice(0, 6);
    if (typeof indexedDB !== "undefined") {
      try { await idbPut(OPS, cur); } catch { /* yok say */ }
    }
    return cur;
  },

  async listOpportunities(): Promise<Opportunity[]> {
    if (typeof indexedDB === "undefined") return [];
    try { return await idbAll<Opportunity>(OPS); } catch { return []; }
  },

  async clearOpportunities() {
    if (typeof indexedDB === "undefined") return;
    try { await idbClear(OPS); } catch { /* yok say */ }
  },

  /** Sanal işlem başlat — gerçek emir GÖNDERİLMEZ. */
  async openPaperTrade(t: Omit<PaperTrade, "id" | "status">): Promise<PaperTrade> {
    const rec: PaperTrade = { ...t, id: "pt_" + t.openedTs + "_" + Math.floor(Math.random() * 9999), status: "open" };
    if (typeof indexedDB !== "undefined") {
      try { await idbPut(PAPERS, rec); } catch { /* yok say */ }
    }
    return rec;
  },

  async listPaperTrades(): Promise<PaperTrade[]> {
    if (typeof indexedDB === "undefined") return [];
    try { return await idbAll<PaperTrade>(PAPERS); } catch { return []; }
  },

  async putPaperTrade(t: PaperTrade) {
    if (typeof indexedDB === "undefined" || !t.id) return;
    try { await idbPut(PAPERS, t); } catch { /* yok say */ }
  },

  /** Açık sanal işlemler: App açıldığında geçmiş veriyle değerlendir.
   *  Not: PWA kapalıyken fiyat takibi yapılamaz; yeniden açıldığında gözden geçirilir.
   */
  async evaluateOpenPaperTrades(applyFeeBps = 10) {
    const trades = await this.listPaperTrades();
    const updates: PaperTrade[] = [];
    for (const t of trades.filter((x) => x.status === "open")) {
      try {
        const tfBar = t.triggerTf;
        const oPublic = (await import("./lib/okxPublic"));
        const list = (await oPublic.fetchCandles(t.symbol, tfBar, 100)) as any[];
        const listOk = list.filter((c: any) => c.close != null && c.ts != null).sort((a: any, b: any) => a.ts - b.ts);
        const seq = listOk.filter((c: any) => {
          const endTs = t.triggerTf === "4H" ? c.ts + 4 * 3600_000 : t.triggerTf === "1H" ? c.ts + 3600_000 : c.ts + 900_000;
          return endTs >= t.openedTs && (c.confirm !== 0);
        });
        let exit: number | undefined, why: PaperTrade["closeReason"], closedTs: number | undefined;
        for (const c of seq) {
          if (c.low <= t.stop) { exit = t.stop; why = "stop"; closedTs = c.ts; break; }
          if (c.high >= t.t2) { exit = t.t2; why = "t2"; closedTs = c.ts; break; }
          if (c.high >= t.t1) { exit = t.t1; why = "t1"; closedTs = c.ts; break; }
        }
        if (exit != null && why != null) {
          const slip = t.slippageBps / 10000;
          const entryP = t.entry * (1 + slip);
          const exitP = why === "stop" ? exit * (1 - slip) : exit;
          const gross = (exitP - entryP) * t.quantity;
          const fees = (entryP + exitP) * t.quantity * (t.feeBps / 10000);
          t.status = "kapandi";
          t.closeReason = why;
          t.closedTs = closedTs ?? Date.now();
          t.exitPrice = exit;
          t.pnlUsdt = gross - fees;
          updates.push(t);
        }
      } catch { /* veri yoksa işlemden vazgeç; bir sonraki sefere tekrar dener */ }
    }
    for (const u of updates) await this.putPaperTrade(u);
    return updates;
  },
};
