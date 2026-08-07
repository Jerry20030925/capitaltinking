import { config } from "../config.js";
import type { Account, OpenPosition, MarketSnapshot } from "../capital/client.js";
import type { TradeDecision } from "../brain/deepseek.js";

export interface ApprovedTrade {
  epic: string;
  direction: "BUY" | "SELL";
  size: number;
  stopLevel: number;
  profitLevel: number;
  stopDistance: number; // for trailing stop
  profitDistance: number;
  reasoning: string;
  confidence: number;
}

export interface RiskResult {
  approved: ApprovedTrade[];
  closes: { dealId: string; epic: string; reasoning: string }[];
  rejected: { epic: string; reason: string }[];
}

/**
 * Hard, non-negotiable risk gate. The AI can only SUGGEST; this function
 * decides what is actually allowed. Every rule here protects the account.
 */
export function applyRisk(
  decisions: TradeDecision[],
  account: Account,
  positions: OpenPosition[],
  markets: Map<string, MarketSnapshot>,
): RiskResult {
  const result: RiskResult = { approved: [], closes: [], rejected: [] };
  const r = config.risk;

  // Global guard: refuse to trade a nearly-empty account.
  if (account.balance < r.minAccountBalance) {
    for (const d of decisions) {
      result.rejected.push({
        epic: d.epic,
        reason: `账户余额 ${account.balance} 低于最低门槛 ${r.minAccountBalance}`,
      });
    }
    return result;
  }

  let projectedOpen = positions.length;

  for (const d of decisions) {
    if (d.action === "HOLD") continue;

    // Handle closes first — always allowed (reducing risk).
    if (d.action === "CLOSE") {
      const pos = positions.find((p) => p.epic === d.epic);
      if (pos) result.closes.push({ dealId: pos.dealId, epic: d.epic, reasoning: d.reasoning });
      else result.rejected.push({ epic: d.epic, reason: "想平仓但当前没有该品种持仓" });
      continue;
    }

    // BUY / SELL: run the full gauntlet.
    if (d.confidence < r.minConfidence) {
      result.rejected.push({
        epic: d.epic,
        reason: `信心 ${d.confidence} 低于门槛 ${r.minConfidence}`,
      });
      continue;
    }

    if (positions.some((p) => p.epic === d.epic)) {
      result.rejected.push({ epic: d.epic, reason: "该品种已有持仓，不重复开仓" });
      continue;
    }

    if (projectedOpen >= r.maxOpenPositions) {
      result.rejected.push({
        epic: d.epic,
        reason: `已达最大持仓数 ${r.maxOpenPositions}`,
      });
      continue;
    }

    const market = markets.get(d.epic);
    if (!market || market.marketStatus !== "TRADEABLE") {
      result.rejected.push({
        epic: d.epic,
        reason: `市场当前不可交易（状态：${market?.marketStatus ?? "未知"}）`,
      });
      continue;
    }

    const direction = d.action; // BUY | SELL
    const entry = direction === "BUY" ? market.offer : market.bid;
    if (!entry || entry <= 0) {
      result.rejected.push({ epic: d.epic, reason: "无有效价格" });
      continue;
    }

    // Stop-loss / take-profit levels derived from configured percentages.
    const slDist = entry * (r.stopLossPct / 100);
    const tpDist = entry * (r.takeProfitPct / 100);
    const stopLevel = direction === "BUY" ? entry - slDist : entry + slDist;
    const profitLevel = direction === "BUY" ? entry + tpDist : entry - tpDist;

    // Balance + leverage based position sizing.
    // Commit EXPOSURE_PER_TRADE_PCT of available balance as margin, scaled by
    // conviction, then clamp to the instrument's min/max and the safety ceiling.
    let size = r.maxPositionSize;
    if (r.dynamicSizing) {
      const span = Math.max(0.0001, 1 - r.minConfidence);
      const convFactor =
        0.5 + 0.5 * Math.min(1, Math.max(0, (d.confidence - r.minConfidence) / span));

      const marginPerUnit = entry * market.marginFactor * market.contractSize;
      const targetMargin = account.available * (r.exposurePerTradePct / 100);
      let raw = marginPerUnit > 0 ? (targetMargin / marginPerUnit) * convFactor : market.minDealSize;

      // Upper bounds first: instrument max (if known) and the anti-runaway ceiling.
      if (market.maxDealSize > 0) raw = Math.min(raw, market.maxDealSize);
      raw = Math.min(raw, r.maxPositionSize);
      // Round down to the instrument's step, then honour its minimum LAST so an
      // instrument whose minimum exceeds the ceiling (e.g. FX = 100) still trades.
      size = roundToStep(raw, market.minDealSize);
      if (size < market.minDealSize) size = market.minDealSize;
    }

    result.approved.push({
      epic: d.epic,
      direction,
      size,
      stopLevel: round(stopLevel),
      profitLevel: round(profitLevel),
      stopDistance: round(slDist),
      profitDistance: round(tpDist),
      reasoning: d.reasoning,
      confidence: d.confidence,
    });
    projectedOpen++;
  }

  return result;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Round a size down to a multiple of the instrument's step (min deal size). */
function roundToStep(value: number, step: number): number {
  if (step <= 0) return round(value);
  const decimals = Math.min(4, (String(step).split(".")[1] ?? "").length);
  const snapped = Math.floor(value / step) * step;
  return Number(snapped.toFixed(decimals));
}
