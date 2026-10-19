"use strict";

/**
 * OKX Public Market Data Proxy (v5).
 * Sadece kimlik doğrulaması gerektirmeyen public endpoint'leri kullanır.
 * API anahtarı istenmez, emir gönderilmez.
 */

import fetch from "node-fetch";

const OKX_BASE = "https://www.okx.com";

// Rate limit: OKX public endpoint'ler için konservatif sınır (~8 rps)
const RATE_LIMIT_MS = 120;

type Candle = {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

type BookLevel = { price: number; size: number };
type OrderBook = { bids: BookLevel[]; asks: BookLevel[]; ts: number };

type Instrument = {
  instId: string;
  instType: string;
  underlying: string;
  settlementCcy: string;
  ctType: string;
  ctMult: string;
  ctVal: string;
  ctValCcy: string;
  optType?: string;
  strike?: string;
  listTime?: string;
  expTime?: string;
  lever?: string;
  tickSz: string;
  lotSz: string;
  minSz: string;
  state: string;
};

const cache = new Map<string, { ts: number; data: unknown }>(); // 60s önbellek

function cacheKey(path: string, params: Record<string, string> = {}) {
  const qs = new URLSearchParams(params).toString();
  return path + "?" + qs;
}

function getCached(key: string): unknown {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < 60 * 1000) return hit.data;
  return null;
}

function setCached(key: string, data: unknown) {
  cache.set(key, { ts: Date.now(), data });
}

let lastRequest = 0;
async function rateLimitedFetch(url: string, opts: Parameters<typeof fetch>[1] = {}) {
  const now = Date.now();
  const wait = Math.max(0, RATE_LIMIT_MS - (now - lastRequest));
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequest = Date.now();
  const res = await fetch(url, opts);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`OKX API ${res.status}: ${text}`);
  }
  return res.json();
}

async function okxGet(path: string, params: Record<string, string> = {}) {
  const key = cacheKey(path, params);
  const cached = getCached(key);
  if (cached !== null) return cached;
  const qs = new URLSearchParams(params).toString();
  const url = `${OKX_BASE}${path}${qs ? "?" + qs : ""}`;
  const data = await rateLimitedFetch(url);
  setCached(key, data);
  return data;
}

async function listInstruments(instType: string): Promise<Instrument[]> {
  const data = await okxGet("/api/v5/public/instruments", { instType });
  if ((data as any).code !== "0")
    throw new Error((data as any).msg || "instruments error");
  return (data as any).data || [];
}

async function tickers(instType: string) {
  const data = await okxGet("/api/v5/market/tickers", { instType });
  if ((data as any).code !== "0") throw new Error((data as any).msg || "tickers error");
  return (data as any).data || [];
}

async function candles(
  instId: string,
  bar: string,
  before?: string,
  after?: string,
  limit?: number
): Promise<Candle[]> {
  const params: Record<string, string> = { instId, bar };
  if (before) params.before = before;
  if (after) params.after = after;
  if (limit) params.limit = String(limit);
  const data = await okxGet("/api/v5/market/candles", params);
  if ((data as any).code !== "0") throw new Error((data as any).msg || "candles error");
  return (data.data || []).map((r: any[]) => ({
    ts: Number(r[0]),
    open: Number(r[1]),
    high: Number(r[2]),
    low: Number(r[3]),
    close: Number(r[4]),
    volume: Number(r[5]),
  })).reverse(); // OKX yeni→eski döner; eski→yeni sırala
}

async function historyCandles(
  instId: string,
  bar: string,
  before?: string,
  after?: string,
  limit?: number
): Promise<Candle[]> {
  const params: Record<string, string> = { instId, bar };
  if (before) params.before = before;
  if (after) params.after = after;
  if (limit) params.limit = String(limit);
  const data = await okxGet("/api/v5/market/history-candles", params);
  if ((data as any).code !== "0")
    throw new Error((data as any).msg || "history-candles error");
  return (data.data || []).map((r: any[]) => ({
    ts: Number(r[0]),
    open: Number(r[1]),
    high: Number(r[2]),
    low: Number(r[3]),
    close: Number(r[4]),
    volume: Number(r[5]),
  })).reverse(); // eski→yeni sırala
}

async function books(instId: string, size = 40): Promise<OrderBook> {
  const data = await okxGet("/api/v5/market/books", { instId, sz: String(size) });
  if ((data as any).code !== "0") throw new Error((data as any).msg || "books error");
  const d = (data as any).data && (data as any).data[0];
  if (!d) return { bids: [], asks: [], ts: 0 };
  return {
    bids: (d.bids || []).map((r: any[]) => ({ price: Number(r[0]), size: Number(r[1]) })),
    asks: (d.asks || []).map((r: any[]) => ({ price: Number(r[0]), size: Number(r[1]) })),
    ts: Number(d.ts || Date.now()),
  };
}

export { okxGet, listInstruments, tickers, candles, historyCandles, books };
export type { Candle, OrderBook, Instrument };
