/* 60 coinlik uçtan uca gerçek tarama (3 tur x 20) + teşhis özeti */
import { scanNextBatch } from "../src/lib/scanner";
import type { StrategyId, Timeframe } from "../src/lib/signalEngine";

(async () => {
  const TF: Timeframe = "4h";
  const STR: StrategyId[] = ["srretest"];
  const seen: string[] = [];
  const counts: Record<string, number> = {};
  let barsOk = true, barsChecked = 0;
  let snap: any = null;
  for (let round = 1; round <= 3; round++) {
    const out = await scanNextBatch({ instType: "SPOT", timeframe: TF, strategy: STR, prev: snap }); snap = out.snapshot;
    const ids = out.rows.map((r: any) => r.symbol);
    seen.push(...ids);
    const dup = ids.filter((x: string) => new Set(seen.slice(0, seen.length - ids.length)).has(x));
    for (const r of out.rows as any[]) {
      const key = "error" in r ? r.error : `${r.side}/${r.strength}`;
      counts[key] = (counts[key] || 0) + 1;
      if (!("error" in r)) {
        barsChecked++;
        if (r.barSent !== "4H") barsOk = false;
        if (Array.isArray(r.strategy) && !(r.strategy.length === 1 && r.strategy[0] === "srretest")) barsOk = false;
      }
    }
    console.log(`TUR ${round}: ${ids.length} coin | tekrar: ${dup.length} | ilerleme: ${JSON.stringify(out.progress)}`);
    if (out.failed.length) console.log("  API hataları:", out.failed.map((f) => `${f.instId}:${f.reason}`).slice(0, 5).join(" | "));
  }
  console.log("TOPLAM taranan coin:", seen.length, "| unique:", new Set(seen).size);
  console.log("Yön/dağılım:", JSON.stringify(counts));
  console.log(`bar=4H uygulandı mı: ${barsOk} (${barsChecked} kart kontrol edildi); strateji=srretest uygulandı mı: ${barsOk}`);
  const active = Object.entries(counts).filter(([k]) => k.startsWith("SPOT_") || k.startsWith("FUTURES_"));
  console.log("Aktif sinyal dağılımı:", JSON.stringify(Object.fromEntries(active)));
})().catch((e) => { console.error("60COIN-FAIL:", e.message); process.exit(1); });
