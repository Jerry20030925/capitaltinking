import type { Bar, Indicators } from "../capital/client.js";

/**
 * Technical indicators — the deterministic "Quant" layer. Computed in code from
 * OHLC history and fed to the brain so it reasons on real momentum / trend /
 * volatility instead of eyeballing a single day's % change.
 */

const round = (n: number) => Math.round(n * 10000) / 10000;

/** Exponential moving average series (same length as input). */
function emaSeries(values: number[], period: number): number[] {
  if (values.length === 0) return [];
  const k = 2 / (period + 1);
  const out = [values[0]!];
  for (let i = 1; i < values.length; i++) {
    out.push(values[i]! * k + out[i - 1]! * (1 - k));
  }
  return out;
}

const emaLast = (values: number[], period: number): number => {
  const s = emaSeries(values, period);
  return s[s.length - 1] ?? NaN;
};

/** Wilder's RSI over `period` closes. */
function rsi(closes: number[], period = 14): number {
  if (closes.length < period + 1) return NaN;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i]! - closes[i - 1]!;
    if (d >= 0) gain += d;
    else loss -= d;
  }
  gain /= period;
  loss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i]! - closes[i - 1]!;
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (loss === 0) return gain === 0 ? 50 : 100; // flat -> neutral, not overbought
  return 100 - 100 / (1 + gain / loss);
}

/** MACD (12,26,9) — line, signal, histogram at the latest bar. */
function macd(closes: number[]): { macd: number; signal: number; hist: number } {
  const ema12 = emaSeries(closes, 12);
  const ema26 = emaSeries(closes, 26);
  const line = closes.map((_, i) => ema12[i]! - ema26[i]!);
  const signal = emaSeries(line, 9);
  const i = closes.length - 1;
  return { macd: line[i]!, signal: signal[i]!, hist: line[i]! - signal[i]! };
}

/** Wilder's Average True Range over `period` bars. */
function atr(bars: Bar[], period = 14): number {
  if (bars.length < period + 1) return NaN;
  const trs: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const h = bars[i]!.high;
    const l = bars[i]!.low;
    const pc = bars[i - 1]!.close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  let v = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) v = (v * (period - 1) + trs[i]!) / period;
  return v;
}

/** Compact Chinese description of the indicators for the LLM prompt. */
export function describeIndicators(i: Indicators): string {
  const rsiTag = i.rsi14 >= 70 ? "超买" : i.rsi14 <= 30 ? "超卖" : "中性";
  const macdDir = i.macdHist > 0 ? "多头动量" : i.macdHist < 0 ? "空头动量" : "动量走平";
  const ema = Number.isNaN(i.ema50)
    ? `EMA20 ${i.ema20}`
    : `EMA20 ${i.ema20}/EMA50 ${i.ema50}`;
  return `RSI14 ${i.rsi14}(${rsiTag})，MACD柱 ${i.macdHist}(${macdDir})，${ema}，ATR ${i.atr14}(波动${i.atrPct}%)`;
}

/** Compute the full indicator set. Returns undefined if too little history. */
export function computeIndicators(bars: Bar[]): Indicators | undefined {
  const closes = bars.map((b) => b.close);
  if (closes.length < 26) return undefined; // need enough for MACD/EMA26

  const m = macd(closes);
  const last = closes[closes.length - 1]!;
  const a = atr(bars, 14);
  return {
    rsi14: round(rsi(closes, 14)),
    ema20: round(emaLast(closes, 20)),
    ema50: closes.length >= 50 ? round(emaLast(closes, 50)) : NaN,
    macd: round(m.macd),
    macdSignal: round(m.signal),
    macdHist: round(m.hist),
    atr14: round(a),
    atrPct: last > 0 ? round((a / last) * 100) : 0,
  };
}
