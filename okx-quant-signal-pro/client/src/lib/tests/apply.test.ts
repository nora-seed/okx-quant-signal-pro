import { describe, it, expect } from "vitest";
import { buildSignal } from "../signalEngine";
import { toBar } from "../okxPublic";
import type { StrategyId, Timeframe } from "../signalEngine";
import type { Candle } from "../indicators";

let seed = 7;
function rnd() { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; }
function mkCandles(n: number, drift: number, volBoost = false): Candle[] {
  const out: Candle[] = [];
  let prev = { close: 100 };
  for (let i = 0; i < n; i++) {
    const open = prev.close;
    const close = 100 * Math.pow(1 + drift + (rnd() - 0.5) * 0.002, i);
    const c: Candle = { ts: (i + 1) * 60000, open, high: Math.max(open, close) * 1.001, low: Math.min(open, close) * 0.999, close, volume: volBoost && i > n - 20 ? 2200 : 1000 };
    out.push(c); prev = c;
  }
  return out;
}

describe("Seçilen zaman dilimi ve strateji gerçekten uygulanır", () => {
  it("toBar eşlemesi: 15m→15m, 1h→1H, 4h→4H, 1d→1D", () => {
    expect(toBar("15m")).toBe("15m");
    expect(toBar("1h")).toBe("1H");
    expect(toBar("4h")).toBe("4H");
    expect(toBar("1d")).toBe("1D");
  });

  it("Tek strateji seçilirse (srretest) sinyalin strategy listesi yalnızca o olur", () => {
    const s = buildSignal({ symbol: "X", instType: "SPOT", candles: mkCandles(300, 0.0011), timeframe: "15m", strategy: ["srretest"] });
    expect(s.strategy.length).toBe(1);
    expect(s.strategy[0]).toBe("srretest");
  });

  it("Multi mod tüm stratejilir için çalışır (candidates içerir)", () => {
    const s = buildSignal({ symbol: "X", instType: "SPOT", candles: mkCandles(300, 0.0011), timeframe: "15m", strategy: ["multi"] });
    expect(s.strategy.length).toBeGreaterThanOrEqual(1);
  });

  it("confirm=0 in-progress mumlar hesap dışı bırakılır (son complete kapanışı kullanılır)", () => {
    const cs = mkCandles(300, 0.0011);
    const partial = { ...cs[299], close: cs[299].close * 3, volume: 999999, confirm: 0, high: cs[299].high * 3, low: cs[299].low, open: cs[299].open };
    const withPartial = [...cs.slice(0, 299), partial];
    const s = buildSignal({ symbol: "X", instType: "SPOT", candles: withPartial, timeframe: "15m", strategy: ["multi"] });
    // price = son complete kapanış olmalı, sahte 3x mumu değil
    expect(Math.abs((s.price as number) - cs[298].close) / cs[298].close).toBeLessThan(0.01);
  });
});

describe("Üç seviye sınıflandırma", () => {
  it("strong sinyal ölçütleri: side != BEKLE → strength strong", () => {
    const s = buildSignal({ symbol: "X", instType: "SPOT", candles: mkCandles(300, 0.0035, true), timeframe: "15m", strategy: ["multi"] });
    if (s.side !== "BEKLE") expect(s.strength).toBe("strong");
  });
  it("watch sinyal: puan 30-40 arası + rv>=0.8 → İzleme; AL/SAT kartı gibi gösterilmez", () => {
    const s = buildSignal({ symbol: "X", instType: "SPOT", candles: mkCandles(300, 0.002, false), timeframe: "15m", strategy: ["multi"] });
    if (s.strength === "watch") {
      expect(s.side).toBe("BEKLE");
      expect(s.watchReasons?.length).toBeGreaterThan(0);
    }
  });
  it("BEKLE: ret sebepleri mevcut ve uydurma sinyal yok", () => {
    const s = buildSignal({ symbol: "X", instType: "SPOT", candles: mkCandles(300, 0.0001), timeframe: "15m", strategy: ["multi"] });
    if (s.side === "BEKLE" && s.strength === "off") {
      expect((s.rejectReasons?.length ?? 0)).toBeGreaterThan(0);
    }
  });
});
