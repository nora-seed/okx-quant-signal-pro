"use strict";

/**
 * DOĞRUDAN OKX v5 public REST (CORS doğrulandı: OKX her origin'e yanıt veriyor).
 * Tarayıcıda çalışır; sahte veri ÜRETMEZ — bağlantı yoksa hata döner.
 * Kısımları:
 *  - In-memory + tarayıcı önbelleği (60s mum, 30s ticker)
 *  - Rate limit (min 110ms aralık), hata durumunda exponential-backoff engeli (cooldown)
 */

export type { Candle } from "./indicators";

const OKX_BASE = "https://www.okx.com";

type CacheEntry = { key: string; ts: number; data: any };

/* ---------- Basit önbellek ---------- */
class MemCache {
  private m = new Map<string, CacheEntry>();
  get(k: string, ttlMs: number): any | null {
    const hit = this.m.get(k);
    if (hit && Date.now() - hit.ts < ttlMs) return hit.data;
    return null;
  }
  set(k: string, data: any) { this.m.set(k, { key: k, ts: Date.now(), data }); }
  clearPattern(prefix: string) {
    for (const ck of this.m.keys()) if (ck.startsWith(prefix)) this.m.delete(ck);
  }
}
export const apiCache = new MemCache();

/* ---------- Rate limit + hata engeli (circuit breaker) ---------- */
let lastReq = 0;
let errCount = 0;
let blockedUntil = 0;

function throttle() {
  const now = Date.now();
  const wait = Math.max(0, RATE_SPACING_MS - (now - lastReq));
  if (wait > 0) {
    // Tarayıcıda setTimeout ile bekle
    return new Promise<void>((r) => setTimeout(r, wait));
  }
  return Promise.resolve();
}
const RATE_SPACING_MS = 110;

export async function okxFetch(path: string, params: Record<string, string> = {}): Promise<any> {
  if (Date.now() < blockedUntil) {
    throw new Error("OKX API geçici olarak engellendi (rate limit). Kısa süre sonra tekrar deneyin.");
  }
  await throttle();
  const qs = new URLSearchParams(params).toString();
  const url = `${OKX_BASE}${path}${qs ? "?" + qs : ""}`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { "Accept": "application/json" } });
  } catch (e: any) {
    errCount++;
    if (errCount >= 3) blockedUntil = Date.now() + 30_000; // 3 hata → 30 sn engelleme
    throw new Error("OKX'e bağlanılamadı (ağ/CORS hatası). " + (e?.message ?? ""));
  }
  if (!res.ok) {
    errCount++;
    if (errCount >= 5) blockedUntil = Date.now() + 30_000;
    throw new Error(`OKX API HTTP ${res.status}`);
  }
  let data: any;
  try {
    data = await res.json();
  } catch {
    throw new Error("OKX API geçersiz JSON döndü");
  }
  if (data && data.code !== undefined && data.code !== "0") {
    throw new Error(`OKX ${data.code}: ${data.msg || "bilinmeyen hata"}`);
  }
  errCount = 0;
  return data;
}

/* ---------- Public API metodları (tarayıcı) ---------- */

export const toBar = (tf: string) => (tf === "1h" ? "1H" : tf === "4h" ? "4H" : tf === "1d" ? "1D" : tf);


export type Ticker = {
  instId: string; last: number; bid: number; ask: number;
  open24h: number; high24h: number; low24h: number; vol24h: number; vol24hCcy?: number; ts: number;
};

export async function fetchTickers(instType: "SPOT" | "SWAP"): Promise<Ticker[]> {
  const cacheable = instType === "SPOT" ? 30_000 : 30_000;
  const key = `tickers:${instType}`;
  const hit = apiCache.get(key, cacheable);
  if (hit) return hit;
  const d = await okxFetch("/api/v5/market/tickers", { instType });
  const arr: Ticker[] = (d.data || []).map((t: any) => ({
    instId: t.instId,
    last: Number(t.last),
    bid: Number(t.bidPx),
    ask: Number(t.askPx),
    open24h: Number(t.open24h),
    high24h: Number(t.high24h),
    low24h: Number(t.low24h),
    vol24h: Number(t.vol24h),
    vol24hCcy: t.volCcy24h ? Number(t.volCcy24h) : undefined,
    ts: Number(t.ts),
  }));
  apiCache.set(key, arr);
  return arr;
}

export async function fetchInstruments(instType: "SPOT" | "SWAP"): Promise<any[]> {
  const hit = apiCache.get(`instruments:${instType}`, 5 * 60_000);
  if (hit) return hit;
  const d = await okxFetch("/api/v5/public/instruments", { instType });
  const arr = d.data || [];
  apiCache.set(`instruments:${instType}`, arr);
  return arr;
}

export async function fetchCandles(instId: string, bar: string, limit = 300): Promise<any[]> {
  const key = `candles:${instId}:${bar}:${limit}`;
  const hit = apiCache.get(key, 60_000);
  if (hit) return hit;
  const d = await okxFetch("/api/v5/market/candles", { instId, bar: toBar(bar), limit: String(limit) });
  const mapRow = (r: any[]) => ({
    ts: Number(r[0]),
    open: Number(r[1]),
    high: Number(r[2]),
    low: Number(r[3]),
    close: Number(r[4]),
    volume: Number(r[5]),
    confirm: Number(r[8] ?? 1), // 0 = mum hâlâ oluşuyor (son mum)
  });
  const arr = (d.data || []).map(mapRow).reverse();
  apiCache.set(key, arr);
  return arr;
}

export async function fetchHistoryCandles(instId: string, bar: string, limit = 1000): Promise<any[]> {
  const key = `histcandles:${instId}:${bar}:${limit}`;
  const hit = apiCache.get(key, 5 * 60_000);
  if (hit) return hit;
  const d = await okxFetch("/api/v5/market/history-candles", { instId, bar: toBar(bar), limit: String(limit) });
  const mapRow = (r: any[]) => ({
    ts: Number(r[0]),
    open: Number(r[1]),
    high: Number(r[2]),
    low: Number(r[3]),
    close: Number(r[4]),
    volume: Number(r[5]),
    confirm: Number(r[8] ?? 1),
  });
  const arr = (d.data || []).map(mapRow).reverse();
  apiCache.set(key, arr);
  return arr;
}

export async function fetchBooks(instId: string, size = 40): Promise<any> {
  const d = await okxFetch("/api/v5/market/books", { instId, sz: String(size) });
  const b = d?.data?.[0] || {};
  return {
    bids: (b.bids || []).map((r: any[]) => ({ price: Number(r[0]), size: Number(r[1]) })),
    asks: (b.asks || []).map((r: any[]) => ({ price: Number(r[0]), size: Number(r[1]) })),
    ts: Number(b.ts || Date.now()),
  };
}

export async function fetchFunding(instId: string): Promise<{ rate: number; nextTime: number } | null> {
  try {
    const d = await okxFetch("/api/v5/public/funding-rate", { instId });
    const f = d?.data?.[0];
    if (!f) return null;
    return { rate: Number(f.fundingRate), nextTime: Number(f.nextFundingTime) };
  } catch { return null; }
}

/* ---------------- IndexedDB isteğe-rağmen yardımcıları ---------------- */

const DB_NAME = "okxqspro";
const DB_VERSION = 1;
const STORES = {
  signals: "signals",
  settings: "settings",
  scanState: "scanState",
  opportunities: "opportunities",
  paperTrades: "paperTrades",
};

function openDb(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of Object.values(STORES)) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: "id" });
      }
    };
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

export async function idbPut(store: string, value: any) {
  const db = await openDb();
  return new Promise<void>((res, rej) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).put(value);
    tx.oncomplete = () => { res(); db.close(); };
    tx.onerror = () => { rej(tx.error); db.close(); };
  });
}

export async function idbAll<T = any>(store: string): Promise<T[]> {
  const db = await openDb();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, "readonly");
    const rq = tx.objectStore(store).getAll();
    rq.onsuccess = () => { res(rq.result || []); db.close(); };
    rq.onerror = () => { rej(rq.error); db.close(); };
  });
}

export async function idbClear(store: string) {
  const db = await openDb();
  return new Promise<void>((res, rej) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).clear();
    tx.oncomplete = () => { res(); db.close(); };
    tx.onerror = () => { rej(tx.error); db.close(); };
  });
}

export { STORES as IDB_STORES };
