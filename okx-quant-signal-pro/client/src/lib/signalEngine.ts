"use strict";

/**
 * Sinyal Karar Motoru.
 * Kural tabanlı, gerekçeli, düşük kaliteli sinyalleri elemek odaklı.
 * Otomatik al-sat YOK - sadece sinyal.
 */

import type { Candle, IndicatorResult } from "./indicators";
import {
  ema, sma, rsi, macd, stochRsi, atr, bollinger, adx, supertrend,
  obv, vwap, volumeSma, relativeVolume, swingPoints, supportResistance, marketStructure, round,
} from "./indicators";

export type Timeframe = "1m" | "5m" | "15m" | "30m" | "1h" | "4h" | "1d";

export type StrategyId =
  | "trend" | "ema" | "rsimacd" | "breakout" | "srretest" | "bbmean"
  | "momentum" | "scalp" | "mtf" | "multi";

export type SignalSide = "SPOT_AL" | "SPOT_SAT" | "FUTURES_LONG" | "FUTURES_SHORT" | "BEKLE";

export type Signal = {
  rejectReasons?: string[];
  symbol: string;
  instType: string;
  side: SignalSide;
  score: number; // 0-100
  price: number;
  entry: number | null;
  stopLoss: number | null;
  tp1: number | null;
  tp2: number | null;
  tp3: number | null;
  rr: string | null;
  timeframe: Timeframe;
  generatedAt: number;
  expiresAt: number;
  rationale: string[];
  invalidation: string[];
  indicators: Record<string, unknown>;
  strategy: StrategyId[];
};

const MIN_RR_DEFAULT = 2; // 1:2

/* ---------- Indicator helpers (son değer) ---------- */
function last<T>(arr: (T | null)[]): T | null {
  for (let i = arr.length - 1; i >= 0; i--) if (arr[i] !== null) return arr[i];
  return null;
}

function lastN<T>(arr: (T | null)[], n: number): T[] {
  const out: T[] = [];
  for (let i = arr.length - 1; i >= 0 && out.length < n; i--) if (arr[i] !== null) out.push(arr[i] as T);
  return out;
}

/* ---------- Signal scoring ---------- */
export function buildSignal({
  symbol,
  instType,
  candles,
  timeframe,
  strategy = ["multi"],
  minRr = MIN_RR_DEFAULT,
}: {
  symbol: string;
  instType: string;
  candles: Candle[];
  timeframe: Timeframe;
  strategy?: StrategyId[];
  minRr?: number;
}): Signal {
  const rationale: string[] = [];
  const invalidation: string[] = [];
  // Tamamlanmamış (in-progress) son mumu çıkar — göreceli hacim ve kapanış algısı bozulmasını önler
  const complete = candles.filter((c: any) => c.confirm === undefined || c.confirm !== 0);
  const n = complete.length;
  const candlesArr = n > 0 ? complete : candles;
  const cc = candlesArr;
  const closes = cc.map((c: any) => c.close);
  const highs = cc.map((c: any) => c.high);
  const lows = cc.map((c: any) => c.low);
  const volumes = cc.map((c: any) => c.volume);
  const price = last(closes) ?? 0;

  if (n < 200) {
    const early = finalSignal(symbol, instType, "BEKLE", 0, price, null, null, null, null, null,
      null, timeframe, ["Yetersiz mum verisi (en az 200 gerekir)."], ["Veri yetersiz"], { timeframe }, strategy);
    early.rejectReasons = ["Yetersiz veri (" + n + " mum, en az 200 gerekir)"];
    return early;
  }

  const ema9 = ema(closes, 9);
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const ema100 = ema(closes, 100);
  const ema200 = ema(closes, 200);
  const sma50 = sma(closes, 50);
  const sma200 = sma(closes, 200);
  const rsi14 = rsi(closes, 14);
  const macdRes = macd(closes);
  const stoch = stochRsi(closes);
  const atr14 = atr(cc, 14);
  const bb = bollinger(closes);
  const adxRes = adx(cc, 14);
  const st = supertrend(cc, 10, 3);
  const obvRes = obv(cc);
  const vwapRes = vwap(cc);
  const relVol = relativeVolume(cc, 20);
  const volSma = volumeSma(cc, 20);

  const c = price;
  const e9 = last(ema9) ?? c;
  const e20 = last(ema20) ?? c;
  const e50 = last(ema50) ?? c;
  const e200 = last(ema200) ?? c;
  const rsiVal = last(rsi14) ?? 50;
  const macdLine = last(macdRes.macd) ?? 0;
  const macdSig = last(macdRes.signal) ?? 0;
  const macdHist = last(macdRes.hist) ?? 0;
  const atrVal = last(atr14) ?? 0;
  const bbUpper = last(bb.upper) ?? c;
  const bbLower = last(bb.lower) ?? c;
  const bbBasis = last(bb.basis) ?? c;
  const stDir = last(st.direction) ?? 0;
  const stVal = last(st.supertrend) ?? c;
  const rv = last(relVol) ?? 1;
  const curVol = last(volumes) ?? 0;
  const avgVol = last(volSma) ?? curVol;

  // Trend yönü (EMA yığınlığı)
  let trend: 1 | -1 | 0 = 0;
  if (c > e9 && e9 > e20 && e20 > e50 && e50 > e200) trend = 1;
  else if (c < e9 && e9 < e20 && e20 < e50 && e50 < e200) trend = -1;
  const adxVal = lastN(adxRes.adx, 1)[0] ?? 0;
  const strongTrend = adxVal > 25;

  const structure = marketStructure(cc as any, 2, 2);
  const levels = supportResistance(cc as any, 200);

  // Temel hacim onayı: son mum ortalamayı geçti mi? (patlama için 1.2 breakout puanlarında korunur)
  const volConfirmed = rv > 1.0;

  // ---------------- Strateji puanlama ----------------
  const scores: Record<string, number> = {};
  const reasons: Record<string, string[]> = {};

  function add(strategy: StrategyId, pts: number, reason: string) {
    scores[strategy] = (scores[strategy] || 0) + pts;
    (reasons[strategy] ||= []).push(reason);
  }

  // 1. Trend Following
  if (trend === 1 && stDir === 1 && rsiVal > 50 && rsiVal < 70 && strongTrend) {
    add("trend", 30, "Yukarı trend yapısı (EMA sıralaması + Supertrend yukarı)");
  } else if (trend === -1 && stDir === -1 && rsiVal < 50 && rsiVal > 30 && strongTrend) {
    add("trend", 30, "Aşağı trend yapısı (EMA sıralaması + Supertrend aşağı)");
  } else if (Math.abs(trend) === 1) {
    add("trend", 10, "Trend yönü tespit edildi ancak zayıf");
  } else if (stDir !== 0 && Math.sign(macdHist || stDir) === stDir) {
    // Supertrend yönü var, EMA istifi tam değil → kısmi trend puanı
    const partialUp = e9 > e20 && e20 > e50;
    const partialDown = e9 < e20 && e20 < e50;
    if (stDir === 1 && partialUp) add("trend", 15, "Kısmi yukarı trend (EMA9>20>50, Supertrend yukarı)");
    else if (stDir === -1 && partialDown) add("trend", 15, "Kısmi aşağı trend (EMA9<20<50, Supertrend aşağı)");
    else if (adxVal >= 20) add("trend", 10, "Supertrend yönü + ADX makul, EMA istifi tam değil");
  }

  // 2. EMA Crossover
  const prevC = closes[closes.length - 2] ?? c;
  const prevE9 = ema9[ema9.length - 2] ?? e9;
  const prevE20 = ema20[ema20.length - 2] ?? e20;
  if (prevC <= prevE20 && c > e20 && e9 > e20) add("ema", 30, "EMA9/EMA20 pozitif kesişim");
  else if (prevC >= prevE20 && c < e20 && e9 < e20) add("ema", 30, "EMA9/EMA20 negatif kesişim");
  else if (c > e20 && e9 > e20) add("ema", 10, "Fiyat EMA20 üstünde, EMA9 yukarı");
  else if (c < e20 && e9 < e20) add("ema", 10, "Fiyat EMA20 altında, EMA9 aşağı");

  // 3. RSI + MACD
  if (rsiVal < 35 && macdHist > 0) add("rsimacd", 30, "RSI aşırı satışta + MACD pozitif hareket");
  else if (rsiVal > 65 && macdHist < 0) add("rsimacd", 30, "RSI aşırı alımda + MACD negatif hareket");
  else if ((rsiVal < 45 && macdLine > macdSig)) add("rsimacd", 10, "RSI düşük + MACD yukarı");
  else if ((rsiVal > 55 && macdLine < macdSig)) add("rsimacd", 10, "RSI yüksek + MACD aşağı");

  // 4. Breakout + Volume
  const resLevels = levels.resistance.slice(0, 3);
  const supLevels = levels.support.slice(0, 3);
  const nearRes = resLevels.some((l) => Math.abs(c - l.price) / c < 0.005);
  const nearSup = supLevels.some((l) => Math.abs(c - l.price) / c < 0.005);
  const hh = structure.hhhl;
  if (nearRes && volConfirmed && trend === 1) add("breakout", 30, "Direnç kırımı + hacim onayı + yukarı trend");
  else if (nearSup && volConfirmed && trend === -1) add("breakout", 30, "Destek kırımı + hacim onayı + aşağı trend");
  else if (hh && volConfirmed) add("breakout", 10, "Yapısal kırılım + hacim");

  // 5. Support/Resistance Retest
  const retestBull = nearSup && trend === 1 && rsiVal > 40 && rsiVal < 60;
  const retestBear = nearRes && trend === -1 && rsiVal > 40 && rsiVal < 60;
  if (retestBull) add("srretest", 30, "Destek yeniden testi + yukarı trend + moment nötr");
  if (retestBear) add("srretest", 30, "Direnç yeniden testi + aşağı trend + moment nötr");

  // 6. Bollinger Mean Reversion
  if (c <= bbLower && rsiVal < 35 && trend !== -1) add("bbmean", 30, "Alt Bant testinde + aşırı satış + mean reversion");
  if (c >= bbUpper && rsiVal > 65 && trend !== 1) add("bbmean", 30, "Üst Bant testinde + aşırı alım + mean reversion");
  if (c > bbBasis && c < bbUpper && trend === 1) add("bbmean", 10, "Bant ortası üstünde, yukarı");
  if (c < bbBasis && c > bbLower && trend === -1) add("bbmean", 10, "Bant ortası altında, aşağı");

  // 7. Momentum
  if (rsiVal > 55 && rsiVal < 75 && macdHist > 0 && trend === 1 && rv > 1.2) add("momentum", 30, "Pozitif moment + hacim + yukarı trend");
  if (rsiVal < 45 && rsiVal > 25 && macdHist < 0 && trend === -1 && rv > 1.2) add("momentum", 30, "Negatif moment + hacim + aşağı trend");

  // 8. Scalping (kısa periyot, hızlı tersיין)
  const stochK = last(stoch.k) ?? 50;
  const stochD = last(stoch.d) ?? 50;
  if (trend === 1 && rsiVal < 30 && stochK > stochD && stDir === 1) add("scalp", 30, "Scalping: dip alım, yukarı trende uygun");
  if (trend === -1 && rsiVal > 70 && stochK < stochD && stDir === -1) add("scalp", 30, "Scalping: tepe satış, aşağı trende uygun");

  // 9. Multi-Timeframe Confirmation (simulated via higher TF data passed separately - here use trend+st+adx)
  if (trend !== 0 && stDir === trend && strongTrend && volConfirmed) add("mtf", 30, "Trend/Supertrend/ADX/hacım uyumlu");

  // 10. Multi-strategy approval
  const activeStrategies = strategy.includes("multi") ? Object.keys(scores) as StrategyId[] : strategy;
  let totalScore = 0;
  let maxStrategyScore = 0;
  let bestStrategy: StrategyId | null = null;
  for (const s of activeStrategies) {
    const v = scores[s] || 0;
    totalScore += v;
    if (v > maxStrategyScore) { maxStrategyScore = v; bestStrategy = s; }
  }
  const strategyCount = activeStrategies.filter((s) => (scores[s] || 0) > 0).length;
  const consensusBonus = strategyCount > 1 ? Math.min(15, strategyCount * 5) : 0;
  let score = Math.min(100, totalScore + consensusBonus);

  // ---------------- Yön & Geçerlilik ----------------
  let side: SignalSide = "BEKLE";
  const rejectReasons: string[] = [];

  const bullishSignals = trend === 1 || stDir === 1 || macdHist > 0;
  const bearishSignals = trend === -1 || stDir === -1 || macdHist < 0;

  const dirScores: number[] = [];
  for (const s of activeStrategies) {
    const v = scores[s] || 0;
    if (v > 0) dirScores.push(v);
  }
  const hasDirection = dirScores.length > 0;

  if (instType === "SPOT") {
    // Spot sadece AL (long) veya SAT/ÇIK; kaldıraçsız short yok
    if (bullishSignals && score >= 40 && volConfirmed) side = "SPOT_AL";
    else if (bearishSignals && score >= 40 && volConfirmed) side = "SPOT_SAT";
  } else {
    if (bullishSignals && score >= 40 && volConfirmed) side = "FUTURES_LONG";
    else if (bearishSignals && score >= 40 && volConfirmed) side = "FUTURES_SHORT";
  }

  // Zayıf trend / çelişki -> BEKLE (bu güçlendirme pusu sonrası ret sebepleri toplanır)
  if (!strongTrend && structure.sideways && score < 50) side = "BEKLE";
  if (adxVal < 20 && score < 60) side = "BEKLE";

  // Gerçekçi ret sebepleri (tüm BEKLE geçişlerinden sonra toplanır)
  if (side === "BEKLE") {
    if (n < 200) rejectReasons.push("Yetersiz veri (" + n + " mum, en az 200 gerekir)");
    if (!hasDirection) rejectReasons.push("Strateji koşulları sağlanmadı (hiçbir strateji puan üretemedi)");
    else {
      if (rv <= 1.0) rejectReasons.push("Düşük hacim (göreceli hacim " + round(rv, 2) + "x < 1.0x)");
      if (score < 40) rejectReasons.push("Uyum puanı düşük (puan " + score + " < 40, en iyi strateji: " + (bestStrategy ?? "-") + ")");
      else {
        const trendOk = strongTrend || !structure.sideways;
        if (!trendOk && adxVal < 20 && score < 60) rejectReasons.push("Trend uyumsuzluğu (ADX " + round(adxVal, 1) + ", yatay yapı, puan " + score + ")");
        else if (!trendOk && score < 50) rejectReasons.push("Trend zayıf / yatay yapı (puan " + score + " < 50)");
        else if (adxVal < 20 && score < 60) rejectReasons.push("Zayıf trend (ADX " + round(adxVal, 1) + " < 20, puan " + score + " < 60)");
        else if (bullishSignals && bearishSignals) rejectReasons.push("Yön çelişkisi (bullish ve bearish onaylar birlikte)");
      }
    }
    if (rejectReasons.length === 0) rejectReasons.push("Koşullar kısmen sağlandı, teyit tamamlanamadı");
  }

  // ---------------- Giriş / Stop / TP (ATR ve yapı bazlı) ----------------
  let entry: number | null = null;
  let sl: number | null = null;
  let tp1: number | null = null;
  let tp2: number | null = null;
  let tp3: number | null = null;
  let rr: string | null = null;

  const atrSlMult = 1.5;
  const atrRr = [1, 2, 3];
  const long = side === "SPOT_AL" || side === "FUTURES_LONG";

  if (side !== "BEKLE") {
    entry = c;
    if (long) {
      sl = c - atrVal * atrSlMult;
      // destek seviyesi varsa daha dar SL
      const nearSupP = supLevels.find((l) => l.price < c && c - l.price < atrVal * 2);
      if (nearSupP) sl = Math.max(sl!, nearSupP.price - atrVal * 0.5);
      const risk = c - sl!;
      tp1 = c + risk * 1;
      tp2 = c + risk * 2;
      tp3 = c + risk * 3;
    } else {
      sl = c + atrVal * atrSlMult;
      const nearResP = resLevels.find((l) => l.price > c && l.price - c < atrVal * 2);
      if (nearResP) sl = Math.min(sl!, nearResP.price + atrVal * 0.5);
      const risk = sl! - c;
      tp1 = c - risk * 1;
      tp2 = c - risk * 2;
      tp3 = c - risk * 3;
    }
    if (sl && entry) {
      const risk = Math.abs(entry - sl);
      const reward = Math.abs((tp3 ?? entry) - entry);
      rr = risk > 0 ? `${round(reward / risk, 2)}:1` : null;
    if (rr) {
      const rrNum = parseFloat(rr.split(":")[0]);
      if (rrNum < minRr) {
        side = "BEKLE";
        rejectReasons.push("Düşük risk/ödül (RR 1:" + rrNum + " < 1:" + minRr + ")");
      }
    }
    }
  }
  // Geçersizlik koşulları
  if (side !== "BEKLE") {
    if (long) invalidation.push(`Fiyat ${formatNum(sl!)} altına kapanırsa sinyal geçersiz (Stop)`);
    else invalidation.push(`Fiyat ${formatNum(sl!)} üstüne kapanırsa sinyal geçersiz (Stop)`);
    invalidation.push("Trend eğimi ters yönde iki periyot sürerse geçersiz");
  }

  if (side === "BEKLE") {
    if (rejectReasons.length) rationale.push("BEKLE: " + rejectReasons.join(" · "));
    else rationale.push("Yeterli onay yok / minimum risk/ödül sağlanamıyor / trend yatay");
    invalidation.push("Yeni onay oluştuğunda değerlendirilir");
  } else {
    const dirTxt = long ? "AL/LONG" : "SAT/SHORT";
    rationale.push(`${dirTxt} sinyali: uyum puanı ${score}/100`);
    rationale.push(`Trend: ${trend === 1 ? "yukarı" : trend === -1 ? "aşağı" : "yatay"} · ADX: ${round(adxVal,1)}`);
    rationale.push(`RSI: ${round(rsiVal,1)} · MACD histogram: ${round(macdHist,4)}`);
    rationale.push(`Hacım oranı: ${round(rv,2)}x · ATR: ${round(atrVal,6)}`);
  }

  const sig = finalSignal(symbol, instType, side, score, price, entry, sl, tp1, tp2, tp3,
    rr, timeframe, rationale, invalidation, {
      ema9: last(ema9), ema20: e20, ema50: last(ema50), ema200: last(ema200),
      rsi: round(rsiVal,2), macd: round(macdLine,4), macdSignal: round(macdSig,4), macdHist: round(macdHist,4),
      atr: round(atrVal,6), bbUpper: round(bbUpper,6), bbLower: round(bbLower,6),
      supertrend: round(stVal,6), stDirection: stDir, adx: round(adxVal,2),
      relativeVolume: round(rv,2), trend, structure,
    }, bestStrategy ? [bestStrategy] : activeStrategies);
  sig.rejectReasons = rejectReasons;
  return sig;
}

function finalSignal(
  symbol: string, instType: string, side: SignalSide, score: number, price: number,
  entry: number | null, sl: number | null, tp1: number | null, tp2: number | null,
  tp3: number | null, rr: string | null, timeframe: Timeframe,
  rationale: string[], invalidation: string[],
  indicators: Record<string, unknown>, strategies: StrategyId[]
): Signal {
  const now = Date.now();
  return {
    symbol, instType, side, score, price, entry, stopLoss: sl, tp1, tp2, tp3, rr,
    timeframe, generatedAt: now, expiresAt: now + 60 * 60 * 1000, // 1 saat geçerli
    rationale, invalidation, indicators,
    strategy: strategies,
  };
}

function formatNum(n: number): string {
  return n.toString();
}

export { MIN_RR_DEFAULT };
