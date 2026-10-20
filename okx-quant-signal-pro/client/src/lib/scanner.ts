"use strict";

/**
 * 20'li sayfalı piyasa tarayıcı.
 * - Aktif USDT pariteleri gerçek OKX verisinden alınır (Spot / Futures ayrı).
 * - Öncelik: 1) yüksek hacim  2) likidite  3) düşük spread  4) işlem yapılabilir.
 * - Her turda tam 20 farklı coin (tekrar yok) analiz edilir.
 * - Tarama sırasında sabit enstrüman listesi snapshot'ı kullanılır.
 * - Taranan set IndexedDB'de kalıcı; kaldığı yerden devam eder, "Baştan Tara" sıfırlar.
 * - Kullanıcıya uygun coin sayısı 20'den azsa kalan sayı doğru gösterilir.
 */

import { fetchInstruments, fetchTickers, fetchCandles, fetchHistoryCandles, toBar } from "./okxPublic";
import { computeEarlySignal } from "./earlyEngine";
import { buildSignal, type Timeframe, type StrategyId, type Signal } from "./signalEngine";

/* Stabilcoin tabanlı çiftler hariç (stabilcoin/USDT çiftlerinde fırsat yok) */
const STABLE_BASES = new Set(["USDC", "FDUSD", "TUSD", "DAI", "EURT", "USDE", "PYUSD", "EUR", "USDP", "AEUR", "BUSD", "XUSD"]);

export type RankedCoin = {
  instId: string;
  skip: false;
} & Record<string, unknown>;

export type ScanProgress = {
  current: number;       // 1..20 (şu an taranan)
  total: number;         // her tur 20 (uygun coin az ise daha az)
  round: number;         // 1..N
  done: boolean;         // tüm enstrüman listesi bitti mi ( imminent.)
  scannedCount: number;  // bu seferde toplam taranan
  eligibleCount: number; // toplam uygun coin sayısı
  remainingCount: number;// kalan (eligible - scanned)
};

export type ScanResultRow = Signal | { symbol: string; side: string; score: number; price: number; timeframe: Timeframe; strategy: string[]; error: string };

export type ScanSnapshot = {
  instIds: string[];      // sabit snapshot (tur içi değişmez)
  scanned: string[];      // taranan coinler (tekrarları önler, kaldığı yeri tutar)
};

export type ScanOutput = {
  rows: ScanResultRow[];
  failed: { instId: string; reason: string }[];
  progress: ScanProgress;
  snapshot: ScanSnapshot;
  /** Her coin için gerçekten OKX'e gönderilen bar (tf uygulandığının kanıtı) */
  barsUsed: Record<string, string>;
  /** Eksik mum için geçmiş candle'ların getirilip geri doldurulduğu coinler */
  backfilled: string[];
  /** Kullanıcı taramayı durdurdu mu */
  stopped?: boolean;
};

/** Eksik mum varsa geçmiş candles endpoint'i ile geri doldurur */
async function getCandlesWithBackfill(instId: string, tf: Timeframe, limit = 300): Promise<{ candles: any[]; backfilled: boolean }> {
  const fresh = await fetchCandles(instId, tf, limit);
  let complete = fresh.filter((c: any) => c.confirm === undefined || c.confirm !== 0);
  let backfilled = false;
  if (complete.length < 210) {
    try {
      const hist = await fetchHistoryCandles(instId, tf, Math.min(1000, 600));
      const seen = new Set(complete.map((c: any) => c.ts));
      const merged = [...complete];
      for (const h of hist) {
        if (!seen.has(h.ts) && (h.confirm === undefined || h.confirm !== 0)) { merged.push(h); seen.add(h.ts); }
      }
      merged.sort((a: any, b: any) => a.ts - b.ts);
      if (merged.length > complete.length) { complete = merged.slice(-Math.max(300, complete.length)); backfilled = true; }
    } catch { /* history endpoint yok/hata → mevcut veriyle devam */ }
  }
  return { candles: complete, backfilled };
}

/* ---------- Uygun enstrüman seçimi ve öncelik sıralaması ---------- */
export function rankInstruments(insts: any[], tickers: any[], instType: "SPOT" | "SWAP"): string[] {
  const tickerMap = new Map<string, any>(tickers.map((t) => [t.instId, t]));
  const ranked = insts
    .filter((i) => {
      const id: string = i.instId || "";
      if (instType === "SPOT" && !id.endsWith("-USDT")) return false;
      if (instType === "SWAP" && !id.endsWith("-USDT-SWAP")) return false;
      // stabilcoin tabanlı çiftler hariç
      const base = instType === "SPOT" ? id.replace("-USDT", "") : id.replace("-USDT-SWAP", "");
      if (STABLE_BASES.has(base)) return false;
      const t = tickerMap.get(id);
      if (!t || t.last <= 0) return false; // fiyat yoksa uygun değil
      const spread = t.ask - t.bid;
      const mid = (t.ask + t.bid) / 2;
      const relSpread = mid > 0 ? spread / mid : 1;
      if (!(t.vol24h > 0)) return false;
      // Likidite/spread eşiği: relative spread %0.5 altı (genişçe tuttk ki 20 coin bulunabilsin)
      if (relSpread > 0.005) return false;
      return true;
    })
    .map((i) => {
      const t = tickerMap.get(i.instId);
      // hacim: swap'ta volCcy24h varsa onu kullan (USDT hacmi), yoksa vol24h * fiyat
      const volUsdt = t.volCcy24h ? t.volCcy24h : (t.vol24h || 0) * t.last;
      return { instId: i.instId as string, volUsdt, last: t.last, relSpread: (t.ask - t.bid) / ((t.ask + t.bid) / 2) };
    })
    .sort((a, b) => {
      // 1) hacim artan 2) (liği: daha küçük spread önce)
      if (b.volUsdt !== a.volUsdt) return b.volUsdt - a.volUsdt;
      return a.relSpread - b.relSpread;
    });
  return ranked.map((r) => r.instId);
}

export const BATCH_SIZE = 20;

export function nextBatch(snapshot: ScanSnapshot): string[] {
  const scanned = new Set(snapshot.scanned);
  return snapshot.instIds.filter((id) => !scanned.has(id)).slice(0, BATCH_SIZE);
}

export function makeProgress(snapshot: ScanSnapshot, current: number, eligibleCount: number, done: boolean): ScanProgress {
  // 1..20→tur1, 21..40→tur2 ... (tamamlanan turlar sonrası doğru tur gösterilir)
  const round = snapshot.scanned.length === 0 ? 1 : Math.floor((snapshot.scanned.length - 1) / BATCH_SIZE) + 1;
  return {
    current,
    total: Math.min(BATCH_SIZE, eligibleCount - snapshot.scanned.length),
    round,
    done,
    scannedCount: snapshot.scanned.length,
    eligibleCount,
    remainingCount: Math.max(0, eligibleCount - snapshot.scanned.length),
  };
}

/* ---------- Tek tur: sonraki 20 coini tar ---------- */
export async function scanNextBatch(opts: {
  instType: "SPOT" | "SWAP";
  timeframe: Timeframe;
  strategy: StrategyId[];
  prev?: ScanSnapshot | null;
  onRow?: (row: ScanResultRow, idx: number) => void;
  onProgress?: (p: ScanProgress) => void;
  /** Durdurma sinyali: true döndüğünde tarama daha fazla coin başlatmaz */
  shouldStop?: () => boolean;
  signal: (s: any) => Promise<void>;
}): Promise<ScanOutput> {
  const { instType, timeframe, strategy, onRow, onProgress, shouldStop } = opts;

  // 1) Sabit snapshot
  let snapshot: ScanSnapshot = opts.prev ?? { instIds: [], scanned: [] };
  if (snapshot.instIds.length === 0 || snapshot.instIds.length === 0) {
    const [insts, tickers] = await Promise.all([
      fetchInstruments(instType),
      fetchTickers(instType),
    ]);
    snapshot.instIds = rankInstruments(insts, tickers, instType);
  }

  const eligible = snapshot.instIds.length;
  // cache'lenmiş mumları temizle: her tur taze veri çekilsin (60s TTL zaten cache'liyor, sorun yok)

  // 2) Sonraki 20
  const batch = nextBatch(snapshot);
  if (batch.length === 0) {
    // Liste bitti
    const p = makeProgress({ ...snapshot, scanned: snapshot.scanned }, 0, eligible, true);
    onProgress?.(p);
    return { rows: [], failed: [], progress: p, snapshot, barsUsed: {}, backfilled: [] };
  }

  // 3) Art arda (kontrollü eşzamanlılık: OKX rate-limit için sıralı) tara
  const rows: ScanResultRow[] = [];
  const failed: { instId: string; reason: string }[] = [];
  const barsUsed: Record<string, string> = {};
  const backfilledCoins: string[] = [];
  const barSent = toBar(timeframe); // gerçekten OKX'e gönderilen bar
  const NaN_v = (v: any) => typeof v !== "number" || !isFinite(v);
  for (let idx = 0; idx < batch.length; idx++) {
    if (shouldStop?.()) {
      // Durduruldu: hiçbir yeni analiz başlatılmaz, tarananlar korumaya alınır
      const pStopped = makeProgress({ instIds: snapshot.instIds, scanned: snapshot.scanned }, idx, eligible, false);
      onProgress?.(pStopped);
      return { rows, failed, progress: pStopped, snapshot, barsUsed, backfilled: backfilledCoins, stopped: true };
    }
    const instId = batch[idx];
    onProgress?.(makeProgress({ instIds: snapshot.instIds, scanned: [...snapshot.scanned, ...batch.slice(0, idx)] }, idx + 1, eligible, false));
    try {
      const { candles, backfilled } = await getCandlesWithBackfill(instId, timeframe, 300);
      barsUsed[instId] = barSent;
      if (backfilled) backfilledCoins.push(instId);
      const clean = candles.filter((c: any) => !NaN_v(c.ts) && !NaN_v(c.close) && !NaN_v(c.open));
      if (clean.length < 200) {
        const row: ScanResultRow = {
          symbol: instId, side: "BEKLE", score: 0,
          price: clean.length ? clean[clean.length - 1].close : 0,
          timeframe, strategy: strategy as string[], error: "Yetersiz veri",
        };
        rows.push(row); onRow?.(row, idx);
        snapshot.scanned.push(instId);
        continue;
      }
      const sig = buildSignal({ symbol: instId, instType, candles: clean, timeframe, strategy });
      (sig as any).barSent = barSent;
      sig.strategy = [...strategy]; // kullanıcı seçiminin gerçekten uygulandığını kaydet
      // Erken fırsat motoru (3 katman): destek TF'ler 1H + 4H (tetik TF ile aynıysa kalibre etme)
      try {
        const oh = timeframe === "1h" ? null : await fetchCandles(instId, "1H", 320);
        const o4 = timeframe === "4h" ? null : await fetchCandles(instId, "4H", 320);
        const e = computeEarlySignal({
          symbol: instId,
          candles15: clean,
          candlesOneHour: oh,
          candlesFourHour: o4,
          timeframe: timeframe === "1h" ? "1h" : timeframe === "4h" ? "4h" : "15m",
          barSent,
        });
        (sig as any).early = e;
      } catch { /* erken motor hatası kartı engellemesin */ }
      rows.push(sig); onRow?.(sig, idx);
    } catch (e: any) {
      failed.push({ instId, reason: e?.message || "veri hatası" });
    }
    snapshot.scanned.push(instId);
  }

  const done = snapshot.scanned.length >= eligible || nextBatch(snapshot).length === 0;
  const progress = makeProgress(snapshot, BATCH_SIZE, eligible, done);
  onProgress?.(progress);
  return { rows, failed, progress, snapshot, barsUsed, backfilled: backfilledCoins };
}
