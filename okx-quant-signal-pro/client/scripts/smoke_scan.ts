/* Smoke: gerçek OKX'ten enstrüman sıralama + 3 coinlik mini batch (rate limit dostu) */
import { fetchInstruments, fetchTickers } from "../src/lib/okxPublic";
import { rankInstruments, nextBatch } from "../src/lib/scanner";

(async () => {
  const [insts, tickers] = await Promise.all([fetchInstruments("SPOT"), fetchTickers("SPOT")]);
  const ranked = rankInstruments(insts, tickers, "SPOT");
  console.log("Uygun USDT spot sayısı:", ranked.length);
  console.log("İlk 10:", ranked.slice(0, 10).join(", "));
  const snap = { instIds: ranked, scanned: [] };
  const first20 = nextBatch(snap);
  console.log("İlk 20:", first20.join(","));
  snap.scanned.push(...first20);
  const next20 = nextBatch(snap);
  const overlap = first20.filter((c) => next20.includes(c));
  console.log("2. batch:", next20.slice(0, 5).join(","), "... yinelenen:", overlap.length);
  console.log(JSON.stringify({ eligible: ranked.length, batch1: first20.length, batch2: next20.length, overlap: overlap.length }));
})().catch((e) => {
  console.error("SMOKE-FAIL:", e.message);
  process.exit(1);
});
