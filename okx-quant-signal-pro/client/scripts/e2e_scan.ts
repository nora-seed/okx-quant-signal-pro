/* Uçtan uca 20'li tarama doğrulaması (gerçek OKX) */
import { scanNextBatch, type ScanResultRow } from "../src/lib/scanner";
import type { StrategyId, Timeframe } from "../src/lib/signalEngine";

(async () => {
  const TF: Timeframe = "15m";
  const STR: StrategyId[] = ["multi"];
  // Tur 1: ilk 20
  const r1 = await scanNextBatch({ instType: "SPOT", timeframe: TF, strategy: STR, onProgress: (p) => { if (p.current % 5 === 0 || p.done) console.log(`  ilerleme ${p.current}/${p.total}`); } });
  const ids1 = r1.rows.map((r: any) => r.symbol);
  console.log("TUR1:", ids1.length, "satır |", "hatalı:", r1.failed.length, "| ilerleme:", JSON.stringify(r1.progress));
  // Tur 2: sonraki 20 (aynı snapshot'tan devam)
  const r2 = await scanNextBatch({ instType: "SPOT", timeframe: TF, strategy: STR, prev: r1.snapshot });
  const ids2 = r2.rows.map((r: any) => r.symbol);
  const dup = ids1.filter((s: string) => ids2.includes(s));
  console.log("TUR2:", ids2.length, "satır | tekrar:", dup.length, "| ilerleme:", JSON.stringify(r2.progress));
  // Sides dağılımı
  const tally: Record<string, number> = {};
  for (const r of [...r1.rows, ...r2.rows] as any[]) tally[r.side] = (tally[r.side] || 0) + 1;
  console.log("Yön dağılımı (40 coin):", JSON.stringify(tally));
  const active = (r1.rows.filter((r: any) => "error" in r === false && r.side !== "BEKLE")) as any[];
  console.log("Aktif sinyal:", active.length);
  if (active[0]) console.log("Örnek sinyal:", active[0].symbol, active[0].side, "puan", active[0].score, "RR", active[0].rr, "Entry/SL:", active[0].entry, active[0].stopLoss);
  // Baştan: sıfırla ve ilk 20 yeniden – aynı ilk 20 dönüyorsa sıralama tutarlı sıralandı
  const r3 = await scanNextBatch({ instType: "SPOT", timeframe: TF, strategy: STR, prev: null });
  const ids3 = r3.rows.map((r: any) => r.symbol);
  console.log("BAŞTAN ilk 20 = TUR1 ilk 20?", ids3.length === ids1.length && ids1.every((s: string) => ids3.includes(s)));
})().catch((e) => { console.error("E2E-FAIL:", e.message); process.exit(1); });
