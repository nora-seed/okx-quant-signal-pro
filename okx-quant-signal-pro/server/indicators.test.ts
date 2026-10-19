import { describe, it, expect } from "vitest";
import {
  sma, ema, rsi, macd, atr, bollinger, supertrend, obv, vwap,
  relativeVolume, supportResistance, marketStructure, round,
} from "./src/services/indicators";
import type { Candle } from "./services/indicators";

function candle(close: number, high?: number, low?: number, volume = 100): Candle {
  return { ts: Date.now(), open: close, high: high ?? close, low: low ?? close, close, volume };
}

describe("indikörler", () => {
  it("round yuvarlama", () => {
    expect(round(1.23456789, 2)).toBe(1.23);
    expect(round(1.005, 2)).toBeGreaterThan(1);
  });

  it("sma", () => {
    const v = [1, 2, 3, 4, 5];
    const r = sma(v, 3);
    expect(r[0]).toBeNull();
    expect(r[1]).toBeNull();
    expect(r[2]).toBe(2);
    expect(r[4]).toBe(4);
  });

  it("ema", () => {
    const v = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const r = ema(v, 3);
    expect(r[0]).toBeNull();
    expect(r[1]).toBeNull();
    expect(r[2]).not.toBeNull();
    expect(r[r.length - 1]).not.toBeNull();
  });

  it("rsi sınırları", () => {
    const rising: number[] = [];
    for (let i = 0; i < 50; i++) rising.push(100 + i); // sürekli artan -> RSI ~100
    const r = rsi(rising, 14);
    const last = r[r.length - 1];
    expect(last).toBeGreaterThan(90);

    const falling: number[] = [];
    for (let i = 0; i < 50; i++) falling.push(100 - i); // sürekli azalan -> RSI ~0
    const r2 = rsi(falling, 14);
    const last2 = r2[r2.length - 1];
    expect(last2).toBeLessThan(10);
  });

  it("macd çıkışı", () => {
    const v = Array.from({ length: 60 }, (_, i) => 100 + i + Math.sin(i) * 2);
    const m = macd(v);
    expect(m.macd.length).toBe(v.length);
    expect(m.signal.length).toBe(v.length);
    expect(m.hist.length).toBe(v.length);
  });

  it("atr pozitif", () => {
    const cs: Candle[] = [];
    for (let i = 0; i < 40; i++) cs.push(candle(100 + i, 105 + i, 95 + i));
    const a = atr(cs, 14);
    const last = a[a.length - 1];
    expect(last).toBeGreaterThan(0);
  });

  it("bollinger düzeni", () => {
    const v = Array.from({ length: 50 }, (_, i) => 100 + Math.sin(i / 5) * 5);
    const bb = bollinger(v, 20, 2);
    const last = v.length - 1;
    expect(bb.upper[last]!).toBeGreaterThanOrEqual(bb.basis[last]!);
    expect(bb.lower[last]!).toBeLessThanOrEqual(bb.basis[last]!);
  });

  it("supertrend yönü 1 veya -1", () => {
    const cs: Candle[] = [];
    for (let i = 0; i < 60; i++) cs.push(candle(100 + i, 106 + i, 94 + i)); // güçlü yukarı
    const st = supertrend(cs, 10, 3);
    const dir = st.direction[st.direction.length - 1];
    expect(dir).toBe(1);
  });

  it("obv artar", () => {
    const cs: Candle[] = [];
    for (let i = 0; i < 20; i++) cs.push(candle(100 + i, 101 + i, 99 + i, 1000)); // sürekli yukarı
    const o = obv(cs);
    expect(o[o.length - 1]).toBeGreaterThan(o[0]!);
  });

  it("vwap sıfırdan farklı", () => {
    const cs: Candle[] = [];
    for (let i = 0; i < 30; i++) cs.push(candle(100 + i, 102 + i, 98 + i, 1000));
    const v = vwap(cs);
    const last = v.vwap[v.vwap.length - 1];
    expect(last).toBeGreaterThan(0);
  });

  it("relativeVolume", () => {
    const cs: Candle[] = [];
    for (let i = 0; i < 40; i++) cs.push(candle(100, 101, 99, i < 39 ? 100 : 1000)); // son hacim çok yüksek
    const rv = relativeVolume(cs, 20);
    const last = rv[rv.length - 1];
    expect(last).toBeGreaterThan(1);
  });

  it("supportResistance döner", () => {
    const cs: Candle[] = [];
    for (let i = 0; i < 100; i++) cs.push(candle(100 + Math.sin(i / 10) * 10, 105 + Math.sin(i / 10) * 10, 95 + Math.sin(i / 10) * 10));
    const levels = supportResistance(cs, 100);
    expect(Array.isArray(levels.support)).toBe(true);
    expect(Array.isArray(levels.resistance)).toBe(true);
  });

  it("marketStructure", () => {
    const cs: Candle[] = [];
    for (let i = 0; i < 60; i++) cs.push(candle(100 + i, 106 + i, 94 + i));
    const ms = marketStructure(cs, 2, 2);
    expect(typeof ms.hhhl).toBe("boolean");
    expect(typeof ms.sideways).toBe("boolean");
  });
});
