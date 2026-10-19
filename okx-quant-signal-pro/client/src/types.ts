export type Timeframe = "1m" | "5m" | "15m" | "30m" | "1h" | "4h" | "1d";

export type SignalSide = "SPOT_AL" | "SPOT_SAT" | "FUTURES_LONG" | "FUTURES_SHORT" | "BEKLE";

export type Signal = {
  symbol: string;
  instType: string;
  side: SignalSide;
  score: number;
  price: number;
  entry: number | null;
  stopLoss: number | null;
  tp1: number | null;
  tp2: number | null;
  tp3: number | null;
  rr: string | null;
  timeframe: string;
  generatedAt: number;
  expiresAt: number;
  rationale: string[];
  invalidation: string[];
  strategy: string[];
  indicators: any;
  rejectReasons?: string[];
  change24h?: number | null;
  vol24h?: number | null;
};

export type Trade = {
  id: string;
  symbol: string;
  instType: string;
  side: string;
  status: string;
  entryPrice: number | null;
  exitPrice: number | null;
  qty: number | null;
  commission: number | null;
  leverage: number | null;
  openedAt: number | null;
  closedAt: number | null;
  pnlUsdt: number | null;
  pnlPct: number | null;
  rationale: string | null;
  createdAt: number;
};

export type Perf = {
  total: number; wins: number; losses: number; winRate: number;
  profitFactor: number; grossProfit: number; grossLoss: number; net: number;
  maxDrawdown: number; totalCommission: number;
};

export const TF_LABELS: Record<Timeframe, string> = {
  "1m": "1 dakika", "5m": "5 dakika", "15m": "15 dakika", "30m": "30 dakika",
  "1h": "1 saat", "4h": "4 saat", "1d": "1 gün",
};

export const STRATEGIES: { id: string; label: string }[] = [
  { id: "trend", label: "Trend Takibi" },
  { id: "ema", label: "EMA Kesişim" },
  { id: "rsimacd", label: "RSI + MACD" },
  { id: "breakout", label: "Breakout + Hacim" },
  { id: "srretest", label: "Destek/Direnç Retest" },
  { id: "bbmean", label: "Bollinger Ortalama Geri Dönüş" },
  { id: "momentum", label: "Momentum" },
  { id: "scalp", label: "Scalping" },
  { id: "mtf", label: "Çoklu Zaman Dilimi Onayı" },
  { id: "multi", label: "Çoklu Strateji Onayı" },
];

export const DEFAULT_SYMBOLS = ["BTC-USDT", "ETH-USDT", "SOL-USDT", "XRP-USDT", "DOGE-USDT"];

export function fmtPrice(n: number | null, dec = 2): string {
  if (n == null || Number.isNaN(n)) return "—";
  return n.toLocaleString("tr-TR", { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

export function fmtPct(n: number | null): string {
  if (n == null) return "—";
  return (n >= 0 ? "+" : "") + n.toFixed(2) + "%";
}

export function fmtUsd(n: number | null): string {
  if (n == null) return "—";
  return (n >= 0 ? "+" : "") + n.toLocaleString("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " USDT";
}

export function sideLabel(s: SignalSide): string {
  switch (s) {
    case "SPOT_AL": return "SPOT AL";
    case "SPOT_SAT": return "SPOT SAT / ÇIK";
    case "FUTURES_LONG": return "FUTURES LONG";
    case "FUTURES_SHORT": return "FUTURES SHORT";
    default: return "BEKLE / İŞLEM YOK";
  }
}

export function sideColor(s: SignalSide): string {
  switch (s) {
    case "SPOT_AL":
    case "FUTURES_LONG": return "#22c55e";
    case "SPOT_SAT":
    case "FUTURES_SHORT": return "#ef4444";
    default: return "#94a3b8";
  }
}
