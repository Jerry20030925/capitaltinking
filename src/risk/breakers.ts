import { config } from "../config.js";
import type { ClosedTrade } from "../analytics/trades.js";

/**
 * Circuit breakers — the "how much am I willing to lose" limits. Computed from
 * realised P/L in the committed ledger. When any limit is breached the risk
 * engine halts ALL new opens (closes are still allowed, since they reduce risk).
 * This is deterministic program logic; the AI can never override it.
 *
 * Loss %s are measured against current balance; drawdown is peak-to-current on
 * the reconstructed realised-equity curve (unrealised P/L of open trades is not
 * counted — this is a realised-loss guard).
 */

export interface BreakerStatus {
  active: boolean;
  reason: string;
  dailyPnl: number;
  weeklyPnl: number;
  dailyLossPct: number;
  weeklyLossPct: number;
  drawdownPct: number;
  hwm: number; // high-water-mark equity
  consecutiveLosses: number; // trailing run of losing trades (resets on a win)
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function checkCircuitBreakers(closed: ClosedTrade[], balance: number): BreakerStatus {
  const scored = closed.filter((t) => typeof t.pnl === "number") as (ClosedTrade & {
    pnl: number;
  })[];

  const now = Date.now();
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const dayStart = midnight.getTime();
  const weekAgo = now - 7 * 24 * 3_600_000;

  let dailyPnl = 0;
  let weeklyPnl = 0;
  let total = 0;
  for (const t of scored) {
    const ct = new Date(t.close.at).getTime();
    total += t.pnl;
    if (ct >= dayStart) dailyPnl += t.pnl;
    if (ct >= weekAgo) weeklyPnl += t.pnl;
  }

  // Reconstruct the realised-equity curve anchored to the CURRENT balance:
  // equity starts at (balance - total) before the first recorded trade and ends
  // at balance. Track the high-water mark to get current drawdown.
  const ordered = [...scored].sort(
    (a, b) => new Date(a.close.at).getTime() - new Date(b.close.at).getTime(),
  );
  let eq = balance - total;
  let peak = eq;
  for (const t of ordered) {
    eq += t.pnl;
    if (eq > peak) peak = eq;
  }
  peak = Math.max(peak, balance);
  const drawdownPct = peak > 0 ? ((peak - balance) / peak) * 100 : 0;

  const dailyLossPct = balance > 0 && dailyPnl < 0 ? (-dailyPnl / balance) * 100 : 0;
  const weeklyLossPct = balance > 0 && weeklyPnl < 0 ? (-weeklyPnl / balance) * 100 : 0;

  // Cold-streak guard: count the trailing run of losing trades (most recent first),
  // stopping at the first non-loss (a win or scratch resets the streak).
  let consecutiveLosses = 0;
  for (let i = ordered.length - 1; i >= 0; i--) {
    if (ordered[i]!.pnl < 0) consecutiveLosses++;
    else break;
  }

  const reasons: string[] = [];
  if (dailyLossPct >= config.risk.maxDailyLossPct) {
    reasons.push(`当日亏损 ${round2(dailyLossPct)}% ≥ ${config.risk.maxDailyLossPct}%`);
  }
  if (weeklyLossPct >= config.risk.maxWeeklyLossPct) {
    reasons.push(`近7日亏损 ${round2(weeklyLossPct)}% ≥ ${config.risk.maxWeeklyLossPct}%`);
  }
  if (drawdownPct >= config.risk.maxDrawdownPct) {
    reasons.push(`账户回撤 ${round2(drawdownPct)}% ≥ ${config.risk.maxDrawdownPct}%`);
  }
  if (
    config.risk.maxConsecutiveLosses > 0 &&
    consecutiveLosses >= config.risk.maxConsecutiveLosses
  ) {
    reasons.push(`连续亏损 ${consecutiveLosses} 笔 ≥ ${config.risk.maxConsecutiveLosses}（冷静期）`);
  }

  return {
    active: reasons.length > 0,
    reason: reasons.join("；"),
    dailyPnl: round2(dailyPnl),
    weeklyPnl: round2(weeklyPnl),
    dailyLossPct: round2(dailyLossPct),
    weeklyLossPct: round2(weeklyLossPct),
    drawdownPct: round2(drawdownPct),
    hwm: round2(peak),
    consecutiveLosses,
  };
}
