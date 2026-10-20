import { describe, it, expect } from "vitest";
import { computeEarlySignal } from "../earlyEngine";
import type { Candle } from "../indicators";

let s = 42;
const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648 - 0.5; };

function mkCandles(base: number, n: number, drift = -1.2): Candle[] {
  const out: Candle[] = [];
  let p = base;
  for (let i = 0; i < n; i++) {
    const vol = base * 0.006;
    const close = p + rnd() * vol * 2 + drift * base * 0.0008;
    out.push({ ts: i * 900_000, open: p, high: Math.max(p, close) * 1.001, low: Math.min(p, close) * 0.999, close, volume: 1000 + rnd() * 200 });
    p = close;
  }
  return out;
}

// Uzun yatay bant + son mumda %2 hacimli kırılım
function flatThenBreak(n = 160): Candle[] {
  const out: Candle[] = [];
  let s2 = 7;
  const r2 = () => { s2 = (s2 * 1103515245 + 12345) % 2147483648; return s2 / 2147483648; };
  const base = 1.0;
  for (let i = 0; i < n; i++) {
    const o = base + r2() * 0.004;
    const c = base + r2() * 0.004;
    out.push({ ts: i * 900_000, open: o, high: Math.max(o, c) + 0.001, low: Math.min(o, c) - 0.001, close: c, volume: 1000 });
  }
  const last = out[out.length - 1];
  last.open = base + 0.002; last.close = base + 0.010; last.high = base + 0.0105; last.low = base;
  last.volume = 4000;
  return out;
}

describe("earlyEngine", () => {
  it("veri yetersizliğinde VERİ_HATASI üretir", () => {
    const sig = computeEarlySignal({ symbol: "X", candles15: mkCandles(1, 50), timeframe: "15m", barSent: "15m" });
    expect(sig.phase).toBe("VERI_HATASI");
    expect(sig.missing[0]).toContain("Yetersiz");
  });

  it("sıkışma + hacimli kırılımda kırılım kapanışı işaretlenir, puan yükselir", () => {
    const sig = computeEarlySignal({ symbol: "X", candles15: flatThenBreak(160), timeframe: "15m", barSent: "15m" });
    expect(sig.checks.dataOk).toBe(true);
    expect(sig.checks.validBreakoutClose).toBe(true);
    expect(sig.rvol!).toBeGreaterThan(1.6);
    expect(sig.score).toBeGreaterThanOrEqual(40);
    expect(["HAZIRLIK", "ERKEN_IZLE", "AL_ADAYI", "ONAYLI_AL"]).toContain(sig.phase);
  });

  it("kırılımsız sıkı bantta BBW yüzdelik düşük ve puan > 0", () => {
    const c = flatThenBreak(160);
    const l = c[c.length - 1];
    l.close = l.high = l.open; l.low = l.open - 0.0005; l.volume = 1000;
    const sig = computeEarlySignal({ symbol: "X", candles15: c, timeframe: "15m", barSent: "15m" });
    expect(sig.score).toBeGreaterThan(0);
    expect(sig.bbwPctile!).toBeLessThan(0.5);
  });

  it("T2 = giriş + 2R ve giriş > stop", () => {
    const sig = computeEarlySignal({ symbol: "X", candles15: flatThenBreak(160), timeframe: "15m", barSent: "15m" });
    expect(sig.entryTrigger).not.toBeNull();
    expect(sig.stop!).toBeLessThan(sig.entryTrigger!);
    const risk = sig.entryTrigger! - sig.stop!;
    expect(sig.t2! - sig.entryTrigger!).toBeCloseTo(2 * risk, 6);
  });

  it("sürekli düşüşte ONAYLI_AL üretilmez", () => {
    const sig = computeEarlySignal({ symbol: "X", candles15: mkCandles(1, 170, -1.6), timeframe: "15m", barSent: "15m" });
    expect(sig.phase).not.toBe("ONAYLI_AL");
  });

  it("BBW yüzdelik null değil (geçmiş pencere yeterli)", () => {
    const sig = computeEarlySignal({ symbol: "X", candles15: flatThenBreak(160), timeframe: "15m", barSent: "15m" });
    expect(sig.bbwPctile).not.toBeNull();
  });

  it("4H negatifken ONAYLI_AL üretilmez", () => {
    const down = mkCandles(1, 90, -1.4);
    const sig = computeEarlySignal({ symbol: "X", candles15: flatThenBreak(160), candlesFourHour: down, timeframe: "15m", barSent: "15m" });
    expect(sig.tf4h).not.toBe("poztif");
    if (sig.tf4h === "negatif") {
      expect(sig.phase).not.toBe("ONAYLI_AL");
      expect(sig.checks.structure4hOk).toBe(false);
    }
  });

  it("ANLIKSIZ mum kullanılmaz: confirm=0 filtrelenir", () => {
    const c = flatThenBreak(160);
    const last: any = c[c.length - 1];
    last.confirm = 0; // tamamlanmamış
    c.push({ ts: 160 * 900_000, open: last.close, high: last.close * 1.01, low: last.close, close: last.close * 1.03, volume: 99_999, ...({ confirm: 0 } as any) });
    const sig = computeEarlySignal({ symbol: "X", candles15: c, timeframe: "15m", barSent: "15m" });
    expect(sig.barTs).toBe(158 * 900_000);
  });
});
