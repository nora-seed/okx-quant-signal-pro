/**
 * EARLY BREAKOUT ENGINE — gerçek verili backtest (browser-dışı, tsx ile OKX public API).
 * A-D stratejileri ayrı ayrı + E birleşik motor; 24s/72s/7g hedef takibi.
 * Parametreler ve ücretler sabit başlangıç değeridir; sonuçlar hipotez testidir, vaat değil.
 */
import { fetchInstruments, fetchTickers, fetchHistoryCandles } from "/workspaces/codespaces-blank/okx-quant-signal-pro/client/src/lib/okxPublic";
import { computeEarlySignal } from "/workspaces/codespaces-blank/okx-quant-signal-pro/client/src/lib/earlyEngine";
import type { Candle } from "/workspaces/codespaces-blank/okx-quant-signal-pro/client/src/lib/indicators";

const FEE = 0.001; // %0.1
const SLIP = 0.0005;

type Eval = {
  coinsTotal: number; analyzed: number;
  strats: Record<string, StratStat>;
};
type StratStat = {
  name: string;
  signals: number;
  hitT1_24: number; hitT1_72: number; hitT1_168: number;
  hitT2_24: number; hitT2_72: number; hitT2_168: number;
  stopped: number;
  mfe: number; mae: number; // ortalama % hareket
  netPnl: number; wins: number;
  move5_24: number; move10_24: number;
  move5_168: number; move10_168: number;
  rrSum: number; rrN: number;
};

function newStat(name: string): StratStat {
  return { name, signals: 0, hitT1_24: 0, hitT1_72: 0, hitT1_168: 0, hitT2_24: 0, hitT2_72: 0, hitT2_168: 0, stopped: 0, mfe: 0, mae: 0, netPnl: 0, wins: 0, move5_24: 0, move10_24: 0, move5_168: 0, move10_168: 0, rrSum: 0, rrN: 0 };
}

function variantFire(kind: string, sig: any): boolean {
  const bd = sig.breakdown;
  switch (kind) {
    case "A": // yalnız fiyat/mum yapısı + formasyon
      return sig.checks.validBreakoutClose && bd.yapi >= 15;
    case "B": // yalnız indikatörler
      return bd.ema + bd.macd + bd.rsi + bd.vwap >= 25;
    case "C": // fiyat yapısı + RVOL
      return bd.yapi >= 10 && bd.hacim >= 8;
    case "D": // sıkışma + direnç + RVOL
      return bd.sikisma >= 12 && bd.yapi >= 10 && bd.hacim >= 8;
    case "E": // birleşik erken motor aşaması
      return sig.phase === "AL_ADAYI" || sig.phase === "ONAYLI_AL";
    default: return false;
  }
}

const TF_BAR_MS: Record<string, number> = { "15m": 900_000, "1H": 3_600_000, "4H": 14_400_000 };

/** Sinyal sonrası ileri değerlendirme: stop/t1/t2 arası 24/72/168 bar (tf'e göre saate çevrilir). */
function outcome(candles: Candle[], idx: number, entryP: number, stop: number, t1: number, t2: number, tf: string) {
  const barMs = TF_BAR_MS[tf] ?? 3_600_000;
  const h24 = Math.max(1, Math.round(24 * 3600_000 / barMs));
  const h72 = Math.round(72 * 3600_000 / barMs);
  const h168 = Math.round(168 * 3600_000 / barMs);
  const r: any = { hitT1_24: false, hitT1_72: false, hitT1_168: false, hitT2_24: false, hitT2_72: false, hitT2_168: false, stopped: false, stoppedTs: null, mfe: 0, mae: 0, move24: null, move168: null };
  const future = candles.slice(idx + 1);
  let stopHit = false;
  for (let k = 0; k < future.length && k <= h168; k++) {
    const b = future[k];
    if (b.low <= stop) { stopHit = true; r.stoppedTs = k; break; }
    if (k <= h24 && b.high >= t2) { r.hitT2_24 = true; r.hitT1_24 = true; r.hitT1_72 = true; r.hitT1_168 = true; r.hitT2_72 = true; r.hitT2_168 = true; }
    else {
      if (k <= h24 && b.high >= t1) r.hitT1_24 = true;
      if (k <= h72 && b.high >= t1) r.hitT1_72 = true;
      if (k <= h72 && b.high >= t2) r.hitT2_72 = true;
      if (k <= h168 && b.high >= t1) r.hitT1_168 = true;
      if (k <= h168 && b.high >= t2) r.hitT2_168 = true;
    }
    r.mfe = Math.max(r.mfe, (b.high - entryP) / entryP * 100);
    r.mae = Math.min(r.mae, (b.low - entryP) / entryP * 100);
  }
  r.stopped = stopHit;
  if (future.length > h24 && future[h24]) r.move24 = (future[h24].close - entryP) / entryP * 100;
  if (future.length > h168 && future[h168]) r.move168 = (future[h168].close - entryP) / entryP * 100;
  return r;
}

/** Derin geçmiş: history-candles sayfalı (after param ile geriye). */
async function fetchDeep(instId: string, bar: string, wantBars: number): Promise<Candle[]> {
  const { okxFetch } = await import("/workspaces/codespaces-blank/okx-quant-signal-pro/client/src/lib/okxPublic");
  let out: Candle[] = [];
  let after: string | undefined;
  while (out.length < wantBars) {
    const p: Record<string, string> = { instId, bar, limit: "100" };
    if (after) p.after = after;
    const d: any = await okxFetch("/api/v5/market/history-candles", p);
    const rows: any[] = d.data || [];
    if (rows.length === 0) break;
    const mapped: Candle[] = rows.map((r) => ({ ts: Number(r[0]), open: Number(r[1]), high: Number(r[2]), low: Number(r[3]), close: Number(r[4]), volume: Number(r[5]) }));
    out = out.concat(mapped);
    after = String(Number(rows[rows.length - 1][0]));
    if (after === "0") break;
  }
  return out.sort((a, b) => a.ts - b.ts);
}

async function main() {
  const N_COINS = Number(process.env.N_COINS || 60);
  const BARS = Number(process.env.BARS || 700);
  const STEP = Number(process.env.STEP || 2);
  const insts: any = await fetchInstruments("SPOT");
  const tick: any = await fetchTickers("SPOT");
  const list: any[] = Array.isArray(tick) ? tick : (tick.data || []);
  const eligible = list.filter((t) => t.instId.endsWith("-USDT"));
  eligible.sort((a, b) => Number(b.vol24h) - Number(a.vol24h));
  const instIds = eligible.slice(0, N_COINS).map(t => t.instId);
  console.log("Coins:", instIds.join(","));
  const allStats: Record<string, StratStat> = {
    A: newStat("A: mum/fiyat yapısı"), B: newStat("B: sadece indikatörler"),
    C: newStat("C: yapı + RVOL"), D: newStat("D: sıkışma+direnç+RVOL"), E: newStat("E: birleşik motor"),
  };
  let analyzed = 0;
  for (const id of instIds) {
    try {
      const c4 = await fetchDeep(id, "4H", BARS);
      if (process.env.DBG) console.error("fetch c4:", id, c4.length);
      const c1h = await fetchDeep(id, "1H", BARS);
      if (process.env.DBG) console.error("fetch c1h:", id, c1h.length);
      for (const [tfArr, tfBar] of [[c4, "4H"], [c1h, "1H"]] as [Candle[], string][]) {
    if (tfArr.length < 160) { if (process.env.DBG) console.error("az bar:", id, tfBar, tfArr.length); continue; }
        // sessiz ileri-walk (adım STEP): sadece tamamlanmış mumlar
        for (let i = 150; i < tfArr.length - 1; i += STEP) {
          const slice = tfArr.slice(0, i + 1);
          // 4H destek (sadece 1H taramasında)
          const support4h = tfBar === "1H" ? c4.filter((c) => c.ts <= slice[slice.length - 1].ts) : null;
          try {
            const sig = computeEarlySignal({ symbol: id, candles15: slice, candlesFourHour: support4h, timeframe: tfBar === "4H" ? "4h" : "1h", barSent: tfBar });
            if (sig.phase === "VERI_HATASI" || sig.entryTrigger == null || sig.stop == null || sig.t1 == null || sig.t2 == null) { if (process.env.DBG && (analyzed === 0) && sig.phase !== "BEKLE") console.error("geç:" + tfBar, sig.phase, "entry", sig.entryTrigger, "stop", sig.stop, "t1", sig.t1, "t2", sig.t2); continue; }
            analyzed++;
            if (process.env.DBG && analyzed === 1) console.error("ilk analiz:", tfBar, sig.phase, sig.score, sig.entryTrigger, sig.stop, sig.t1, sig.t2);
            for (const kind of ["A", "B", "C", "D", "E"]) {
              if (!variantFire(kind, sig)) continue;
              const st = allStats[kind];
              const entryP = sig.entryTrigger!;
              const res = outcome(tfArr, i, entryP, sig.stop, sig.t1!, sig.t2!, tfBar);
              st.signals++;
              if (res.hitT1_24) st.hitT1_24++; if (res.hitT1_72) st.hitT1_72++; if (res.hitT1_168) st.hitT1_168++;
              if (res.hitT2_24) st.hitT2_24++; if (res.hitT2_72) st.hitT2_72++; if (res.hitT2_168) st.hitT2_168++;
              if (res.stopped && !res.hitT1_168) st.stopped++;
              st.mfe += Math.max(0, res.mfe ?? 0); st.mae += Math.abs(Math.min(0, res.mae ?? 0));
              // net kâr/tahmini % (komisyon+slippage dahil): giriş slip'e tabi, çıkış T1/T2/stop
              const entryAdj = entryP * (1 + SLIP);
              const riskUnit = entryAdj - sig.stop;
              const win = res.hitT2_24 ? (sig.t2 - entryAdj) : res.stopped ? -riskUnit : (res.hitT1_168 ? (sig.t1 - entryAdj) : null);
              if (win != null) {
                const fees = (entryAdj + (win > 0 ? (res.hitT2_24 ? sig.t2 : sig.t1) : sig.stop)) * FEE;
                st.netPnl += win * (1 - fees);
                if (win > 0) st.wins++;
              }
              if (res.move24 != null && Math.abs(res.move24) >= 5) st.move5_24++;
              if (res.move24 != null && Math.abs(res.move24) >= 10) st.move10_24++;
              if (res.move168 != null && Math.abs(res.move168) >= 5) st.move5_168++;
              if (res.move168 != null && Math.abs(res.move168) >= 10) st.move10_168++;
            }
          } catch (err: any) { if (process.env.DBG) console.error("adım hata:", id, tfBar, i, err?.message); }
        }
      }
    } catch (e: any) {
      console.error("coin hata:", id, e?.message);
    }
    console.log("biten:", id);
  }
  console.log("\n=== BACKTEST ÖZETİ (komisyon %0.1 + slip %0.05 dahil) ===");
  console.log("analyzed:", analyzed);
  for (const st of Object.values(allStats)) {
    const n = st.signals;
    console.log(`\n${st.name}`);
    console.log(`  sinyal: ${n} · kazanan: ${st.wins} (${n ? (st.wins / n * 100).toFixed(1) : "-"}%)`);
    console.log(`  T1 24s/72s/7g: ${st.hitT1_24}/${st.hitT1_72}/${st.hitT1_168} · T2 24s/72s/7g: ${st.hitT2_24}/${st.hitT2_72}/${st.hitT2_168} · stop: ${st.stopped}`);
    console.log(`  ort MFE %: ${n ? (st.mfe / n).toFixed(2) : "-"} · ort MAE %: ${n ? (st.mae / n).toFixed(2) : "-"} · net tahmini: ${st.netPnl.toFixed(3)} (${st.wins > 0 ? "+" : "-"} oranına göre)`);
    console.log(`  |5%+| 24s: ${st.move5_24} · |10%+| 24s: ${st.move10_24} · |5%+| 7g: ${st.move5_168} · |10%+| 7g: ${st.move10_168}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
