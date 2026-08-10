import { config } from "../config.js";
import { loadTrades, type ClosedTrade } from "./trades.js";

/**
 * Turn the round-trip trade history into a "which setups actually pay" report,
 * grouped by market regime, setup, instrument, direction and confidence band,
 * plus a Devil's Advocate A/B: does dropping the trades the critic vetoed
 * actually improve win-rate / expectancy / profit factor / drawdown?
 *
 * Only trades that carry a realised P/L count toward the metrics; legacy trades
 * without a recorded outcome are surfaced separately.
 */

const sign = (n: number) => (n >= 0 ? "+" : "");
const pct = (x: number) => `${Math.round(x * 100)}%`;

export interface Metrics {
  n: number; // scored trades (with realised P/L)
  wins: number;
  winRate: number; // 0..1
  total: number; // summed realised P/L
  expectancy: number; // total / n (avg P&L per trade)
  expectancyR: number | null; // avg R-multiple (pnl / riskAmount); null if unknown
  profitFactor: number | null; // grossProfit / grossLoss; null = no losing trades
  maxDrawdown: number; // peak-to-trough decline on the equity curve, currency
}

export function metrics(trades: ClosedTrade[]): Metrics {
  const scored = trades.filter((t) => typeof t.pnl === "number") as (ClosedTrade & {
    pnl: number;
  })[];
  const n = scored.length;

  let grossProfit = 0;
  let grossLoss = 0;
  let wins = 0;
  let total = 0;
  let rSum = 0;
  let rN = 0;
  for (const t of scored) {
    total += t.pnl;
    if (t.pnl > 0) {
      grossProfit += t.pnl;
      wins++;
    } else {
      grossLoss += -t.pnl;
    }
    const risk = t.open.riskAmount;
    if (typeof risk === "number" && risk > 0) {
      rSum += t.pnl / risk;
      rN++;
    }
  }

  // Max drawdown over the equity curve, trades ordered by close time.
  const ordered = [...scored].sort(
    (a, b) => new Date(a.close.at).getTime() - new Date(b.close.at).getTime(),
  );
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const t of ordered) {
    equity += t.pnl;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  return {
    n,
    wins,
    winRate: n ? wins / n : 0,
    total,
    expectancy: n ? total / n : 0,
    expectancyR: rN ? rSum / rN : null,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? null : 0,
    maxDrawdown,
  };
}

function fmtPF(pf: number | null): string {
  if (pf === null) return "∞";
  return pf.toFixed(2);
}

function metricsLine(m: Metrics): string {
  if (m.n === 0) return "n=0（无有效样本）";
  const r =
    m.expectancyR !== null ? `　R期望${sign(m.expectancyR)}${m.expectancyR.toFixed(2)}R` : "";
  return `n=${m.n}　胜率${pct(m.winRate)}　期望${sign(m.expectancy)}${m.expectancy.toFixed(1)}${r}　盈亏比${fmtPF(m.profitFactor)}　总${sign(m.total)}${m.total.toFixed(1)}　最大回撤${m.maxDrawdown.toFixed(1)}`;
}

// --- grouped win-rate (regime / setup / instrument / …) ---

interface Bucket {
  key: string;
  n: number;
  scored: number;
  wins: number;
  total: number;
}

function groupBy(trades: ClosedTrade[], keyOf: (t: ClosedTrade) => string): Bucket[] {
  const map = new Map<string, Bucket>();
  for (const t of trades) {
    const key = keyOf(t);
    let b = map.get(key);
    if (!b) {
      b = { key, n: 0, scored: 0, wins: 0, total: 0 };
      map.set(key, b);
    }
    b.n++;
    if (typeof t.pnl === "number") {
      b.scored++;
      b.total += t.pnl;
      if (t.pnl > 0) b.wins++;
    }
  }
  return [...map.values()].sort((a, b) => b.n - a.n);
}

/**
 * Learning-trend signal: is the brain actually getting better as it accumulates
 * lessons? Split the scored trades chronologically in half and compare the two
 * halves' expectancy / win-rate. Returns "" until there are enough samples.
 */
export interface LearningTrend {
  hasData: boolean; // enough samples (≥8) to split into halves
  early: Metrics;
  recent: Metrics;
}

/** Split scored trades chronologically in half to gauge if the brain improves. */
export function learningTrend(closed: ClosedTrade[]): LearningTrend {
  const scored = closed
    .filter((t) => typeof t.pnl === "number")
    .sort((a, b) => new Date(a.close.at).getTime() - new Date(b.close.at).getTime());
  if (scored.length < 8) return { hasData: false, early: metrics([]), recent: metrics([]) };
  const mid = Math.floor(scored.length / 2);
  return { hasData: true, early: metrics(scored.slice(0, mid)), recent: metrics(scored.slice(mid)) };
}

function learningTrendLine(closed: ClosedTrade[]): string {
  const t = learningTrend(closed);
  if (!t.hasData) return "";
  const { early, recent } = t;
  const d = recent.expectancy - early.expectancy;
  const arrow = d > 0.01 ? "↑ 在变好" : d < -0.01 ? "↓ 在变差" : "→ 基本持平";
  return `学习趋势：早期(${early.n}笔)期望${sign(early.expectancy)}${early.expectancy.toFixed(1)}/胜率${pct(
    early.winRate,
  )} → 近期(${recent.n}笔)期望${sign(recent.expectancy)}${recent.expectancy.toFixed(1)}/胜率${pct(
    recent.winRate,
  )}（${arrow}）`;
}

function confidenceBand(c: number): string {
  if (c >= 0.9) return "≥0.90";
  if (c >= 0.8) return "0.80–0.89";
  if (c >= 0.7) return "0.70–0.79";
  return "<0.70";
}

function renderGroup(title: string, buckets: Bucket[]): string[] {
  if (buckets.length === 0) return [];
  const lines = [``, `${title}：`];
  for (const b of buckets) {
    if (b.scored === 0) {
      lines.push(`• ${b.key}　n=${b.n}（暂无盈亏记录）`);
      continue;
    }
    const wr = pct(b.wins / b.scored);
    const avg = b.total / b.scored;
    lines.push(
      `• ${b.key}　n=${b.scored}　胜率${wr}　总${sign(b.total)}${b.total.toFixed(1)}　均${sign(avg)}${avg.toFixed(1)}`,
    );
  }
  return lines;
}

/**
 * Compact, prompt-sized track record fed BACK to the strategy brain so it learns
 * which setups/regimes actually pay and leans into them (and away from losers).
 * Returns "" until there's enough scored history to be worth trusting.
 */
export function buildPerfHint(closed: ClosedTrade[]): string {
  const scored = closed.filter((t) => typeof t.pnl === "number");
  if (scored.length < 5) return ""; // too little to learn from — don't bias the brain
  const o = metrics(closed);
  const lines: string[] = [
    `总体 n=${o.n} 胜率${pct(o.winRate)} 期望${sign(o.expectancy)}${o.expectancy.toFixed(1)}${
      o.expectancyR !== null ? `(${sign(o.expectancyR)}${o.expectancyR.toFixed(2)}R)` : ""
    } 盈亏比${fmtPF(o.profitFactor)}`,
  ];
  const trend = learningTrendLine(closed);
  if (trend) lines.push(trend);
  const summarise = (label: string, buckets: Bucket[]) => {
    const good = buckets.filter((b) => b.scored >= 3);
    if (!good.length) return;
    const parts = good.map((b) => {
      const avg = b.total / b.scored;
      return `${b.key} 胜率${pct(b.wins / b.scored)}/均${sign(avg)}${avg.toFixed(1)}(n=${b.scored})`;
    });
    lines.push(`${label}：${parts.join("；")}`);
  };
  summarise("按打法", groupBy(closed, (t) => t.open.setup ?? "未标注"));
  summarise("按状态", groupBy(closed, (t) => t.open.regime ?? "未标注"));
  return lines.join("\n");
}

/**
 * Realised metrics grouped by SETUP — the input to the Expected-Value gate. Each
 * setup's `expectancyR` is its average R-multiple (= win%×avgWinR − loss%×avgLossR,
 * costs already reflected in realised P/L), i.e. its expected value per unit risk.
 */
export function expectancyBySetup(closed: ClosedTrade[]): Map<string, Metrics> {
  const bySetup = new Map<string, ClosedTrade[]>();
  for (const t of closed) {
    const k = t.open.setup ?? "未标注";
    let arr = bySetup.get(k);
    if (!arr) bySetup.set(k, (arr = []));
    arr.push(t);
  }
  const out = new Map<string, Metrics>();
  for (const [k, ts] of bySetup) out.set(k, metrics(ts));
  return out;
}

/** Build the Chinese analytics report. Pure over the audit log — no live calls. */
export async function buildStatsReport(): Promise<string> {
  const { closed, stillOpen } = await loadTrades();
  const tag = config.mode === "live" ? "真钱 💰" : "模拟账户";

  if (closed.length === 0) {
    return [
      `📈 交易复盘统计 [${tag}]`,
      ``,
      `暂无已平仓交易可供统计（当前持仓 ${stillOpen.length} 笔）。`,
      `系统会在每次开仓/平仓时记录市场状态、打法与反方判断，积累后再看哪种最赚钱、反方否决是否有效。`,
    ].join("\n");
  }

  const scored = closed.filter((t) => typeof t.pnl === "number");
  const overall = metrics(closed);
  const avgHoldH = closed.reduce((s, t) => s + t.holdMs, 0) / closed.length / 3_600_000;

  const lines = [
    `📈 交易复盘统计 [${tag}]`,
    ``,
    `已平仓 ${closed.length} 笔（其中 ${scored.length} 笔有盈亏记录），当前持仓 ${stillOpen.length} 笔`,
  ];
  if (scored.length) {
    lines.push(`总体：${metricsLine(overall)}`, `平均持仓时长：${avgHoldH.toFixed(1)} 小时`);
    const trend = learningTrendLine(closed);
    if (trend) lines.push(trend);
  }
  if (scored.length < 20) {
    lines.push(
      `⚠️ 样本仅 ${scored.length} 笔，远未到统计显著（建议 ≥30 笔再下结论）。当前仅作观察。`,
    );
  }

  // --- Devil's Advocate A/B: did vetoing help? ---
  const critiqued = closed.filter((t) => t.open.wouldVeto !== undefined);
  if (critiqued.length) {
    const upheld = critiqued.filter((t) => !t.open.wouldVeto); // "if veto enforced"
    const vetoed = critiqued.filter((t) => t.open.wouldVeto); // the critic's shortlist
    lines.push(
      ``,
      `😈 反方否决 A/B（观察模式：被否决的也照常开仓，用于对照）：`,
      `  全部开仓（无否决）　${metricsLine(metrics(critiqued))}`,
      `  若执行否决（剔除被否决）${metricsLine(metrics(upheld))}`,
      `  被否决的那批交易　　${metricsLine(metrics(vetoed))}`,
    );
    const a = metrics(critiqued);
    const b = metrics(upheld);
    if (a.n >= 20 && b.n >= 10) {
      const better =
        b.expectancy > a.expectancy && (b.profitFactor ?? 99) >= (a.profitFactor ?? 0);
      lines.push(
        better
          ? `  ➜ 初步迹象：执行否决后期望与盈亏比更好。样本够大且稳定后，可切到 DEVIL_MODE=enforce，再考虑升级 5-brain。`
          : `  ➜ 初步迹象：否决暂未带来改善。继续观察，勿据此升级。`,
      );
    } else {
      lines.push(`  ➜ 样本不足以判断否决是否有效，继续在 observe 模式积累。`);
    }
  }

  lines.push(
    ...renderGroup("按市场状态 (regime)", groupBy(closed, (t) => t.open.regime ?? "未标注")),
    ...renderGroup("按打法 (setup)", groupBy(closed, (t) => t.open.setup ?? "未标注")),
    ...renderGroup("按品种", groupBy(closed, (t) => t.open.epic)),
    ...renderGroup(
      "按方向",
      groupBy(closed, (t) => (t.open.direction === "BUY" ? "做多" : "做空")),
    ),
    ...renderGroup("按信心档", groupBy(closed, (t) => confidenceBand(t.open.confidence))),
  );

  // Two-brain (DeepSeek + Qwen) agreement A/B, if the second brain ran.
  if (closed.some((t) => t.open.secondAgree !== undefined)) {
    lines.push(
      ...renderGroup(
        "按双脑一致性 (DeepSeek+Qwen)",
        groupBy(
          closed.filter((t) => t.open.secondAgree !== undefined),
          (t) => (t.open.secondAgree ? "两脑一致" : "两脑分歧"),
        ),
      ),
    );
  }

  lines.push(``, `提醒：模拟账户的胜率无法直接复制到真钱，重点看样本量、一致性与盈亏比。`);
  return lines.join("\n");
}
