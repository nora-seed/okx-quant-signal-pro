"use strict";

/**
 * Teknik indikatörler - doğru matematiksel formüllerle.
 * Tüm girdiler Candle[] (kapanış sıralı, eski -> yeni).
 */

export type Candle = {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type IndicatorResult = {
  name: string;
  values: (number | null)[];
};

/* ---------- Temel yardımcılar ---------- */

function sum(arr: number[]): number {
  let s = 0;
  for (const v of arr) s += v;
  return s;
}

function mean(arr: number[]): number {
  return arr.length ? sum(arr) / arr.length : 0;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max);
}

export function round(n: number, dec = 8): number {
  const m = Math.pow(10, dec);
  return Math.round((n + Number.EPSILON) * m) / m;
}

/* ---------- SMA ---------- */
export function sma(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = [];
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) { out.push(null); continue; }
    out.push(round(mean(values.slice(i - period + 1, i + 1)), 8));
  }
  return out;
}

/* ---------- EMA ---------- */
export function ema(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = [];
  if (period <= 0) return out.fill(null);
  const k = 2 / (period + 1);
  let prev: number | null = null;
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) { out.push(null); continue; }
    if (prev === null) {
      prev = mean(values.slice(0, period));
    } else {
      prev = values[i] * k + prev * (1 - k);
    }
    out.push(round(prev, 8));
  }
  return out;
}

/* ---------- RSI (Wilder) ---------- */
export function rsi(values: number[], period = 14): (number | null)[] {
  const out: (number | null)[] = values.map(() => null);
  if (values.length < period + 1) return out;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const ch = values[i] - values[i - 1];
    if (ch > 0) avgGain += ch; else avgLoss -= ch;
  }
  avgGain /= period;
  avgLoss /= period;
  const rsiAt = (ag: number, al: number): number => {
    if (al === 0) return 100;
    const rs = ag / al;
    return 100 - 100 / (1 + rs);
  };
  out[period] = round(rsiAt(avgGain, avgLoss), 4);
  for (let i = period + 1; i < values.length; i++) {
    const ch = values[i] - values[i - 1];
    const gain = ch > 0 ? ch : 0;
    const loss = ch < 0 ? -ch : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = round(rsiAt(avgGain, avgLoss), 4);
  }
  return out;
}

/* ---------- MACD ---------- */
export type Macd = { macd: (number | null)[]; signal: (number | null)[]; hist: (number | null)[] };

export function macd(values: number[], fast = 12, slow = 26, signal = 9): Macd {
  const n = values.length;
  const emaFast = ema(values, fast);
  const emaSlow = ema(values, slow);
  const macdLine: (number | null)[] = [];
  for (let i = 0; i < n; i++) {
    if (emaFast[i] === null || emaSlow[i] === null) macdLine.push(null);
    else macdLine.push(round(emaFast[i]! - emaSlow[i]!, 8));
  }
  const signalLine: (number | null)[] = [];
  let prev: number | null = null;
  const k = 2 / (signal + 1);
  for (let i = 0; i < n; i++) {
    const v = macdLine[i];
    if (v === null) { signalLine.push(null); continue; }
    if (prev === null) prev = v;
    else prev = v * k + prev * (1 - k);
    signalLine.push(round(prev, 8));
  }
  const hist: (number | null)[] = [];
  for (let i = 0; i < n; i++) {
    if (macdLine[i] === null || signalLine[i] === null) hist.push(null);
    else hist.push(round(macdLine[i]! - signalLine[i]!, 8));
  }
  return { macd: macdLine, signal: signalLine, hist: hist };
}

/* ---------- Stochastic RSI ---------- */
export type StochRsi = { k: (number | null)[]; d: (number | null)[] };

export function stochRsi(values: number[], period = 14, smoothK = 3, smoothD = 3): StochRsi {
  const rsiValues = rsi(values, period);
  const n = values.length;
  const rawK: (number | null)[] = Array.from({ length: n }, () => null);
  for (let i = period; i < n; i++) {
    const window = rsiValues.slice(i - period + 1, i + 1).filter((v): v is number => v !== null);
    if (window.length < period) continue;
    const max = Math.max(...window);
    const min = Math.min(...window);
    const cur = window[window.length - 1];
    let k = 0;
    if (max !== min) k = ((cur - min) / (max - min)) * 100;
    rawK[i] = round(k, 4);
  }
  const kSmoothed = sma(((rawK.filter((v): v is number => v !== null)).length ? rawK.filter((v): v is number => v !== null) : rsiValues) as number[], smoothK);
  // EMA smoothing for K is more standard; here SMA of valid values mapped back
  const kOut: (number | null)[] = Array.from({ length: n }, () => null);
  let idx = 0;
  for (let i = 0; i < n; i++) {
    if (rawK[i] !== null) { kOut[i] = kSmoothed[idx]; idx++; }
  }
  const dOut = sma(((kOut.filter((v): v is number => v !== null)).length ? kOut.filter((v): v is number => v !== null) : rsiValues) as number[], smoothD).map((v, ci) => v);
  // map D back correctly
  const dFinal: (number | null)[] = Array.from({ length: n }, () => null);
  let di = 0;
  for (let i = 0; i < n; i++) {
    if (kOut[i] !== null) { dFinal[i] = dOut[di]; di++; }
  }
  return { k: kOut, d: dFinal };
}

/* ---------- ATR ---------- */
export function atr(candles: Candle[], period = 14): (number | null)[] {
  const n = candles.length;
  const out: (number | null)[] = Array.from({ length: n }, () => null);
  if (n < 2) return out;
  const tr: number[] = [];
  for (let i = 1; i < n; i++) {
    const c = candles[i];
    const pc = candles[i - 1].close;
    tr.push(Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc)));
  }
  // Wilder smoothing
  let atrVal: number | null = null;
  for (let i = 1; i < n; i++) {
    if (i < period) { out[i] = null; continue; }
    if (atrVal === null) {
      atrVal = mean(tr.slice(0, period));
    } else {
      atrVal = (atrVal * (period - 1) + tr[i - 1]) / period;
    }
    out[i] = round(atrVal, 8);
  }
  return out;
}

/* ---------- Bollinger Bands ---------- */
export type BB = { basis: (number | null)[]; upper: (number | null)[]; lower: (number | null)[] };

export function bollinger(values: number[], period = 20, mult = 2): BB {
  const basis = sma(values, period);
  const n = values.length;
  const upper: (number | null)[] = Array.from({ length: n }, () => null);
  const lower: (number | null)[] = Array.from({ length: n }, () => null);
  for (let i = period - 1; i < n; i++) {
    const window = values.slice(i - period + 1, i + 1);
    const m = mean(window);
    const varv = mean(window.map((v) => Math.pow(v - m, 2)));
    const std = Math.sqrt(varv);
    if (basis[i] !== null) {
      upper[i] = round(basis[i]! + mult * std, 8);
      lower[i] = round(basis[i]! - mult * std, 8);
    }
  }
  return { basis, upper, lower };
}

/* ---------- ADX ---------- */
export type Adx = { adx: (number | null)[]; plusDi: (number | null)[]; minusDi: (number | null)[] };

export function adx(candles: Candle[], period = 14): Adx {
  const n = candles.length;
  const out: Adx = { adx: Array.from({ length: n }, () => null), plusDi: Array.from({ length: n }, () => null), minusDi: Array.from({ length: n }, () => null) };
  if (n < period + 1) return out;
  const plusDM: number[] = [];
  const minusDM: number[] = [];
  const tr: number[] = [];
  for (let i = 1; i < n; i++) {
    const c = candles[i], p = candles[i - 1];
    const up = c.high - p.high;
    const down = p.low - c.low;
    let plusDm = 0, minusDm = 0;
    if (up > down && up > 0) plusDm = up;
    if (down > up && down > 0) minusDm = down;
    plusDM.push(plusDm);
    minusDM.push(minusDm);
    tr.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  // Wilder smoothed TR, +DM, -DM
  const smoothed: number[][] = [[], [], []]; // tr, plus, minus
  let sumTr = 0, sumPlus = 0, sumMinus = 0;
  for (let i = 0; i < period; i++) {
    sumTr += tr[i]; sumPlus += plusDM[i]; sumMinus += minusDM[i];
  }
  smoothed[0].push(sumTr); smoothed[1].push(sumPlus); smoothed[2].push(sumMinus);
  for (let i = period; i < tr.length; i++) {
    sumTr = sumTr - sumTr / period + tr[i];
    sumPlus = sumPlus - sumPlus / period + plusDM[i];
    sumMinus = sumMinus - sumMinus / period + minusDM[i];
    smoothed[0].push(sumTr); smoothed[1].push(sumPlus); smoothed[2].push(sumMinus);
  }
  // smoothed[0] index j corresponds to tr index period-1+j ... let's align: DI at candle i (i>=period)
  const plusDiArr: number[] = [];
  const minusDiArr: number[] = [];
  const dxArr: number[] = [];
  for (let j = 0; j < smoothed[0].length; j++) {
    const trS = smoothed[0][j];
    const pDi = trS === 0 ? 0 : (100 * smoothed[1][j]) / trS;
    const mDi = trS === 0 ? 0 : (100 * smoothed[2][j]) / trS;
    plusDiArr.push(pDi);
    minusDiArr.push(mDi);
    const denom = pDi + mDi;
    dxArr.push(denom === 0 ? 0 : (100 * Math.abs(pDi - mDi)) / denom);
  }
  // ADX = Wilder smoothed DX
  const adxArr: number[] = [];
  if (dxArr.length >= period) {
    let sumDx = 0;
    for (let i = 0; i < period; i++) sumDx += dxArr[i];
    adxArr.push(sumDx / period);
    for (let i = period; i < dxArr.length; i++) {
      const prev = adxArr[adxArr.length - 1];
      adxArr.push((prev * (period - 1) + dxArr[i]) / period);
    }
  }
  // Map back to candle indices: DI/DX start at candle index = period (since tr starts at i=1)
  // smoothed[0].length = tr.length - period + 1 = n - period
  // j=0 corresponds to candle index = period
  const offset = period;
  for (let j = 0; j < plusDiArr.length; j++) {
    const ci = offset + j;
    out.plusDi[ci] = round(plusDiArr[j], 4);
    out.minusDi[ci] = round(minusDiArr[j], 4);
  }
  for (let j = 0; j < adxArr.length; j++) {
    const ci = offset + (period - 1) + j;
    if (ci < n) out.adx[ci] = round(adxArr[j], 4);
  }
  return out;
}

/* ---------- Supertrend ---------- */
export type Supertrend = {
  supertrend: (number | null)[];
  direction: (1 | -1 | 0)[]; // 1 up, -1 down, 0 neutral
  upperBand: (number | null)[];
  lowerBand: (number | null)[];
};

export function supertrend(
  candles: Candle[],
  period = 10,
  mult = 3
): Supertrend {
  const n = candles.length;
  const out: Supertrend = {
    supertrend: Array.from({ length: n }, () => null),
    direction: Array.from({ length: n }, () => 0),
    upperBand: Array.from({ length: n }, () => null),
    lowerBand: Array.from({ length: n }, () => null),
  };
  if (n < period + 1) return out;
  const atrValues = atr(candles, period);
  const hl2: number[] = [];
  for (let i = 0; i < n; i++) hl2.push((candles[i].high + candles[i].low) / 2);
  const basicUpper: number[] = [];
  const basicLower: number[] = [];
  for (let i = 0; i < n; i++) {
    if (atrValues[i] === null) { basicUpper.push(0); basicLower.push(0); continue; }
    basicUpper.push(hl2[i] + mult * atrValues[i]!);
    basicLower.push(hl2[i] - mult * atrValues[i]!);
  }
  let upper = basicUpper[period];
  let lower = basicLower[period];
  let dir: 1 | -1 = 1;
  for (let i = period; i < n; i++) {
    if (basicUpper[i] === 0 || basicLower[i] === 0) continue;
    // final bands
    if (i === period) {
      upper = basicUpper[i];
      lower = basicLower[i];
    } else {
      if (basicUpper[i] < upper || candles[i - 1].close > upper) upper = basicUpper[i];
      if (basicLower[i] > lower || candles[i - 1].close < lower) lower = basicLower[i];
    }
    if (dir === 1) {
      if (candles[i].close <= lower) { dir = -1; out.supertrend[i] = round(upper, 8); }
      else { out.supertrend[i] = round(lower, 8); }
    } else {
      if (candles[i].close >= upper) { dir = 1; out.supertrend[i] = round(lower, 8); }
      else { out.supertrend[i] = round(upper, 8); }
    }
    out.direction[i] = dir;
    out.upperBand[i] = round(upper, 8);
    out.lowerBand[i] = round(lower, 8);
  }
  return out;
}

/* ---------- OBV ---------- */
export function obv(candles: Candle[]): (number | null)[] {
  const n = candles.length;
  const out: (number | null)[] = Array.from({ length: n }, () => null);
  if (n === 0) return out;
  let v = 0;
  out[0] = round(candles[0].volume, 8);
  v = candles[0].volume;
  for (let i = 1; i < n; i++) {
    if (candles[i].close > candles[i - 1].close) v += candles[i].volume;
    else if (candles[i].close < candles[i - 1].close) v -= candles[i].volume;
    out[i] = round(v, 8);
  }
  return out;
}

/* ---------- VWAP (session-based, reset daily) ---------- */
export type Vwap = { vwap: (number | null)[]; typical: number[] };

export function vwap(candles: Candle[]): Vwap {
  const n = candles.length;
  const out: (number | null)[] = Array.from({ length: n }, () => null);
  const typical: number[] = [];
  let cumVol = 0, cumPv = 0;
  let sessionStart = 0;
  const dayOf = (ts: number) => new Date(ts).getUTCDay() + "/" + new Date(ts).getUTCDate();
  let curDay = dayOf(candles[0].ts);
  for (let i = 0; i < n; i++) {
    const tp = (candles[i].high + candles[i].low + candles[i].close) / 3;
    typical.push(tp);
    const d = dayOf(candles[i].ts);
    if (d !== curDay) {
      curDay = d;
      cumVol = 0; cumPv = 0; sessionStart = i;
    }
    cumVol += candles[i].volume;
    cumPv += tp * candles[i].volume;
    out[i] = cumVol > 0 ? round(cumPv / cumVol, 8) : null;
  }
  return { vwap: out, typical };
}

/* ---------- Volume helpers ---------- */
export function volumeSma(candles: Candle[], period = 20): (number | null)[] {
  const vols = candles.map((c) => c.volume);
  return sma(vols, period);
}

export function relativeVolume(candles: Candle[], period = 20): (number | null)[] {
  const vsma = volumeSma(candles, period);
  const n = candles.length;
  const out: (number | null)[] = Array.from({ length: n }, () => null);
  for (let i = 0; i < n; i++) {
    if (vsma[i] !== null && vsma[i]! > 0) out[i] = round(candles[i].volume / vsma[i]!, 4);
  }
  return out;
}

/* ---------- Swing points ---------- */
export type Swing = { highs: number[]; lows: number[] }; // candle indices

export function swingPoints(candles: Candle[], left = 2, right = 2): Swing {
  const highs: number[] = [];
  const lows: number[] = [];
  const n = candles.length;
  for (let i = left; i < n - right; i++) {
    let isHigh = true, isLow = true;
    for (let j = i - left; j <= i + right; j++) {
      if (candles[j].high > candles[i].high) isHigh = false;
      if (candles[j].low < candles[i].low) isLow = false;
    }
    if (isHigh) highs.push(i);
    if (isLow) lows.push(i);
  }
  return { highs, lows };
}

/* ---------- Support / Resistance levels ---------- */
export type Level = { price: number; strength: number; touches: number };

export function supportResistance(
  candles: Candle[],
  lookback = 100
): { support: Level[]; resistance: Level[] } {
  const n = candles.length;
  const start = Math.max(0, n - lookback);
  const swing = swingPoints(candles.slice(start), 2, 2);
  const cluster = (prices: number[]): Level[] => {
    const sorted = [...prices].sort((a, b) => a - b);
    const groups: number[][] = [];
    for (const p of sorted) {
      let placed = false;
      for (const g of groups) {
        const avg = mean(g);
        if (Math.abs(p - avg) / avg < 0.003) { // %0.3 tolerans
          g.push(p); placed = true; break;
        }
      }
      if (!placed) groups.push([p]);
    }
    return groups
      .map((g) => ({ price: round(mean(g), 8), strength: round(g.length / 10, 2), touches: g.length }))
      .sort((a, b) => b.touches - a.touches);
  };
  const highPrices = swing.highs.map((i) => candles[start + i].high);
  const lowPrices = swing.lows.map((i) => candles[start + i].low);
  return { support: cluster(lowPrices), resistance: cluster(highPrices) };
}

/* ---------- Trend structure (HH/HL/LH/LL) ---------- */
export type Structure = {
  hhhl: boolean; // higher high, higher low
  lhll: boolean;
  sideways: boolean;
};

export function marketStructure(candles: Candle[], left = 2, right = 2): Structure {
  const swing = swingPoints(candles, left, right);
  if (swing.highs.length < 2 || swing.lows.length < 2) return { hhhl: false, lhll: false, sideways: true };
  const lastH = swing.highs.slice(-3);
  const lastL = swing.lows.slice(-3);
  let hhhl = true, lhll = true;
  for (let i = 1; i < lastH.length; i++) {
    if (candles[lastH[i]].high <= candles[lastH[i - 1]].high) hhhl = false;
    if (candles[lastL[i]].low >= candles[lastL[i - 1]].low) hhhl = false;
    if (candles[lastH[i]].high >= candles[lastH[i - 1]].high) lhll = false;
    if (candles[lastL[i]].low <= candles[lastL[i - 1]].low) lhll = false;
  }
  const sideways = !hhhl && !lhll;
  return { hhhl, lhll, sideways };
}
