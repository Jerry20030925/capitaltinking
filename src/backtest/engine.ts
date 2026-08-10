import type { Bar } from "../capital/client.js";

/**
 * Walk-forward backtester for the DETERMINISTIC strategy components only
 * (trend / momentum / mean-reversion / breakout on real OHLC history). This is
 * the honest, backtestable half of the system: the news/LLM core CANNOT be
 * backtested faithfully (no time-aligned historical news corpus + the model
 * already knows how past events resolved → look-ahead bias), so we never pretend
 * to. Here we grid-search SL/TP per strategy on IN-SAMPLE bars and report the
 * winner's OUT-OF-SAMPLE result, so only params that survive unseen data count.
 *
 * All indicator series are CAUSAL (value at bar i uses only bars 0..i), so the
 * simulation has no look-ahead. Entries fill at the signal bar's close; exits
 * check each later bar's high/low for SL/TP (SL assumed first if both hit —
 * conservative), or reverse on an opposite signal.
 */

export type StrategyName = "trend" | "momentum" | "mean-reversion" | "breakout";
export const STRATEGIES: readonly StrategyName[] = [
  "trend",
  "momentum",
  "mean-reversion",
  "breakout",
];

// ---- causal indicator series ------------------------------------------------

function emaSeries(values: number[], period: number): number[] {
  if (values.length === 0) return [];
  const k = 2 / (period + 1);
  const out = [values[0]!];
  for (let i = 1; i < values.length; i++) out.push(values[i]! * k + out[i - 1]! * (1 - k));
  return out;
}

/** Wilder's RSI at every bar (NaN until enough history). */
function rsiSeries(closes: number[], period = 14): number[] {
  const out = new Array<number>(closes.length).fill(NaN);
  if (closes.length < period + 1) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i]! - closes[i - 1]!;
    if (d >= 0) gain += d;
    else loss -= d;
  }
  gain /= period;
  loss /= period;
  out[period] = loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i]! - closes[i - 1]!;
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

/** MACD histogram at every bar. */
function macdHistSeries(closes: number[]): number[] {
  const ema12 = emaSeries(closes, 12);
  const ema26 = emaSeries(closes, 26);
  const line = closes.map((_, i) => ema12[i]! - ema26[i]!);
  const signal = emaSeries(line, 9);
  return line.map((v, i) => v - signal[i]!);
}

interface Series {
  closes: number[];
  ema20: number[];
  ema50: number[];
  rsi: number[];
  macdHist: number[];
  priorHigh: number[]; // highest high of the prior `bo` bars (breakout)
  priorLow: number[]; // lowest low of the prior `bo` bars
}

function buildSeries(bars: Bar[], bo = 20): Series {
  const closes = bars.map((b) => b.close);
  const priorHigh = new Array<number>(bars.length).fill(NaN);
  const priorLow = new Array<number>(bars.length).fill(NaN);
  for (let i = bo; i < bars.length; i++) {
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = i - bo; j < i; j++) {
      if (bars[j]!.high > hi) hi = bars[j]!.high;
      if (bars[j]!.low < lo) lo = bars[j]!.low;
    }
    priorHigh[i] = hi;
    priorLow[i] = lo;
  }
  return {
    closes,
    ema20: emaSeries(closes, 20),
    ema50: emaSeries(closes, 50),
    rsi: rsiSeries(closes, 14),
    macdHist: macdHistSeries(closes),
    priorHigh,
    priorLow,
  };
}

/** Signal at bar i: +1 long, -1 short, 0 flat. Uses only causal series values. */
function signalAt(strategy: StrategyName, s: Series, i: number): number {
  const c = s.closes[i]!;
  const e20 = s.ema20[i]!;
  const e50 = s.ema50[i]!;
  const rsi = s.rsi[i]!;
  const hist = s.macdHist[i]!;
  switch (strategy) {
    case "trend":
      if (Number.isNaN(e50)) return 0;
      if (c > e20 && e20 > e50) return 1;
      if (c < e20 && e20 < e50) return -1;
      return 0;
    case "momentum":
      if (Number.isNaN(rsi)) return 0;
      if (hist > 0 && rsi > 50 && rsi < 72) return 1;
      if (hist < 0 && rsi < 50 && rsi > 28) return -1;
      return 0;
    case "mean-reversion":
      if (Number.isNaN(rsi)) return 0;
      if (rsi < 30) return 1;
      if (rsi > 70) return -1;
      return 0;
    case "breakout": {
      const ph = s.priorHigh[i]!;
      const pl = s.priorLow[i]!;
      if (Number.isNaN(ph)) return 0;
      if (c > ph) return 1;
      if (c < pl) return -1;
      return 0;
    }
  }
}

// ---- simulation + metrics ---------------------------------------------------

export interface BtMetrics {
  trades: number;
  winRate: number; // 0..1
  net: number; // summed trade return %
  profitFactor: number | null; // null = no losses
  expectancy: number; // avg return % per trade
  maxDrawdown: number; // worst peak-to-trough of the cumulative return %, in % points
  sharpe: number; // mean/stdev of per-trade returns (0 if <2 trades)
}

/** Simulate one strategy+SL+TP over bars[from..to). Returns per-trade returns %. */
function simulate(
  bars: Bar[],
  signal: number[],
  from: number,
  to: number,
  slPct: number,
  tpPct: number,
  costPct: number,
): number[] {
  const rets: number[] = [];
  let dir = 0;
  let entry = 0;
  let stop = 0;
  let target = 0;
  const close = (exit: number) => {
    const gross = dir === 1 ? ((exit - entry) / entry) * 100 : ((entry - exit) / entry) * 100;
    rets.push(gross - costPct);
    dir = 0;
  };
  for (let i = from; i < to; i++) {
    if (dir !== 0) {
      const hi = bars[i]!.high;
      const lo = bars[i]!.low;
      if (dir === 1) {
        if (lo <= stop) close(stop);
        else if (hi >= target) close(target);
      } else {
        if (hi >= stop) close(stop);
        else if (lo <= target) close(target);
      }
      if (dir !== 0 && signal[i] === -dir) close(bars[i]!.close); // reverse signal
    }
    if (dir === 0 && signal[i] !== 0) {
      dir = signal[i]!;
      entry = bars[i]!.close;
      stop = dir === 1 ? entry * (1 - slPct / 100) : entry * (1 + slPct / 100);
      target = dir === 1 ? entry * (1 + tpPct / 100) : entry * (1 - tpPct / 100);
    }
  }
  if (dir !== 0) close(bars[to - 1]!.close); // mark-to-market any open position
  return rets;
}

function metrics(rets: number[]): BtMetrics {
  const n = rets.length;
  if (n === 0)
    return { trades: 0, winRate: 0, net: 0, profitFactor: null, expectancy: 0, maxDrawdown: 0, sharpe: 0 };
  let wins = 0;
  let gp = 0;
  let gl = 0;
  let net = 0;
  for (const r of rets) {
    net += r;
    if (r > 0) {
      wins++;
      gp += r;
    } else gl += -r;
  }
  let eq = 0;
  let peak = 0;
  let maxDd = 0;
  for (const r of rets) {
    eq += r;
    if (eq > peak) peak = eq;
    if (peak - eq > maxDd) maxDd = peak - eq;
  }
  const mean = net / n;
  const variance = n > 1 ? rets.reduce((a, r) => a + (r - mean) ** 2, 0) / (n - 1) : 0;
  const sd = Math.sqrt(variance);
  return {
    trades: n,
    winRate: wins / n,
    net,
    profitFactor: gl > 0 ? gp / gl : gp > 0 ? null : 0,
    expectancy: mean,
    maxDrawdown: maxDd,
    sharpe: sd > 0 ? mean / sd : 0,
  };
}

// ---- walk-forward -----------------------------------------------------------

const SL_GRID = [1, 1.5, 2, 3];
const TP_GRID = [2, 3, 4, 6];

export interface WalkForwardRow {
  strategy: StrategyName;
  slPct: number;
  tpPct: number;
  inSample: BtMetrics;
  outOfSample: BtMetrics;
  robust: boolean; // OOS still positive expectancy + PF>1 with enough trades
}

export interface BacktestReport {
  epic: string;
  bars: number;
  splitIdx: number;
  rows: WalkForwardRow[]; // best-IS param per strategy, with its OOS result
}

/**
 * For each strategy, grid-search SL/TP on the in-sample slice (pick the best by
 * expectancy, requiring a few trades), then report that param's out-of-sample
 * performance. `robust` flags params that stay profitable on unseen data.
 */
export function walkForward(epic: string, bars: Bar[], splitRatio = 0.6, costPct = 0.1): BacktestReport {
  const s = buildSeries(bars);
  const splitIdx = Math.floor(bars.length * splitRatio);
  const rows: WalkForwardRow[] = [];

  for (const strategy of STRATEGIES) {
    const signal = bars.map((_, i) => signalAt(strategy, s, i));
    // Treat a null (no-loss) profit factor as +∞ for ranking / robustness.
    const pfVal = (m: BtMetrics) => (m.profitFactor === null ? Infinity : m.profitFactor);
    let best: { slPct: number; tpPct: number; is: BtMetrics } | null = null;
    for (const slPct of SL_GRID) {
      for (const tpPct of TP_GRID) {
        if (tpPct <= slPct) continue;
        const is = metrics(simulate(bars, signal, 0, splitIdx, slPct, tpPct, costPct));
        if (is.trades < 5) continue;
        // Rank by expectancy, tie-break by profit factor.
        if (
          !best ||
          is.expectancy > best.is.expectancy ||
          (is.expectancy === best.is.expectancy && pfVal(is) > pfVal(best.is))
        ) {
          best = { slPct, tpPct, is };
        }
      }
    }
    if (!best) continue;
    const oos = metrics(simulate(bars, signal, splitIdx, bars.length, best.slPct, best.tpPct, costPct));
    rows.push({
      strategy,
      slPct: best.slPct,
      tpPct: best.tpPct,
      inSample: best.is,
      outOfSample: oos,
      robust: oos.trades >= 3 && oos.expectancy > 0 && pfVal(oos) > 1,
    });
  }
  return { epic, bars: bars.length, splitIdx, rows };
}

// ---- rendering --------------------------------------------------------------

const sign = (n: number) => (n >= 0 ? "+" : "");
const pf = (v: number | null) => (v === null ? "∞" : v.toFixed(2));
const m1 = (m: BtMetrics) =>
  `n=${m.trades} 胜率${Math.round(m.winRate * 100)}% 期望${sign(m.expectancy)}${m.expectancy.toFixed(2)}% 盈亏比${pf(m.profitFactor)} 回撤${m.maxDrawdown.toFixed(1)}% 夏普${m.sharpe.toFixed(2)}`;

export function renderBacktest(reports: BacktestReport[]): string {
  const lines = ["📼 确定性策略回测（walk-forward，样本外验证）", ""];
  lines.push("说明：在样本内(IS)网格选最优 SL/TP，报告其样本外(OOS)表现；只有 OOS 仍盈利的才算稳健(✅)。");
  lines.push("（新闻/AI 判断层无法被忠实回测，此处仅回测纯技术策略组件。）");
  for (const rep of reports) {
    lines.push("", `— ${rep.epic}（${rep.bars} 根K线，IS/OOS 切分点 ${rep.splitIdx}）—`);
    if (rep.rows.length === 0) {
      lines.push("  样本不足，无有效结果。");
      continue;
    }
    for (const r of rep.rows) {
      lines.push(
        `${r.robust ? "✅" : "❌"} ${r.strategy}  SL ${r.slPct}% / TP ${r.tpPct}%`,
        `    IS ：${m1(r.inSample)}`,
        `    OOS：${m1(r.outOfSample)}`,
      );
    }
    const robust = rep.rows.filter((r) => r.robust);
    lines.push(
      robust.length
        ? `  ➜ 稳健策略：${robust.map((r) => `${r.strategy}(SL${r.slPct}/TP${r.tpPct})`).join("、")}`
        : "  ➜ 无样本外稳健策略——该品种当前不宜用固定技术规则重仓。",
    );
  }
  lines.push("", "提醒：回测有效≠实盘必赚；含点差/滑点/未来结构变化的风险。仅作选参参考。");
  return lines.join("\n");
}
