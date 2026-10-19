"use strict";

import React, { useState, useEffect, useCallback, useRef } from "react";
import { api } from "./api";
import {
  type Signal, type Trade, type Perf, type Timeframe, TF_LABELS, STRATEGIES,
  DEFAULT_SYMBOLS, fmtPrice, fmtPct, fmtUsd, sideLabel,
} from "./types";
import { scanNextBatch, type ScanSnapshot, type ScanResultRow, type ScanProgress, BATCH_SIZE } from "./lib/scanner";
import type { StrategyId } from "./lib/signalEngine";
import "./index.css";

/* ================= ERROR BOUNDARY ================= */
class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { hasError: boolean; error: Error | null }> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="card">
          <div className="sub">Uygulama Hatası</div>
          <div className="alert err">{this.state.error?.message || "Beklenmeyen bir hata oluştu"}</div>
          <button className="btn" onClick={() => this.setState({ hasError: false, error: null })}>
            Yeniden Dene
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

/* ================= APP ================= */
type PageName = "dashboard" | "scanner" | "signals" | "trades" | "strategies" | "settings";

function App() {
  const [page, setPage] = useState<"dashboard"|"scanner"|"signals"|"trades"|"strategies"|"settings">("dashboard");
  const [apiStatus, setApiStatus] = useState<"ok"|"fail"|"checking">("checking");
  const [error, setError] = useState<string | null>(null);
  const navRefs = {
    dashboard: "📊",
    scanner: "🔎",
    signals: "📡",
    trades: "📒",
    strategies: "⚙️",
    settings: "🛡️",
  };

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        await api.health();
        if (mounted) setApiStatus("ok");
      } catch {
        if (mounted) setApiStatus("fail");
      }
    })();
    return () => { mounted = false; };
  }, []);

  const setPageWith = (p: typeof page) => setPage(p);

  return (
    <div className="app">
      <header className="appbar">
        <h1>OKX Quant Signal Pro</h1>
        <div className="status">
          {apiStatus === "checking" ? (
            <span className="muted">Bağlantı denetleniyor…</span>
          ) : apiStatus === "ok" ? (
            <>
              <span className="dot ok"></span>
              <span>API bağlantı aktif</span>
            </>
          ) : (
            <>
              <span className="dot"></span>
              <span style={{ color: "#ef4444" }}>API bağlantı yok</span>
            </>
          )}
        </div>
      </header>

      {apiStatus === "fail" && (
        <div className="banner">
          OKX public API'ye ulaşılamıyor. Canlı veri olmadan sinyal üretilemez. Lütfen internet bağlantınızı kontrol edin.
        </div>
      )}

      <div className="content">
        <div className="page">
          {page === "dashboard" && <Dashboard setPage={setPageWith} apiStatus={apiStatus} />}
          {page === "scanner" && <Scanner setPage={setPageWith} apiStatus={apiStatus} />}
          {page === "signals" && <SignalsPage setPage={setPageWith} apiStatus={apiStatus} />}
          {page === "trades" && <TradesPage setPage={setPageWith} apiStatus={apiStatus} />}
          {page === "strategies" && <StrategiesPage setPage={setPageWith} apiStatus={apiStatus} />}
          {page === "settings" && <SettingsPage setPage={setPageWith} apiStatus={apiStatus} />}
        </div>
      </div>

      <nav className="bottom-nav">
        {[
          { key: "dashboard", label: "Dashboard" },
          { key: "scanner", label: "Piyasa Tarayıcı" },
          { key: "signals", label: "Sinyaller" },
          { key: "trades", label: "İşlemler" },
          { key: "strategies", label: "Stratejiler" },
          { key: "settings", label: "Ayarlar" },
        ].map((n) => (
          <a
            key={n.key}
            href="#"
            className={`tab ${page === n.key ? "on" : ""}`}
            onClick={(e) => { e.preventDefault(); setPageWith(n.key as PageName); }}
            aria-current={page === n.key ? "page" : undefined}
          >
            <span className="dot-mark">{navRefs[n.key as PageName]}</span>
            <span>{n.label}</span>
          </a>
        ))}
      </nav>
    </div>
  );
}

/* ================= DASHBOARD ================= */
function Dashboard({ setPage, apiStatus }: { setPage: (p: PageName) => void; apiStatus: string }) {
  const [btc, setBtc] = useState<any>(null);
  const [eth, setEth] = useState<any>(null);
  const [watch, setWatch] = useState<any[]>([]);
  const [signals, setSignals] = useState<Signal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const [t1, t2, inst] = await Promise.all([
          api.tickers("SPOT").then((r: any) => r.data.find((x: any) => x.instId === "BTC-USDT")),
          api.tickers("SPOT").then((r: any) => r.data.find((x: any) => x.instId === "ETH-USDT")),
          api.instruments("SPOT"),
        ]);
        if (mounted) {
          setBtc(t1); setEth(t2);
          const syms = (inst.data as any[]).map((x) => x.instId).filter((s: string) => DEFAULT_SYMBOLS.includes(s));
          setWatch(syms);
          setError(null);
        }
      } catch (e: any) {
        setError(e.message || "Veri yüklenemedi");
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    let mounted = true;
    api.signals().then((r: any) => { if (mounted) setSignals(r.data || []); }).catch(() => {});
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    let mounted = true;
    api.signals().then((r: any) => { if (mounted) setSignals(r.data || []); });
    return () => { mounted = false; };
  }, []);

  if (loading) return <div className="card"><div className="empty">Yükleniyor…</div></div>;
  if (error) return (
    <div className="card">
      <div className="alert err">{error}</div>
      <button className="btn" onClick={() => { setError(null); setLoading(true); window.location.reload(); }}>Yeniden Dene</button>
    </div>
  );

  const active = signals.filter((s) => s.side !== "BEKLE");
  const trendText = btc ? (btc.last > (btc.open24h ?? btc.last) ? "Yukarı" : "Aşağı") : "—";

  return (
    <>
      <div className="card">
        <div className="sub">API BAĞLANTI DURUMU</div>
        <div className="flex-sb-ai-c">
          <span>{apiStatus === "ok" ? "✅ Aktif (OKX public API)" : "❌ Bağlantı yok"}</span>
          <span className="small">Sadece okuma (public) endpoint'leri · Emir gönderilmiyor</span>
        </div>
      </div>

      <div className="card">
        <div className="flex-sb-ai-c-mb-8">
          <div className="sub">BTC / ETH PİYASA ÖZETİ</div>
        </div>
        <div className="grid-2-gap-8">
          <div className="cell bg-panel2">
            <div className="k">BTC-USDT (Spot)</div>
            <div className="v mono">{fmtPrice(btc?.last)}</div>
            <div className={btc ? (Number(btc.last) >= Number(btc.open24h || 0) ? "pos fs-12-mt-2" : "neg fs-12-mt-2") : "muted fs-12-mt-2"}>
              {fmtPct(btc ? ((Number(btc.last) - Number(btc.open24h || btc.last)) / Number(btc.open24h || btc.last)) * 100 : null)}
            </div>
          </div>
          <div className="cell bg-panel2">
            <div className="k">ETH-USDT (Spot)</div>
            <div className="v mono">{fmtPrice(eth?.last)}</div>
            <div className={eth ? (Number(eth.last) >= Number(eth.open24h || 0) ? "pos fs-12-mt-2" : "neg fs-12-mt-2") : "muted fs-12-mt-2"}>
              {fmtPct(eth ? ((Number(eth.last) - Number(eth.open24h || eth.last)) / Number(btc.open24h || eth.last)) * 100 : null)}
            </div>
          </div>
        </div>
        <div className="small mt-6">Ana trend (BTC): <b>{trendText}</b> · 4H/1H/15m uyum denetleniyor</div>
      </div>

      <div className="card">
        <div className="h3-wrap flex-sb-ai-c">
          <div className="sub">AKTİF SİNYALLER</div>
          <button className="btn-sm" onClick={() => setPage("signals")}>Tümü</button>
        </div>
        {active.length === 0 ? (
          <div className="empty">Şu anda aktif sinyal yok. Tarayıcıda çalıştırın.</div>
        ) : (
          <div className="list">
            {active.slice(0, 6).map((s) => (
              <div key={s.symbol + s.generatedAt} className="list-item" onClick={() => setPage("signals")}>
                <div className="l-main">
                  <div className="l-sym">{s.symbol}</div>
                  <div className="l-tf">{s.timeframe} · {sideLabel(s.side)}</div>
                </div>
                <div>
                  <div className="l-side {s.side.includes('LONG')||s.side==='SPOT_AL'?'long':'short'}">{sideLabel(s.side)}</div>
                  <div className="l-score">Uyum {s.score}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card">
        <div className="h3-wrap flex-sb-ai-c">
          <div className="sub">SON SİNYALLER</div>
          <button className="btn-sm" onClick={() => setPage("signals")}>Geçmiş</button>
        </div>
        {signals.length === 0 ? (
          <div className="empty">Sinyal geçmişi yok.</div>
        ) : (
          <div className="list">
            {signals.slice(0, 8).map((s) => (
              <div key={s.symbol + s.generatedAt} className="list-item">
                <div className="l-main">
                  <div className="l-sym">{s.symbol}</div>
                  <div className="l-tf">{new Date(s.generatedAt).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" })} · {s.timeframe}</div>
                </div>
                <div>
                  <div className="l-side {s.side.includes('LONG')||s.side==='SPOT_AL'?'long':s.side.includes('SHORT')||s.side==='SPOT_SAT'?'short':'wait'}">{sideLabel(s.side)}</div>
                  <div className="l-score">{fmtPrice(s.price)}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card">
        <div className="sub">RİSK UYARILARI</div>
        <div className="alert warn">
          ⚠️ Bu uygulama SADECE sinyal üretir. Otomatik al-sat KAPALIDIR. İşlemleri siz OKX'te açar ve kapatırsınız.
        </div>
        <div className="alert ok">
          ✅ Hiçbir OKX API anahtarı istenmez. Sadece public piyasa verileri kullanılır.
        </div>
      </div>

      <div className="card">
        <div className="sub">TAKİP EDİLEN COINLER</div>
        <div className="pills">
          {DEFAULT_SYMBOLS.map((s) => (
            <span key={s} className="pill pill.sig on">{s}</span>
          ))}
        </div>
      </div>
    </>
  );
}

/* ================= SCANNER (20'li sayfalı tarayıcı) ================= */
function Scanner({ setPage, apiStatus }: { setPage: (p: PageName) => void; apiStatus: string }) {
  const [instType, setInstType] = useState<"SPOT"|"SWAP">("SPOT");
  const [timeframe, setTimeframe] = useState<Timeframe>("15m");
  const [strategy, setStrategy] = useState<string[]>(["multi"]);
  const [results, setResults] = useState<ScanResultRow[]>([]);
  const [failed, setFailed] = useState<{ instId: string; reason: string }[]>([]);
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [snapshot, setSnapshot] = useState<ScanSnapshot | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<{ analyzed: number; apiErrors: number; strongAL: number; strongSAT: number; watch: number; bekle: number; backfilled: string[] } | null>(null);
  // Tarama durumu: Hazır / Taranıyor / Tamamlandı / Durduruldu / Hata
  const [status, setStatus] = useState<"hazir" | "taranıyor" | "tamamlandi" | "durduruldu" | "hata">("hazir");
  const [lastScanAt, setLastScanAt] = useState<number | null>(null);
  const stopRef = useRef(false);
  const genRef = useRef(0); // eski/geç gelen taramaların yeni turu ezmesini önler
  const hasRunRef = useRef(false); // kullanıcı butonuna basılmadan tarama YOK
  const listDone = progress?.done === true;

  // Kayıtlı strateji tercihini açılışta uygula
  useEffect(() => {
    let mounted = true;
    api.loadSettings().then((s) => {
      if (mounted && Array.isArray(s.strategies) && s.strategies.length) setStrategy(s.strategies);
    }).catch(() => {});
    return () => { mounted = false; };
  }, []);

  // Snapshot'ı geri yükle (tarama BAŞLATILMAZ — manuel tarama)
  useEffect(() => {
    let mounted = true;
    api.loadScanState().then((s) => {
      if (mounted && s && s.instIds?.length) {
        setSnapshot({ instIds: s.instIds, scanned: s.scanned || [] });
        if (s.lastScanAt) setLastScanAt(s.lastScanAt);
      }
    }).catch(() => {});
    return () => { mounted = false; };
  }, []);

  const persistSnapshot = async (s: ScanSnapshot | null) => {
    setSnapshot(s);
    if (s) await api.saveScanState({ ...s, lastScanAt: lastScanAt ?? undefined });
  };

  const scanRound = async (mode: "start" | "next" | "restart") => {
    if (scanning) return; // aynı anda iki tarama engellenir
    const myGen = ++genRef.current;
    stopRef.current = false;
    setScanning(true);
    hasRunRef.current = true;
    setStatus("taranıyor");
    setScanError(null);
    setResults([]); // yeni tur başlamadan eski sonuç kartları temizlenir
    setDiagnostics(null);
    try {
      const prev: ScanSnapshot | null = mode === "restart" ? null : snapshot;
      if (mode === "restart") await api.clearScanState();
      const out = await scanNextBatch({
        instType,
        timeframe,
        strategy: strategy as StrategyId[],
        prev,
        onProgress: (p) => { if (genRef.current === myGen) setProgress({ ...p }); },
        shouldStop: () => stopRef.current,
        signal: async (s) => { await api.saveSignal(s); },
      });
      if (genRef.current !== myGen) return; // geç gelen eski tarama sonucu sayılmaz
      const now = Date.now();
      for (const r of out.rows) {
        if (!("error" in r) && r.side !== "BEKLE") {
          try { await api.saveSignal(r); } catch { /* sessiz */ }
        }
      }
      // Sadece bu turun 20 sonucu gösterilir; önceki turlar ekrandan kaldırılır
      setResults(out.rows);
      setFailed(out.failed);
      setProgress(out.progress);
      const okRows = out.rows.filter((r: any) => !("error" in r)) as any[];
      setDiagnostics({
        analyzed: okRows.length,
        apiErrors: out.failed.length,
        strongAL: okRows.filter((r) => r.strength === "strong" && (r.side === "SPOT_AL" || r.side === "FUTURES_LONG")).length,
        strongSAT: okRows.filter((r) => r.strength === "strong" && (r.side === "SPOT_SAT" || r.side === "FUTURES_SHORT")).length,
        watch: okRows.filter((r) => r.strength === "watch").length,
        bekle: okRows.filter((r) => r.strength === "off").length,
        backfilled: out.backfilled,
      });
      if (out.stopped) {
        setStatus("durduruldu");
      } else {
        setStatus("tamamlandi");
        setLastScanAt(now);
        await persistSnapshot({ ...out.snapshot, });
        await api.saveScanState({ instIds: out.snapshot.instIds, scanned: out.snapshot.scanned, lastScanAt: now });
      }
    } catch (e: any) {
      if (genRef.current === myGen) {
        setScanError(e?.message || "Tarama başarısız");
        setStatus("hata");
      }
    } finally {
      if (genRef.current === myGen) setScanning(false);
    }
  };

  const sideClass = (s: string) =>
    s.includes("LONG") || s === "SPOT_AL" ? "long" : s.includes("SHORT") || s === "SPOT_SAT" ? "short" : "wait";

  return (
    <>
      <div className="card">
        <div className="sub">TARAMA AYARLARI</div>
        <div className="grid-2-gap-8">
          <div>
            <div className="form-label">Piyasa</div>
            <select value={instType} onChange={(e) => setInstType(e.target.value as any)} disabled={scanning}>
              <option value="SPOT">SPOT</option>
              <option value="SWAP">FUTURES / PERPETUAL SWAP</option>
            </select>
          </div>
          <div>
            <div className="form-label">Zaman dilimi</div>
            <select value={timeframe} onChange={(e) => setTimeframe(e.target.value as any)} disabled={scanning}>
              {["15m", "1h", "4h", "1d"].map((tf) => <option key={tf} value={tf}>{TF_LABELS[tf as Timeframe] ?? tf}</option>)}
            </select>
          </div>
        </div>
        <div className="form-label mt-8">Strateji</div>
        <select value={strategy[0]} onChange={(e) => setStrategy([e.target.value])} disabled={scanning}>
          {STRATEGIES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>
        <div className="btn-row mt-12">
          {!hasRunRef.current ? (
            <button className="btn" disabled={scanning} onClick={() => scanRound("start")}>
              {scanning ? "Taranıyor…" : "Taramayı Başlat"}
            </button>
          ) : (
            <button className="btn" disabled={scanning || listDone} onClick={() => scanRound("next")}>
              {scanning ? "Taranıyor…" : "Sonraki 20 Coin"}
            </button>
          )}
          <button className="btn-sm secondary" disabled={scanning} onClick={() => { setResults([]); scanRound("restart"); }}>
            Baştan Tara
          </button>
          {scanning && (
            <button className="btn-sm" onClick={() => { stopRef.current = true; }}>
              Taramayı Durdur
            </button>
          )}
        </div>
        <div className="small mt-8">
          Durum: <b>{status === "hazir" ? "Hazır" : status === "taranıyor" ? "Taranıyor" : status === "tamamlandi" ? "Tamamlandı" : status === "durduruldu" ? "Durduruldu" : "Hata"}</b>
          {lastScanAt ? <> · Son tarama: {new Date(lastScanAt).toLocaleString("tr-TR")}</> : ""}
        </div>
        <div className="small mt-8">
          {progress ? (
            <>Tur {progress.round} · Bu turdaki ilerleme {progress.current}/{progress.total} · Uygun coin: {progress.eligibleCount} · Kalan: {progress.remainingCount}{progress.done ? " · Liste Bitti ✅" : ""}</>
          ) : "Taramaya başlamak için \"Taramayı Başlat\"a bas. (İlk tarama sırası: hacim + likidite + spread önceliği)"}
        </div>
      </div>

      {progress && (
        <div className="card">
          <div className="sub">TARAMA İLERLEME</div>
          <div className="rr-meter"><div className="rr-bar" style={{ width: progress.total ? `${Math.min(100, (progress.current / Math.max(1, progress.total)) * 100)}%` : "0%" }}></div></div>
          <div className="small mt-4">{progress.current}/{progress.total} coin ilerleme · {status === "taranıyor" ? "Taranıyor" : status === "tamamlandi" ? "Tamamlandı ✅" : status === "durduruldu" ? "Durduruldu ⏸" : "Hazır"}{failed.length ? ` · Başarısız: ${failed.length}` : ""}</div>
        </div>
      )}

      {scanError && (
        <div className="card">
          <div className="alert err">{scanError}</div>
          <button className="btn-sm" onClick={() => scanRound(hasRunRef.current ? "next" : "start")}>Yeniden Dene</button>
        </div>
      )}

      {/* TEŞHİS PANELİ */}
      {diagnostics && (
        <div className="card">
          <div className="sub">TARAMA TEŞHİS PANELİ</div>
          <div className="perf-grid">
            <div className="perf-cell"><div className="k">Analiz edilen</div><div className="v">{diagnostics.analyzed}</div></div>
            <div className="perf-cell"><div className="k">API hatalı</div><div className="v">{diagnostics.apiErrors}</div></div>
            <div className="perf-cell"><div className="k">Güçlü AL/LONG</div><div className="v pos">{diagnostics.strongAL}</div></div>
            <div className="perf-cell"><div className="k">Güçlü SAT/SHORT</div><div className="v neg">{diagnostics.strongSAT}</div></div>
            <div className="perf-cell"><div className="k">İzleme Listesi</div><div className="v">{diagnostics.watch}</div></div>
            <div className="perf-cell"><div className="k">BEKLE</div><div className="v muted">{diagnostics.bekle}</div></div>
          </div>
          {diagnostics.backfilled.length > 0 && (
            <div className="small mt-6">Geçmiş mum geri doldurulan coinler: {diagnostics.backfilled.join(", ")}</div>
          )}
          <div className="small mt-6">Zaman dilimi uygulanmış: <b>{TF_LABELS[timeframe] ?? timeframe}</b> — kart başlıklarında her coinin gerçek OKX barı (ör. 4H) gösterilir.</div>
        </div>
      )}

      <div className="card">
        <div className="sub">SONUÇLAR</div>
        {results.length === 0 ? <div className="empty">{scanning ? "Taranıyor, lütfen bekleyin…" : "Sonuç yok."}</div> :
          <div className="list">
            {results.map((r, idx) => {
              const anyErr = "error" in r;
              return (
                <div key={(r.symbol ?? "x") + idx} className="list-item" onClick={() => { if (!anyErr) setPage("signals"); }}>
                  <div className="l-main">
                    <div className="l-sym">{r.symbol}</div>
                    <div className="l-tf">{anyErr ? "hatalı" : `${(r as any).barSent ?? (r as any).timeframe} · ${(r as any).strategy.join(",")}`}</div>
                  </div>
                  <div className="text-right">
                    <div className={`l-side ${sideClass(r.side)}`}>
                      {(r as any).strength === "watch" ? "İzleme" : sideLabel(r.side as any)}
                    </div>
                    <div className="l-score">{anyErr ? (r as any).error : `Puan ${r.score} · ${sideClass(r.side)}${(r as any).strength === "watch" ? " (izleme)" : ""}`}</div>
                    <div className="small mono">{fmtPrice((r as any).price)}</div>
                    {!anyErr && (r as any).strength === "watch" && (r as any).watchReasons?.length > 0 && (
                      <div className="small">{(r as any).watchReasons.slice(0, 2).join(" · ")}</div>
                    )}
                    {!anyErr && (r as any).strength !== "strong" && (r as any).rejectReasons?.length > 0 && (
                      <div className="small">{(r as any).rejectReasons.slice(0, 2).join(" · ")}</div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        }
        {progress?.done && (
          <div className="alert ok mt-8">Liste Bitti — tüm uygun coinler tarandı. "Baştan Tara" ile yeniden başlayabilirsiniz.</div>
        )}
      </div>

      {failed.length > 0 && (
        <div className="card">
          <div className="sub">BAŞARISIZ TARANAN COİNLER</div>
          <div className="small">{failed.map((f) => `${f.instId}: ${f.reason}`).join(" · ")}</div>
        </div>
      )}

      <div className="card">
        <div className="sub">NOTLAR</div>
        <div className="small">
          Tarama OKX public mum verisiyle tarayıcıda çalışır. BEKLE: yeterli onay yok / düşük hacim / trend uyumsuzluğu / düşük RR.
          Her tur 20 farklı coin; taranan coinler kalıcı olarak işaretlenir (tekrar yok), "Baştan Tara" seti sıfırlar.
        </div>
      </div>
    </>
  );
}


/* ================= SIGNALS ================= */
function SignalsPage({ setPage, apiStatus }: { setPage: (p: PageName) => void; apiStatus: string }) {
  const [symbol, setSymbol] = useState("BTC-USDT");
  const [instType, setInstType] = useState<"SPOT"|"SWAP">("SPOT");
  const [timeframe, setTimeframe] = useState<Timeframe>("15m");
  const [strategy, setStrategy] = useState("multi");
  const [signal, setSignal] = useState<Signal | null>(null);
  const [signalError, setSignalError] = useState<string | null>(null);
  const [history, setHistory] = useState<Signal[]>([]);
  const [calc, setCalc] = useState<{ capital: number; riskPct: number; qty: number | null; lossUsdt: number | null; tpUsdt: number[] | null } | null>(null);
  const [loading, setLoading] = useState(false);

  const generate = async () => {
    setLoading(true);
    setSignalError(null);
    try {
      const r = await api.signal(symbol, instType, timeframe, [strategy]);
      // 24s değişim bilgisini ticker'dan ekle
      try {
        const tick = await api.tickers(instType);
        const t = (tick.data as any[]).find((x) => x.instId === symbol);
        if (t) {
          (r.signal as any).change24h = t.open24h ? ((t.last - t.open24h) / t.open24h) * 100 : null;
          (r.signal as any).vol24h = t.vol24h;
        }
      } catch { /* ticker opsiyonel */ }
      setSignal(r.signal);
      await saveSignalToHistory(r.signal);
    } catch (e: any) {
      setSignalError(e.message || "Sinyal üretilemedi");
    } finally {
      setLoading(false);
    }
  };

  const saveSignalToHistory = async (s: Signal) => {
    try {
      await api.saveSignal({ ...s });
      const h = await api.signals();
      setHistory(h.data || []);
    } catch {}
  };

  useEffect(() => {
    api.signals().then((r: any) => setHistory(r.data || [])).catch(() => {});
  }, []);

  const computeCalc = useCallback(() => {
    if (!signal || signal.side === "BEKLE" || !signal.entry || !signal.stopLoss) { setCalc(null); return; }
    const capital = 1000; // default, will read from state below
    // We read from refs below
  }, [signal]);

  const [capital, setCapital] = useState(1000);
  const [riskPct, setRiskPct] = useState(1);
  const [leverage, setLeverage] = useState(1);

  const runCalc = () => {
    if (!signal || signal.side === "BEKLE" || !signal.entry || !signal.stopLoss) { setCalc(null); return; }
    const entry = signal.entry;
    const riskUsdt = capital * (riskPct / 100);
    const riskPerUnit = Math.abs(entry - signal.stopLoss);
    const qty = riskPerUnit > 0 ? riskUsdt / riskPerUnit : 0;
    const notional = qty * entry;
    const margin = instType === "SWAP" ? notional / leverage : notional;
    const lossUsdt = -riskUsdt;
    const tpUsdt = [signal.tp1, signal.tp2, signal.tp3].map((tp) =>
      tp != null ? (signal.side === "SPOT_AL" || signal.side === "FUTURES_LONG" ? tp - entry : entry - tp) * qty : null
    ).filter((t): t is number => t != null);
    setCalc({ capital, riskPct, qty, lossUsdt, tpUsdt: tpUsdt.length > 0 ? tpUsdt : null });
  };

  useEffect(() => { runCalc(); }, [signal, capital, riskPct, leverage, instType]);

  return (
    <>
      <div className="card">
        <div className="sub">SİNYAL ÜRET</div>
        <div className="form-label">İşlem çifti</div>
        <input value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} placeholder="BTC-USDT" />
        <div className="grid-2-gap-8 mt-8">
          <div>
            <div className="form-label">Tür</div>
            <select value={instType} onChange={(e) => setInstType(e.target.value as any)}>
              <option value="SPOT">SPOT</option>
              <option value="SWAP">FUTURES SWAP</option>
            </select>
          </div>
          <div>
            <div className="form-label">Zaman dilimi</div>
            <select value={timeframe} onChange={(e) => setTimeframe(e.target.value as any)}>
              {Object.entries(TF_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
        </div>
        <div className="form-label mt-8">Strateji</div>
        <select value={strategy} onChange={(e) => setStrategy(e.target.value)}>
          {STRATEGIES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>
        <button className="btn mt-12" onClick={generate}>{loading ? "Üretiliyor…" : "Sinyal Üret"}</button>
      </div>

      {signalError && (
        <div className="card">
          <div className="alert err">{signalError}</div>
          <button className="btn" onClick={() => { setSignalError(null); }}>Yeniden Dene</button>
        </div>
      )}

      {signal && (
        <>
          <div className="card signal-card">
            <div className="sig-head">
              <div className="sig-side {signal.side.includes('LONG')||signal.side==='SPOT_AL'?'long':signal.side.includes('SHORT')||signal.side==='SPOT_SAT'?'short':'wait'}">{sideLabel(signal.side)}</div>
              <div className="sig-score">Uyum puanı: {signal.score}/100</div>
            </div>
            <div className="sig-price mono">{fmtPrice(signal.price)}</div>
            <div className="sig-meta">
              <div><b>Çift:</b> {signal.symbol}</div>
              <div><b>Tür:</b> {signal.instType}</div>
              <div><b>Zaman dilimi:</b> {signal.timeframe}</div>
              <div><b>Oluşturulma:</b> {new Date(signal.generatedAt).toLocaleString("tr-TR")}</div>
              <div><b>Geçerlilik:</b> {new Date(signal.expiresAt).toLocaleString("tr-TR")}</div>
              <div><b>Strateji:</b> {signal.strategy.join(", ")}</div>
              {(signal as any).change24h != null && (
                <div><b>24s değişim:</b> <span className={(signal as any).change24h >= 0 ? "pos" : "neg"}>{fmtPct((signal as any).change24h)}</span></div>
              )}
              {signal.side === "BEKLE" && signal.rejectReasons && signal.rejectReasons.length > 0 && (
                <div><b>Neden BEKLE:</b> {signal.rejectReasons.join(" · ")}</div>
              )}
              {signal.side === "BEKLE" && !signal.rejectReasons?.length && signal.rationale.length > 0 && (
                <div><b>Neden BEKLE:</b> {signal.rationale.join(" · ")}</div>
              )}
            </div>
              <div className="rr-meter"><div className="rr-bar" style={{ width: `${Math.min(100, signal.score || 0)}%` }}></div></div>

            {signal.entry != null && (
              <>
                <div className="sig-line"><span>Giriş</span><span className="val mono">{fmtPrice(signal.entry)}</span></div>
                <div className="sig-line"><span>Stop-loss</span><span className="val mono">{fmtPrice(signal.stopLoss)}</span></div>
                <div className="sig-line"><span>TP1</span><span className="val mono">{fmtPrice(signal.tp1)}</span></div>
                <div className="sig-line"><span>TP2</span><span className="val mono">{fmtPrice(signal.tp2)}</span></div>
                <div className="sig-line"><span>TP3</span><span className="val mono">{fmtPrice(signal.tp3)}</span></div>
                <div className="sig-line"><span>Risk/Ödül</span><span className="val">{signal.rr ?? "—"}</span></div>
              </>
            )}

            <div className="rationale">
              <b>Gerekçe:</b> {signal.rationale.join(" · ")}
            </div>
            <div className="invalidation">
              <b>Geçersizlik:</b> {signal.invalidation.join(" · ")}
            </div>
          </div>

          <div className="card">
            <div className="sub">KAR/ZARAR HESAPLAMA</div>
            <div className="form-label">Toplam sermaye (USDT)</div>
            <input type="number" value={capital} onChange={(e) => setCapital(parseFloat(e.target.value) || 0)} />
            <div className="form-label">İşlem başına risk (%)</div>
            <input type="number" value={riskPct} onChange={(e) => setRiskPct(parseFloat(e.target.value) || 1)} step="0.1" />
            {instType === "SWAP" && (
              <>
                <div className="form-label">Kaldıraç</div>
                <input type="number" value={leverage} onChange={(e) => setLeverage(parseFloat(e.target.value) || 1)} />
              </>
            )}
            <div className="perf-grid">
              <div className="perf-cell"><div className="k">Stop olursa zarar (USDT)</div><div className="v neg">{calc?.lossUsdt != null ? fmtUsd(calc.lossUsdt) : "—"}</div></div>
              <div className="perf-cell"><div className="k">Pozisyon büyüklüğü</div><div className="v">{calc?.qty != null ? calc.qty.toFixed(6) : "—"}</div></div>
              <div className="perf-cell"><div className="k">Tahmini marjin (USDT)</div><div className="v">{instType === "SWAP" && calc?.qty != null && signal.entry != null ? fmtUsd((calc.qty * signal.entry) / leverage) : "—"}</div></div>
              <div className="perf-cell"><div className="k">TP1 kâr (USDT)</div><div className="v pos">{calc?.tpUsdt?.[0] != null ? fmtUsd(calc.tpUsdt[0]) : "—"}</div></div>
              <div className="perf-cell"><div className="k">TP2 kâr (USDT)</div><div className="v pos">{calc?.tpUsdt?.[1] != null ? fmtUsd(calc.tpUsdt[1]) : "—"}</div></div>
              <div className="perf-cell"><div className="k">TP3 kâr (USDT)</div><div className="v pos">{calc?.tpUsdt?.[2] != null ? fmtUsd(calc.tpUsdt[2]) : "—"}</div></div>
            </div>
            <div className="small mt-8">TahminiNet = kâr − komisyon. Komisyon/slippage tahmindir, kesin sonuç değildir.</div>
          </div>
        </>
      )}

      {!signal && <div className="empty">Bir çift seçip "Sinyal Üret"e basın.</div>}

      <div className="card mt-12">
        <div className="sub">SİNYAL GEÇMİŞİ</div>
        {history.length === 0 ? <div className="empty">Henüz kayıt yok.</div> :
          <div className="list">
            {history.slice(0, 12).map((s) => (
              <div key={s.symbol + s.generatedAt} className="list-item">
                <div className="l-main">
                  <div className="l-sym">{s.symbol}</div>
                  <div className="l-tf">{s.timeframe} · {new Date(s.generatedAt).toLocaleDateString("tr-TR")}</div>
                </div>
                <div className="text-right">
                  <div className="l-side {s.side.includes('LONG')||s.side==='SPOT_AL'?'long':s.side.includes('SHORT')||s.side==='SPOT_SAT'?'short':'wait'}">{sideLabel(s.side)}</div>
                  <div className="l-score">{s.score}</div>
                </div>
              </div>
            ))}
          </div>
        }
      </div>
    </>
  );
}

/* ================= TRADES ================= */
function TradesPage({ setPage, apiStatus }: { setPage: (p: PageName) => void; apiStatus: string }) {
  const [trades, setTrades] = useState<Trade[]>([]);
  const [perf, setPerf] = useState<Perf | null>(null);
  const [tradesError, setTradesError] = useState<string | null>(null);
  const [form, setForm] = useState({ symbol: "", instType: "SPOT" as "SPOT"|"SWAP", side: "LONG", status: "girdi" as const, entryPrice: "", exitPrice: "", qty: "", commission: "", leverage: "1", openedAt: "", closedAt: "", rationale: "" });

  useEffect(() => {
    let mounted = true;
    api.trades().then((r: any) => { if (mounted) { setTrades(r.data || []); setTradesError(null); } }).catch((e: any) => { if (mounted) setTradesError(e.message || "İşlemler yüklenemedi"); });
    api.performance().then((r: any) => { if (mounted) setPerf(r.data || null); }).catch(() => {});
    return () => { mounted = false; };
  }, []);

  const addTrade = async () => {
    const openedAt = form.openedAt ? new Date(form.openedAt).getTime() : Date.now();
    const closedAt = form.closedAt ? new Date(form.closedAt).getTime() : null;
    try {
      await api.saveTrade({ ...form, openedAt, closedAt });
      const r = await api.trades();
      setTrades(r.data || []);
      const p = await api.performance();
      setPerf(p.data || null);
      setForm({ symbol: "", instType: "SPOT", side: "LONG", status: "girdi", entryPrice: "", exitPrice: "", qty: "", commission: "", leverage: "1", openedAt: "", closedAt: "", rationale: "" });
    } catch (e: any) {
      setTradesError(e.message || "İşlem eklenemedi");
    }
  };

  const statuses = ["girdi", "kapatti", "stop", "tp1", "tp2", "tp3", "iptal"] as const;

  return (
    <>
      <div className="card">
        <div className="sub">MANUEL İŞLEM GÜNÜĞÜ</div>
        {tradesError && (
          <div className="alert err">{tradesError}</div>
        )}
        <p className="small">İşlemleri siz OKX'te açar/kapatırsınız. Burada sadece kaydınızı tutunuz. Otomatik emir yok.</p>
        <div className="form-label">Çift</div>
        <input value={form.symbol} onChange={(e) => setForm({ ...form, symbol: e.target.value.toUpperCase() })} placeholder="BTC-USDT" />
        <div className="grid-2-gap-8 mt-8">
          <div>
            <div className="form-label">Tür</div>
            <select value={form.instType} onChange={(e) => setForm({ ...form, instType: e.target.value as any })}>
              <option value="SPOT">SPOT</option>
              <option value="SWAP">FUTURES SWAP</option>
            </select>
          </div>
          <div>
            <div className="form-label">Yön</div>
            <select value={form.side} onChange={(e) => setForm({ ...form, side: e.target.value as any })}>
              <option value="LONG">LONG / AL</option>
              <option value="SHORT">SHORT / SAT</option>
            </select>
          </div>
        </div>
        <div className="grid-3-gap-8 mt-8">
          <div>
            <div className="form-label">Durum</div>
            <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as any })}>
              {statuses.map((s) => <option key={s} value={s}>{s === "girdi" ? "İşleme girdim" : s === "kapatti" ? "İşlemi kapattım" : s === "stop" ? "Stop oldu" : s.startsWith("tp") ? `TP${s.slice(2)} gerçekleşti` : "İptal ettim"}</option>)}
            </select>
          </div>
          <div>
            <div className="form-label">Giriş fiyatı</div>
            <input type="number" value={form.entryPrice} onChange={(e) => setForm({ ...form, entryPrice: e.target.value })} />
          </div>
          <div>
            <div className="form-label">Çıkış fiyatı</div>
            <input type="number" value={form.exitPrice} onChange={(e) => setForm({ ...form, exitPrice: e.target.value })} />
          </div>
        </div>
        <div className="grid-3-gap-8 mt-8">
          <div>
            <div className="form-label">Miktar</div>
            <input type="number" value={form.qty} onChange={(e) => setForm({ ...form, qty: e.target.value })} />
          </div>
          <div>
            <div className="form-label">Komisyon (USDT)</div>
            <input type="number" value={form.commission} onChange={(e) => setForm({ ...form, commission: e.target.value })} />
          </div>
          <div>
            <div className="form-label">Kaldıraç</div>
            <input type="number" value={form.leverage} onChange={(e) => setForm({ ...form, leverage: e.target.value })} />
          </div>
        </div>
        <div className="mt-8">
          <div className="form-label">Açılış tarihi/saati</div>
          <input type="datetime-local" value={form.openedAt ? new Date(form.openedAt).toISOString().slice(0, 16) : ""} onChange={(e) => setForm({ ...form, openedAt: e.target.value })} />
        </div>
        <div className="mt-8">
          <div className="form-label">Gerekçe (isteğe bağlı)</div>
          <input value={form.rationale} onChange={(e) => setForm({ ...form, rationale: e.target.value })} />
        </div>
        <button className="btn mt-12" onClick={addTrade}>İşlemi Kaydet</button>
      </div>

      {perf && (
        <div className="card">
          <div className="sub">PERFORMANS RAPORU</div>
          <div className="perf-grid">
            <div className="perf-cell"><div className="k">Toplam işlem</div><div className="v">{perf.total}</div></div>
            <div className="perf-cell"><div className="k">Win rate</div><div className="v">{perf.winRate}%</div></div>
            <div className="perf-cell"><div className="k">Profit factor</div><div className="v">{perf.profitFactor === Infinity ? "∞" : perf.profitFactor}</div></div>
            <div className="perf-cell"><div className="k">Maksimum drawdown</div><div className="v neg">{fmtUsd(perf.maxDrawdown)}</div></div>
            <div className="perf-cell"><div className="k">Net sonuç</div><div className={perf.net >= 0 ? "pos" : "neg"}>{fmtUsd(perf.net)}</div></div>
            <div className="perf-cell"><div className="k">Toplam komisyon</div><div className="v">{fmtUsd(perf.totalCommission)}</div></div>
          </div>
        </div>
      )}

      <div className="card">
        <div className="sub">İŞLEM KAYITLARI</div>
        {trades.length === 0 ? <div className="empty">Kayıt yok.</div> :
          <div className="list">
            {trades.slice(0, 30).map((t) => (
              <div key={t.id} className="list-item">
                <div className="l-main">
                  <div className="l-sym">{t.symbol}</div>
                  <div className="l-tf">{t.instType} · {t.side} · {t.status}</div>
                </div>
                <div className="text-right">
                  <div className={`t-status ${t.status === "tp1"||t.status === "tp2"||t.status === "tp3"||t.status === "kapatti" ? (t.pnlUsdt! >= 0 ? "t-win" : "t-loss") : t.status === "stop" ? "t-loss" : "t-open"}`}>{t.status === "girdi" ? "Açık" : t.status === "kapatti" ? "Kapalı" : t.status}</div>
                  <div className={t.pnlUsdt != null && t.pnlUsdt >= 0 ? "pos" : "neg"}>{t.pnlUsdt != null ? fmtUsd(t.pnlUsdt) : "—"}</div>
                </div>
              </div>
            ))}
          </div>
        }
      </div>
    </>
  );
}

/* ================= STRATEGIES ================= */
function StrategiesPage({ setPage, apiStatus }: { setPage: (p: PageName) => void; apiStatus: string }) {
  const [enabled, setEnabled] = useState<string[]>(["multi"]);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api.loadSettings().then((s) => {
      if (s.strategies?.length) setEnabled(s.strategies);
    }).catch(() => {});
  }, []);

  const toggle = (id: string) => {
    setEnabled((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
      const final = next.length === 0 ? ["multi"] : next;
      api.saveSettings({ strategies: final }).catch(() => {});
      setSaved(true);
      setTimeout(() => setSaved(false), 1800);
      return final;
    });
  };

  return (
    <div className="card">
      <div className="sub">SEÇİLEBİLİR STRATEJİLER</div>
      <div className="small mt-4">Birden fazla strateji seçebilirsiniz; seçim tarama ve sinyal üretiminde birlikte kullanılır (kalıcıdır).</div>
      <div className="strategy-list mt-8">
        {STRATEGIES.map((s) => (
          <div key={s.id} className="strategy-card">
            <div className="strategy-info">
              <div className="strategy-name">{s.label}</div>
              <div className="strategy-code">{s.id}</div>
            </div>
            <button className={`strategy-toggle btn-sm ${enabled.includes(s.id) ? "" : "secondary"}`} onClick={() => toggle(s.id)}>
              {enabled.includes(s.id) ? "✓ Açık" : "Kapalı"}
            </button>
          </div>
        ))}
      </div>
      {saved && <div className="alert ok mt-8">Strateji tercihi kaydedildi.</div>}
      <div className="small mt-10">
        Aynı göstergeden gelen tekrar eden onaylar bağımsız sinyal sayılmaz; her strateji kendi puanı üzerinden işlenir ve konsensüs bonusu en fazla +15 puandır.
      </div>
    </div>
  );
}

/* ================= SETTINGS ================= */
function SettingsPage({ setPage, apiStatus }: { setPage: (p: PageName) => void; apiStatus: string }) {
  return (
    <div className="card">
      <div className="sub">AYARLAR</div>
      <div className="form-label">Varsayılan minimum risk/ödül</div>
      <input type="number" defaultValue="2" step="0.1" disabled />
      <div className="small mt-6">Sunucu tarafında varsayılan 1:2'dir. Ayar ekranı ileriki sürümde etkinleştirilecek.</div>
      <div className="form-label mt-14">Güvenlik</div>
      <div className="alert ok">✅ Gerçek emir oluşturma KAPALI · API anahtarı istenmez · Otomatik trading yok</div>
      <div className="small mt-6">İleride otomasyon: açık kullanıcı onayı, ayrı yetkilendirme, risk limitleri, kill switch ve paper-trading gerektirecektir.</div>
    </div>
  );
}

/* ================= ROOT ================= */
function Root() {
  return (
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  );
}

export default Root;
