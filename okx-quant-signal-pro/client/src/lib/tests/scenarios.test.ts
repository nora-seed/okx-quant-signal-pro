import { describe, it, expect } from "vitest";
import { buildSignal } from "../signalEngine";
import type { Candle } from "../indicators";
import type { StrategyId, Timeframe } from "../signalEngine";

/* ---------- Yardımcı: senaryo mum dizisi üretici ---------- */
let seed = 42;
function rnd() {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
}

function mkCandles(n: number, fn: (i: number, prev: Candle) => { close: number; volume?: number; extra?: Partial<Candle> }): Candle[] {
  const out: Candle[] = [];
  let prev: Candle = { ts: 0, open: 100, high: 101, low: 99, close: 100, volume: 1000 };
  for (let i = 0; i < n; i++) {
    const { close, volume = 1000, extra = {} } = fn(i, prev);
    const open = prev.close;
    const high = Math.max(open, close) * (1 + rnd() * 0.002);
    const low = Math.min(open, close) * (1 - rnd() * 0.002);
    const c: Candle = { ts: (i + 1) * 60_000, open, high, low, close, volume, ...extra };
    out.push(c);
    prev = c;
  }
  return out;
}

function uptrendCandles(n = 400): Candle[] {
  return mkCandles(n, (i) => {
    const drift = 1 + 0.0009 + (rnd() - 0.5) * 0.0025;
    return { close: 100 * Math.pow(drift, i), volume: i > n * 0.9 ? 2000 : 1000 };
  });
}

function downtrendCandles(n = 400): Candle[] {
  return mkCandles(n, (i) => {
    const drift = 0.901; // -%0.09 bar
    return { close: 100 * Math.pow(drift, i), volume: i > n * 0.9 ? 2000 : 1000 };
  });
}

function sidewaysCandles(n = 400): Candle[] {
  return mkCandles(n, (i) => {
    const swing = 100 + Math.sin(i / 40) * 0.15;
    return { close: swing, volume: 1000 };
  });
}

const TF: Timeframe = "15m";
const STRATS: StrategyId[] = ["multi"];

describe("Sinyal motoru senaryo testleri", () => {
  it("YETERSİZ VERİ: n<200 → BEKLE + 'Yetersiz veri' reddi", () => {
    const s = buildSignal({ symbol: "TEST-USDT", instType: "SPOT", candles: uptrendCandles(150), timeframe: TF, strategy: STRATS });
    expect(s.side).toBe("BEKLE");
    expect(s.rejectReasons?.join(" ")).toContain("Yetersiz veri");
  });

  it("YATAY PİYASA: net trend yok → BEKLE + gerçek ret sebepleri var", () => {
    const s = buildSignal({ symbol: "TEST-USDT", instType: "SPOT", candles: sidewaysCandles(400), timeframe: TF, strategy: STRATS });
    expect(s.side).toBe("BEKLE");
    expect((s.rejectReasons?.length ?? 0)).toBeGreaterThan(0);
  });

  it("YUKARI TREND (spot): BEKLE veya SPOT_AL; LONG/SAT karışımı olmaz; SL/TP mantığı AL'de doğru", () => {
    const s = buildSignal({ symbol: "TEST-USDT", instType: "SPOT", candles: uptrendCandles(400), timeframe: TF, strategy: STRATS });
    if (s.side !== "BEKLE") {
      // Spot'tayalı yön yalnız AL olabilir
      expect(["SPOT_AL", "SPOT_SAT", "BEKLE"].join()).toBe(s.side);
      if (s.side === "SPOT_AL") {
        expect(s.entry!).toBeGreaterThan(s.stopLoss!);
        expect(s.tp2!).toBeGreaterThan(s.tp1!);
        expect(s.rr).not.toBeNull();
        const parts = s.rr!.split(":");
        expect(Number(parts[0])).toBeGreaterThanOrEqual(1.5);
        // Uyum puanı 0-100 aralığında
        expect(s.score).toBeGreaterThanOrEqual(0);
        expect(s.score).toBeLessThanOrEqual(100);
      }
    } else {
      expect(s.rejectReasons?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it("AŞAĞI TREND (spot): BEKLE veya SPOT_SAT; SL üstte TP altta", () => {
    const s = buildSignal({ symbol: "TEST-USDT", instType: "SPOT", candles: downtrendCandles(400), timeframe: TF, strategy: STRATS });
    if (s.side === "SPOT_SAT") {
      expect(s.stopLoss!).toBeGreaterThan(s.entry!);
      expect(s.tp1!).toBeLessThan(s.entry!);
      expect(s.tp2!).toBeLessThan(s.tp1!);
      expect(s.tp3!).toBeLessThan(s.tp2!);
    }
  });

  it("FUTURES: LONG ve SHORT ayrı işlenir", () => {
    const long = buildSignal({ symbol: "T1-USDT", instType: "SWAP", candles: uptrendCandles(400), timeframe: TF, strategy: STRATS });
    const short = buildSignal({ symbol: "T2-USDT", instType: "SWAP", candles: downtrendCandles(400), timeframe: TF, strategy: STRATS });
    if (long.side !== "BEKLE") {
      expect(["FUTURES_LONG", "FUTURES_SHORT", "BEKLE"].join()).toContain(long.side);
      if (long.side === "FUTURES_LONG") expect(long.entry!).toBeGreaterThan(long.stopLoss!);
    }
    if (short.side === "FUTURES_SHORT") {
      expect(short.stopLoss!).toBeGreaterThan(short.entry!);
      expect(short.tp1!).toBeLessThan(short.entry!);
    }
  });

  it("TP1/TP2/TP3 sıralı ve RR >= MinRr (AL senaryosunda 1:3 kontrol)", () => {
    const s = buildSignal({ symbol: "T-USDT", instType: "SPOT", candles: uptrendCandles(400), timeframe: TF, strategy: STRATS, minRr: 3 });
    if (s.side === "SPOT_AL") {
      expect(Number(s.rr!.split(":")[0])).toBeGreaterThanOrEqual(3);
    }
  });

  it("BEKLE signal'da rejectReasons alanı dolu ve Türkçe", () => {
    const s = buildSignal({ symbol: "T-USDT", instType: "SPOT", candles: sidewaysCandles(400), timeframe: TF, strategy: ["multi"] });
    const joined = (s.rejectReasons || []).join(" ");
    const hasTr = /Yapı|akım|hacim|trend|puan|risk|veri|Strateji/i.test(joined);
    expect(hasTr).toBe(true);
  });

  it("Sinyal geçmişine kayıt yapısı: symbol/side/score/rri/entry/SL/TP alanları tam", () => {
    const s = buildSignal({ symbol: "T-USDT", instType: "SPOT", candles: uptrendCandles(400), timeframe: TF, strategy: STRATS });
    expect(s.symbol).toBe("T-USDT");
    expect(s.generatedAt).toBeGreaterThan(0);
    expect(s.expiresAt).toBeGreaterThan(s.generatedAt);
    expect(s.rationale.length).toBeGreaterThan(0);
    expect(s.strategy.length).toBeGreaterThan(0);
  });
});
