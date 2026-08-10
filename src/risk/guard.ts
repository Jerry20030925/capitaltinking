import { config } from "../config.js";
import type { Account, OpenPosition, MarketSnapshot } from "../capital/client.js";
import type { TradeDecision, Setup } from "../brain/deepseek.js";
import type { DevilVerdict } from "../brain/devil.js";

export interface ApprovedTrade {
  epic: string;
  direction: "BUY" | "SELL";
  size: number;
  entry: number; // expected fill price (offer for BUY, bid for SELL)
  stopLevel: number;
  profitLevel: number;
  stopDistance: number; // for trailing stop
  profitDistance: number;
  riskAmount: number; // loss if the stop is hit (the trade's 1R, in account currency)
  reasoning: string;
  confidence: number;
  setup?: Setup;
  // Devil's Advocate judgment carried onto the trade for the ledger / A/B.
  counterConfidence?: number;
  devilVerdict?: DevilVerdict;
  wouldVeto?: boolean;
  // Second-brain (Qwen) ensemble judgment, for the ledger / A/B.
  secondAction?: "BUY" | "SELL" | "CLOSE" | "HOLD";
  secondConfidence?: number;
  secondAgree?: boolean;
}

export interface RiskResult {
  approved: ApprovedTrade[];
  // entry/upl captured at decision time so the audit trail records the outcome.
  closes: { dealId: string; epic: string; reasoning: string; entry: number; upl: number }[];
  rejected: { epic: string; reason: string }[];
}

/**
 * Hard, non-negotiable risk gate. The AI can only SUGGEST; this function
 * decides what is actually allowed. Every rule here protects the account.
 */
/** Trading-halt signal from the circuit breakers. When active, no new opens. */
export interface Halt {
  active: boolean;
  reason: string;
}

export function applyRisk(
  decisions: TradeDecision[],
  account: Account,
  positions: OpenPosition[],
  markets: Map<string, MarketSnapshot>,
  halt: Halt = { active: false, reason: "" },
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
      if (pos)
        result.closes.push({
          dealId: pos.dealId,
          epic: d.epic,
          reasoning: d.reasoning,
          entry: pos.level,
          upl: pos.upl,
        });
      else result.rejected.push({ epic: d.epic, reason: "想平仓但当前没有该品种持仓" });
      continue;
    }

    // BUY / SELL: run the full gauntlet.
    // Circuit breaker: when a loss/drawdown limit is hit, no new positions.
    if (halt.active) {
      result.rejected.push({ epic: d.epic, reason: `风控熔断：${halt.reason}` });
      continue;
    }

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

    // Risk-to-stop position sizing: size so the loss IF the stop is hit is
    // capped at RISK_PER_TRADE_PCT of equity (scaled down for lower conviction,
    // never above the cap). size = riskBudget / (contractSize × stopDistance).
    // This makes every trade risk ~1R and bounds tail loss by construction.
    const equity = account.balance;
    let size = r.maxPositionSize;
    if (r.dynamicSizing) {
      const span = Math.max(0.0001, 1 - r.minConfidence);
      const convFactor =
        0.5 + 0.5 * Math.min(1, Math.max(0, (d.confidence - r.minConfidence) / span));
      const budget = equity * (r.riskPerTradePct / 100) * convFactor;
      const riskPerUnit = market.contractSize * slDist;
      let raw = riskPerUnit > 0 ? budget / riskPerUnit : market.minDealSize;

      // Upper bounds first: instrument max (if known) and the anti-runaway ceiling.
      if (market.maxDealSize > 0) raw = Math.min(raw, market.maxDealSize);
      raw = Math.min(raw, r.maxPositionSize);
      // Round down to the instrument's step, then honour its minimum LAST so an
      // instrument whose minimum exceeds the ceiling (e.g. FX = 100) still trades.
      size = roundToStep(raw, market.minDealSize);
      if (size < market.minDealSize) size = market.minDealSize;
    }

    // Actual risk at the chosen size (post-rounding / min-lot floor).
    const riskAmount = round(size * market.contractSize * slDist);

    // Hard per-trade cap: if the smallest tradeable size still risks more than
    // RISK_PER_TRADE_PCT of equity, REFUSE — never silently take oversized risk.
    const maxRisk = equity * (r.riskPerTradePct / 100);
    if (riskAmount > maxRisk * 1.001) {
      result.rejected.push({
        epic: d.epic,
        reason: `最小手数风险 ${riskAmount} 超过单笔上限 ${round(maxRisk)}（${r.riskPerTradePct}% 权益）`,
      });
      continue;
    }

    // Margin safety: don't open a position we can't cover.
    const requiredMargin = size * market.contractSize * entry * market.marginFactor;
    if (requiredMargin > account.available) {
      result.rejected.push({
        epic: d.epic,
        reason: `所需保证金 ${round(requiredMargin)} 超过可用 ${round(account.available)}`,
      });
      continue;
    }

    result.approved.push({
      epic: d.epic,
      direction,
      size,
      entry: round(entry),
      stopLevel: round(stopLevel),
      profitLevel: round(profitLevel),
      stopDistance: round(slDist),
      profitDistance: round(tpDist),
      riskAmount,
      reasoning: d.reasoning,
      confidence: d.confidence,
      setup: d.setup,
      counterConfidence: d.counterConfidence,
      devilVerdict: d.devilVerdict,
      wouldVeto: d.wouldVeto,
      secondAction: d.secondAction,
      secondConfidence: d.secondConfidence,
      secondAgree: d.secondAgree,
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
