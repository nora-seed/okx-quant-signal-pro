"use strict";

/**
 * EARLY BREAKOUT ENGINE — erken fırsat tespiti.
 * Üç katman: A) fiyat/mum yapısı  B) volatilite+hacim  C) momentum+trend.
 * Fiyat yapısı ana kaynak; indikatörler destekleyici kanıt (çift puanlama engellendi).
 * Beş aşama: HAZIRLIK / ERKEN İZLE / AL ADAYI / ONAYLI AL / GEÇ KALINDI.
 * Sadece sinyal üretir; otomatik emir YOK.
 */

import type { Candle } from "./indicators";
import {
  ema, rsi, macd, atr, bollinger, adx, supertrend, vwap, volumeSma, relativeVolume, marketStructure, round,
} from "./indicators";

export type EarlyPhase = "HAZIRLIK" | "ERKEN_IZLE" | "AL_ADAYI" | "ONAYLI_AL" | "GEC_KALINDI" | "BEKLE" | "VERI_HATASI";

export type EarlyBreakdown = {
  yapi: number;       // 18
  hacim: number;      // 15
  sikisma: number;    // 12 (BBW)
  ema: number;        // 12
  macd: number;       // 10
  atr: number;        // 8
  rsi: number;        // 8
  vwap: number;       // 7
  formasyon: number;  // 7
  mum: number;        // 3
};

export type EarlyChecks = {
  validBreakoutClose: boolean;
  rvolOk: boolean;
  structure4hOk: boolean | null; // 4H veri yoksa null
  stopValid: boolean;
  rrOk: boolean;
  dataOk: boolean;
};

export type EarlySignal = {
  symbol: string;
  phase: EarlyPhase;
  score: number; // 0-100 teknik uygunluk (kazanma olasılığı DEĞİL)
  breakdown: EarlyBreakdown;
  checks: EarlyChecks;
  missing: string[];             // eksik teyitler (kullanıcı mesajı)
  reasons: string[];             // hangi koşullar sağlandı
  price: number;
  entryTrigger: number | null;   // tetikleyici giriş seviyesi
  stop: number | null;
  t1: number | null;
  t2: number | null;
  rr: string | null;
  invalidationPrice: number | null;
  resistance: number | null;
  reserveDistancePct: number | null; // dirence uzaklık %
  bbwPctile: number | null;      // 0-1
  atrPct: number | null;
  rvol: number | null;
  rsi: number | null;
  rsiSlope: number | null;      // 3 mumluk eğim
  macdAccel: number | null;
  timeframe: string;             // tetik TF
  barSent: string;               // gerçek OKX bar kodu
  barTs: number;                 // analiz mumu (tamamlanmış)
  dataAgeSec: number | null;     // veri güncelliği
  tf4h: "poztif" | "negatif" | "notr" | "yok";
  tf4hNote: string;
};

const PCT = {
  bbw15m: 0.20, bbw1h: 0.25,
  atr15m: 0.25,
  rvol15mErken: 1.25, rvol15mTeyit: 1.60,
  rvol1hErken: 1.20, rvol1hTeyit: 1.40,
  minRr: 1.8,
};

function lastN(arr: (number | null)[], n = 1): number | null {
  let count = 0;
  for (let i = arr.length - 1; i >= 0; i--) {
    const v = arr[i];
    if (v !== null && v !== undefined) {
      count++;
      if (count === n) return v;
    }
  }
  return null;
}

/* Seviye yuvarlama: 8 anlamlı basamak (0.000000000358 gibi mikro fiyatlar 0'a sönmesin) */
function r8(v: number | null): number | null {
  if (v == null || !isFinite(v)) return null;
  const a = Math.abs(v);
  if (a === 0) return 0;
  const dec = Math.max(0, 9 - Math.floor(Math.log10(a)) - 1);
  const p = Math.pow(10, dec);
  return Math.round(v * p) / p;
}

/* BBW: (upper-lower)/basis; yüzdelik dilim: değeri geçmiş BBBW window'daki konumu */
function bbwSeries(candles: Candle[]): (number | null)[] {
  const bb = bollinger(candles.map((c) => c.close));
  const out: (number | null)[] = [];
  for (let i = 0; i < candles.length; i++) {
    const u = bb.upper[i], l = bb.lower[i], b = bb.basis[i];
    out.push(u != null && l != null && b != null && b > 0 ? (u - l) / b : null);
  }
  return out;
}

function percentileRank(series: (number | null)[], endIdx: number, window: number, val: number | null): number | null {
  if (val == null) return null;
  const vals: number[] = [];
  for (let i = Math.max(0, endIdx - window); i < endIdx; i++) { // endIdx dahil DEĞİL → gelecek yok (look-ahead yok)
    const v = series[i];
    if (v != null) vals.push(v);
  }
  if (vals.length < 30) return null;
  const below = vals.filter((v) => v < val).length;
  return below / vals.length;
}

/* Yerel direnç: analiz mumu hariç önceki 20 tamamlanmış mumun en yükseği */
function priorResistance(candles: Candle[], i: number, lookback = 20): number | null {
  if (i < 1) return null;
  const s = Math.max(0, i - lookback), e = i - 1; // i dahil değil
  let hi = -Infinity;
  for (let k = s; k <= e; k++) hi = Math.max(hi, candles[k].high);
  return hi > 0 ? hi : null;
}

function slope(values: (number | null)[], i: number, steps = 3): number | null {
  if (i - steps < 0) return null;
  const cur = values[i], prev = values[i - steps];
  if (cur == null || prev == null) return null;
  return cur - prev;
}

/* Mum kapanış konumu & fitil analizi */
function candlePosition(c: Candle): { closePos: number; upperWick: number; lowerWick: number } {
  const range = c.high - c.low;
  if (range <= 0) return { closePos: 0.5, upperWick: 0, lowerWick: 0 };
  return {
    closePos: (c.close - c.low) / range,
    upperWick: (c.high - Math.max(c.open, c.close)) / range,
    lowerWick: (Math.min(c.open, c.close) - c.low) / range,
  };
}

export function computeEarlySignal(opts: {
  symbol: string;
  candles15: Candle[];   // tetik TF mıkárları (kronolojik, yalnız icrâların hesabı)
  candlesOneHour?: Candle[] | null;
  candlesFourHour?: Candle[] | null;
  timeframe: "15m" | "1h" | "4h";
  barSent: string;
}): EarlySignal {
  const { symbol, timeframe, barSent } = opts;
  const candles = opts.candles15.filter((c: any) => c.confirm === undefined || c.confirm !== 0);
  const now = Date.now();
  const base: EarlySignal = {
    symbol, phase: "VERI_HATASI", score: 0,
    breakdown: { yapi: 0, hacim: 0, sikisma: 0, ema: 0, macd: 0, atr: 0, rsi: 0, vwap: 0, formasyon: 0, mum: 0 },
    checks: { validBreakoutClose: false, rvolOk: false, structure4hOk: null, stopValid: false, rrOk: false, dataOk: false },
    missing: [], reasons: [],
    price: 0, entryTrigger: null, stop: null, t1: null, t2: null, rr: null, invalidationPrice: null,
    resistance: null, reserveDistancePct: null, bbwPctile: null, atrPct: null, rvol: null, rsi: null,
    rsiSlope: null, macdAccel: null, timeframe, barSent, barTs: 0, dataAgeSec: null,
    tf4h: "yok", tf4hNote: "",
  };
  if (candles.length < 150) {
    base.missing.push("Yetersiz veri (" + candles.length + " tamamlanmış mum)");
    return base;
  }
  base.checks.dataOk = true;
  const i = candles.length - 1; // son TAMAMLANMIŞ mum
  const c = candles[i];
  const barMs = timeframe === "15m" ? 15 * 60_000 : timeframe === "1h" ? 60 * 60_000 : 4 * 60 * 60_000;
  base.barTs = c.ts;
  base.dataAgeSec = Math.max(0, Math.round((now - (c.ts + barMs)) / 1000));

  const closes = candles.map((x) => x.close);
  const volumes = candles.map((x) => x.volume);
  const price = c.close;

  // Katman C temel hesaplar (t'e kadar; zaman serileri — look-ahead yok)
  const ema9 = ema(closes, 9), ema21 = ema(closes, 21), ema50 = ema(closes, 50);
  const rsi14 = rsi(closes, 14);
  const macdR = macd(closes);
  const atr14 = atr(candles, 14);
  const bbw = bbwSeries(candles);
  const rv = relativeVolume(candles, 20); // analiz mumu dahil; analini mom exclude isleşi asagida elle düzeltilir
  const vw = vwap(candles).vwap;

  const e9 = lastN(ema9), e21 = lastN(ema21), e50 = lastN(ema50);
  const rsiV = lastN(rsi14);
  const macdH = lastN(macdR.hist);
  const macdH3 = macdR.hist.slice(-4).filter((v): v is number => v != null).slice(0, 3);
  const atrV = lastN(atr14) ?? 0;
  const bbU = lastN(bbw), atrWin = atr14.slice(-4).filter((v): v is number => v != null).slice(0, 3);
  const atrPct = price > 0 ? (atrV / price) * 100 : null;
  const vwapV = lastN(vw);

  // RVOL: analiz mumu hacmi / önceki 20 tamamlanmış mum ortalaması (analiz mumu HARİÇ)
  let volAvg20 = 0;
  for (let k = Math.max(0, i - 20); k <= i - 1; k++) volAvg20 += volumes[k];
  volAvg20 = i >= 20 ? volAvg20 / 20 : volAvg20 / Math.max(1, i);
  const rvol = volAvg20 > 0 ? c.volume / volAvg20 : null;
  base.rvol = rvol != null ? round(rvol, 2) : null;
  base.atrPct = atrPct != null ? round(atrPct, 2) : null;
  base.rsi = rsiV != null ? round(rsiV, 1) : null;
  const rsiSlopeVal = slope(rsi14, i, 3) ?? 0;
  base.rsiSlope = round(rsiSlopeVal, 1);

  /* -- Katman A: yapı -- */
  const res = priorResistance(candles, i, 20);
  base.resistance = r8(res);
  base.reserveDistancePct = res != null && price > 0 ? Math.round(((res - price) / price) * 10000) / 100 : null;
  const nearRes = res != null && price > 0 && ((res - price) / price <= (0.5 * atrV) / price) && res - price >= 0;
  const breakoutClose = res != null && c.close > res && candlePosition(c).closePos >= 0.6;
  base.checks.validBreakoutClose = breakoutClose;

  // Higher low tespiti (son 8 tamamlanmış mum penceresi)
  const lows8 = candles.slice(Math.max(0, i - 8), i + 1);
  const hl = lows8.length >= 4 && lows8[lows8.length - 1].low > lows8[Math.floor(lows8.length / 2)].low && lows8[Math.floor(lows8.length / 2)].low > lows8[0].low;

  // Daralan aralık / konsolidasyon: son 24 mumbanda (max-min)/price küçük
  const band24 = candles.slice(Math.max(0, i - 23), i + 1);
  const hi24 = Math.max(...band24.map((x) => x.high)), lo24 = Math.min(...band24.map((x) => x.low));
  const bandPct = (hi24 - lo24) / price * 100;
  const tightRange = atrPct != null && bandPct < 6 * atrPct;

  // Rectangle: band24 içinde en az 2 üst / 2 alt temas
  const touchesTop = band24.filter((x) => x.high >= hi24 * 0.998).length >= 2;
  const touchesBottom = band24.filter((x) => x.low <= lo24 * 1.002).length >= 2;
  const rectangle = touchesTop && touchesBottom && bandPct < 6 * (atrPct ?? 1) && band24.length >= 12;

  /* -- Katman B: volatilite/hacim -- */
  const bbwPctile = percentileRank(bbw, i, 120, lastN(bbw));
  base.bbwPctile = bbwPctile != null ? round(bbwPctile, 2) : null;
  const squeezeThresh = timeframe === "15m" ? PCT.bbw15m : PCT.bbw1h;
  const squeeze = bbwPctile != null && bbwPctile <= squeezeThresh;
  const atrPctile = percentileRank(atr14, i, 120, atrV);
  const atrSqueeze = atrPctile != null && atrPctile <= PCT.atr15m;
  const rvolErken = rvol != null && rvol >= (timeframe === "15m" ? PCT.rvol15mErken : PCT.rvol1hErken);
  const rvolTeyit = rvol != null && rvol >= (timeframe === "15m" ? PCT.rvol15mTeyit : PCT.rvol1hTeyit);
  base.checks.rvolOk = rvolTeyit;

  /* -- Momentum -- */
  const rsiSlopeV = rsiSlopeVal;
  base.rsiSlope = round(rsiSlopeV, 1);
  const macdAccel = macdH3.length === 3 ? macdH3[2] - macdH3[0] : null;
  base.macdAccel = macdAccel != null ? round(macdAccel, 4) : null;
  const macdRising = macdR.hist.length >= 3 && macdH3.length === 3 && macdH3[2] > macdH3[0];
  const emaConv = atrV > 0 ? ((lastN(ema9)! - lastN(ema50)!) as number) / atrV : null;
  const emaConvNorm = emaConv != null ? Math.abs(emaConv) : null;
  const ema9Dir = slope(ema9, i, 3) ?? 0;
  const ema21Dir = slope(ema21, i, 3) ?? 0;
  const e9AboveE21 = e9! > e21!;
  const emaConverging = emaConvNorm != null && emaConvNorm <= PCTX.emaConvNum;

  /* -- VWAP teyidi -- */
  const aboveVwap = vwapV != null && price > vwapV;

  /* -- 4H ana trend -- */
  let tf4h: EarlySignal["tf4h"] = "yok";
  let tf4hNote = "";
  if (opts.candlesFourHour && opts.candlesFourHour.filter((x: any) => (x.confirm ?? 1) !== 0).length >= 55) {
    const c4 = opts.candlesFourHour.filter((x: any) => (x.confirm ?? 1) !== 0);
    const cl4 = c4.map((x: any) => x.close);
    const e9t = lastN(ema(cl4, 9)), e21t = lastN(ema(cl4, 21)), e50t = lastN(ema(cl4, 50));
    if (e9t != null && e21t != null) {
      if (e9t > e21t && e21t != null && e50t != null && e21t > e50t) { tf4h = "poztif"; tf4hNote = "4H EMA9>21>50"; }
      else if (e9t < e21t && e50t != null && e21t < e50t) { tf4h = "negatif"; tf4hNote = "4H EMA9<21<50"; }
      else { tf4h = "notr"; tf4hNote = "4H EMA karışık"; }
    }
  } else { tf4hNote = "4H veri yok"; }
  base.tf4h = tf4h === "poztif" ? "poztif" : tf4h;
  base.tf4hNote = tf4hNote;
  base.checks.structure4hOk = tf4h === "yok" ? null : tf4h !== "negatif";

  /* ---------------- PUANLAMA (100) ---------------- */
  const bd: EarlyBreakdown = { ...base.breakdown };
  // A) Direnç/yapı (18): erken aday 8; kapanış-onaylı kırılım +18
  if (breakoutClose) bd.yapi = 18;
  else if (nearRes) { bd.yapi = 10; base.reasons.push(`Direnç yakını (%${base.reserveDistancePct} uzaklık)`); }
  else if (hl) { bd.yapi = 6; base.reasons.push("Yükselen dip yapısı"); }
  // B) RVOL (15): teyit 15 / erken 8 / neredeyse 4
  if (rvolTeyit) { bd.hacim = 15; base.reasons.push("Hacim patlaması RVOL " + round(rvol!, 2) + "x"); }
  else if (rvolErken) { bd.hacim = 8; base.reasons.push("Hacim canlanması RVOL " + round(rvol!, 2) + "x"); }
  else if (rvol != null && rvol >= 1.05) bd.hacim = 4;
  // BBW sıkışma (12)
  if (squeeze) { bd.sikisma = 12; base.reasons.push("Bollinger sıkışması (BBW yüzdelik " + round((bbwPctile ?? 0) * 100, 0) + ")"); }
  else if (bbwPctile != null && bbwPctile <= squeezeThresh * 1.5) bd.sikisma = 5;
  // EMA yakınsama/yön (12)
  if (emaConverging && rsiV != null && rsiV >= 45 && rsiSlopeV > 0) { bd.ema = 12; base.reasons.push("EMA yakınsaması + RSI güçleniyor"); }
  else if (emaConverging) bd.ema = 5;
  else if (ema9Dir > 0 && (ema21Dir >= 0) && e9AboveE21) { bd.ema = 8; base.reasons.push("EMA dizilimi pozitif"); }
  // MACD ivmesi (10)
  if (macdRising && macdAccel != null && macdH !== null && macdH > 0) { bd.macd = 10; base.reasons.push("MACD histogram yükseliyor ve pozitif"); }
  else if (macdRising) bd.macd = 5;
  // ATR sıkışma (8)
  if (atrSqueeze) { bd.atr = 8; base.reasons.push("ATR sıkışması (yüzdelik " + round((atrPctile ?? 0) * 100, 0) + ")"); }
  else if (atrPctile != null && atrPctile <= 0.4) bd.atr = 3;
  // RSI eğimi (8)
  if (rsiV != null && rsiSlopeV > 0 && rsiV >= 45 && rsiV <= 70) bd.rsi = 8;
  else if (rsiV != null && rsiSlopeV > 0) bd.rsi = 4;
  // VWAP (7)
  if (aboveVwap) { bd.vwap = 7; base.reasons.push("VWAP üstünde"); }
  // Formasyon (7): rectangle veya tight range veya bull flag (kısmi)
  if (rectangle) { bd.formasyon = 7; base.reasons.push("Rectangle konsolidasyon temas sayısı yeterli"); }
  else if (tightRange && touchesTop) { bd.formasyon = 5; base.reasons.push("Dikkat: daralan aralık + üst bölge teması (bull flag adayı)"); }
  else if (tightRange) { bd.formasyon = 3; base.reasons.push("Daralan yatay aralık"); }
  // Mum teyidi (3): kapanış konumu
  const cp = candlePosition(c);
  if (cp.closePos >= 0.7) { bd.mum = 3; }
  else if (cp.closePos >= 0.55) bd.mum = 1;
  // Yanlış kırılım cezası: üst fitil büyük + res üstünden kapanamadıysa
  const fakeout = res != null && c.high > res && breakoutClose === false && cp.upperWick > 0.5;
  if (fakeout) { base.reasons.push("Şüpheli kırılım (üst fitil büyük, kapanış direnç altında) — fakeout olasılığı"); bd.yapi = Math.max(0, bd.yapi - 6); bd.hacim = Math.max(0, bd.hacim - 5); }

  const score = Math.min(100, bd.yapi + bd.hacim + bd.sikisma + bd.ema + bd.macd + bd.atr + bd.rsi + bd.vwap + bd.formasyon + bd.mum);
  base.breakdown = bd;
  base.score = score;
  base.price = price;

  /* ---------------- Giriş/Stop/TP ---------------- */
  if (res != null && atrV > 0) {
    const trig = breakoutClose ? price : Math.min(res + 0.05 * atrV, res * 1.005);
    base.entryTrigger = r8(trig);
    const swingLows = lows8.map((x) => x.low);
    let stop = swingLows[swingLows.length - 1] - 0.2 * atrV;
    if (stop >= trig) stop = trig - 1.2 * atrV; // anlamlı stop yoksa yapısal değil ATR tabanlı
    base.stop = r8(stop);
    const risk = trig - stop;
    base.t1 = r8(trig + risk);
    base.t2 = r8(trig + 2 * risk);
    base.rr = risk > 0 ? round(2 / 1, 2) + ":1" : null; // T2=2R → RR 1:2
    base.invalidationPrice = base.stop;
    base.checks.stopValid = risk > 0 && risk < price * 0.2;
    const rrNum = risk > 0 ? 2 : 0;
    base.checks.rrOk = rrNum >= PCT.minRr;
  }

  /* ---------------- AŞAMA (durum makinesi) ---------------- */
  const late = res != null && atrV > 0 && (price > res + 2 * atrV || (e21 != null && price > e21 + 2 * atrV));
  base.phase = "BEKLE";
  if (!base.checks.dataOk) return { ...base, phase: "VERI_HATASI" };
  if (late && score >= 40) {
    base.phase = "GEC_KALINDI";
    base.missing = ["Hareket uzamış: fiyat kırılım tetiğinin 2 ATR üzerinde"];
    return base;
  }
  if (score >= PCTX.confirmMin && breakoutClose && rvolTeyit && (base.checks.structure4hOk !== false) && base.checks.stopValid && base.checks.rrOk) {
    base.phase = "ONAYLI_AL";
    base.reasons.push("Tamamlanmış mumda geçerli kırılım + hacim + 4H uyumu + geçerli stop/RR");
    return base;
  }
  if (score >= PCTX.adayMin) {
    base.phase = "AL_ADAYI";
    base.missing = missingOf(base, breakoutClose, rvolErken || rvolTeyit);
    return base;
  }
  if (score >= PCTX.izleMin) {
    base.phase = "ERKEN_IZLE";
    base.missing = missingOf(base, breakoutClose, rvolErken || rvolTeyit);
    return base;
  }
  if (score >= PCTX.hazirlikMin || ((squeeze || emaConverging) && score >= 30)) {
    base.phase = "HAZIRLIK";
    base.missing = ["Giriş teyidi yok — takip edilmeli"];
    return base;
  }
  return base;
}

const PCTX = { hazirlikMin: 40, izleMin: 55, adayMin: 65, confirmMin: 75, emaConvNum: 0.80 };

function missingOf(sig: EarlySignal, breakout: boolean, volOk: boolean): string[] {
  const m: string[] = [];
  if (!breakout) m.push("kırılım kapanışı yok (fiyat direncin üzerine kapanmadı)");
  if (!volOk) m.push("hacim onayı eşiği altında (RVOL " + (sig.rvol ?? "-") + ")");
  if (sig.checks.structure4hOk === false) m.push("4H trend ters yönde");
  if (!sig.checks.rrOk) m.push("RR 1:" + PCT.minRr + " altı");
  if (m.length === 0) m.push("puan eşiği aşıldı, zorunlu teyitlerin hepsi bekleniyor");
  return m;
}
