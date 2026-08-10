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
  consecutiveLosses = 0,
  setupEv: Map<string, { n: number; evR: number | null }> = new Map(),
): RiskResult {
  const result: RiskResult = { approved: [], closes: [], rejected: [] };
  const r = config.risk;

  // Cold-streak position multiplier: shrink size as losses stack up (2→×0.7,
  // 3→×0.5); the ≥4 case is already halted by the circuit breaker. Protecting
  // compounding — one big drawdown erases dozens of wins.
  const streakMultiplier = consecutiveLosses >= 3 ? 0.5 : consecutiveLosses >= 2 ? 0.7 : 1;

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
  // Available margin remaining THIS cycle — decremented as we approve opens so
  // several capital-deployed trades in one cycle don't collectively over-commit.
  let availableLeft = account.available;

  // Fund the MOST PROMISING opportunities first: process CLOSEs (risk-down)
  // first, then BUY/SELL sorted by confidence DESC, so when margin or the
  // max-positions cap runs out this cycle it's the weakest ideas that miss out —
  // the remaining available funds always chase the highest-conviction trades.
  const ordered = [...decisions].sort((a, b) => {
    const rank = (d: TradeDecision) =>
      d.action === "CLOSE" ? 0 : d.action === "BUY" || d.action === "SELL" ? 1 : 2;
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    return ra === 1 ? b.confidence - a.confidence : 0;
  });

  for (const d of ordered) {
    if (d.action === "HOLD") continue;

    // Handle closes first — always allowed (reducing risk).

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

    // Quality gate: composite opportunity score (falls back to confidence×100).
    // Below the floor the setup has no real edge → don't trade it at all.
    const signalScore = d.score ?? d.confidence * 100;
    if (signalScore < r.minSignalScore) {
      result.rejected.push({
        epic: d.epic,
        reason: `综合评分 ${round(signalScore)} 低于门槛 ${r.minSignalScore}（无统计优势，不交易）`,
      });
      continue;
    }

    // Expected-Value gate: once a setup has enough realised trades, refuse it if
    // its measured expectancy (avg R) has gone negative — stop feeding a losing
    // playbook no matter how confident the AI is. Thin samples are never gated.
    if (d.setup) {
      const ev = setupEv.get(d.setup);
      if (ev && ev.evR !== null && ev.n >= r.minEvSample && ev.evR < r.minEvR) {
        result.rejected.push({
          epic: d.epic,
          reason: `打法「${d.setup}」近${ev.n}笔实盘期望 ${ev.evR.toFixed(2)}R 为负（无统计优势），暂停该打法`,
        });
        continue;
      }
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

    // Stop-loss / take-profit levels. Prefer the brain's per-trade, volatility-
    // aware distances (better risk:reward); fall back to the config percentages.
    const slPct = d.stopLossPct ?? r.stopLossPct;
    const tpPct = d.takeProfitPct ?? r.takeProfitPct;
    const slDist = entry * (slPct / 100);
    const tpDist = entry * (tpPct / 100);
    const stopLevel = direction === "BUY" ? entry - slDist : entry + slDist;
    const profitLevel = direction === "BUY" ? entry + tpDist : entry - tpDist;

    // Signal strength in 0..1 across the tradeable SCORE band (minScore→100), so
    // position size tracks genuine opportunity quality, not just raw confidence.
    const equity = account.balance;
    const span = Math.max(0.0001, 100 - r.minSignalScore);
    const strength = Math.min(1, Math.max(0, (signalScore - r.minSignalScore) / span));

    // Position sizing.
    let size: number;
    if (r.sizingMode === "capital") {
      // DYNAMIC RISK-BASED sizing — the profit engine done right: RISK, not capital
      // %, is the control. Risk-per-trade scales with signal strength between the
      // target band (weak edge → small risk, strong edge → larger), hard-capped at
      // the absolute ceiling. size = riskBudget ÷ stopDistance, so a TIGHTER stop
      // earns a BIGGER position at the SAME risk (better capital efficiency).
      // Capital % only caps how much MARGIN may be committed (a utilisation ceiling,
      // never a loss limit). This maximises expected-return-per-unit-risk.
      const riskPct = Math.min(
        r.maxTradeLossPct,
        (r.targetRiskMinPct + (r.targetRiskMaxPct - r.targetRiskMinPct) * strength) *
          streakMultiplier,
      );
      const riskBudget = equity * (riskPct / 100);
      const riskPerUnit = market.contractSize * slDist;
      let raw = riskPerUnit > 0 ? riskBudget / riskPerUnit : market.minDealSize;
      // Capital-utilisation ceiling: committed margin ≤ capitalDeployPct% of what's
      // still available this cycle.
      const marginPerUnit = market.contractSize * entry * market.marginFactor;
      if (marginPerUnit > 0) {
        const maxUnitsByCapital = (availableLeft * (r.capitalDeployPct / 100)) / marginPerUnit;
        raw = Math.min(raw, maxUnitsByCapital);
      }
      if (market.maxDealSize > 0) raw = Math.min(raw, market.maxDealSize);
      if (r.maxPositionSize > 0) raw = Math.min(raw, r.maxPositionSize);
      size = roundToStep(raw, market.minDealSize);
      if (size < market.minDealSize) size = market.minDealSize;
    } else if (r.dynamicSizing) {
      // Simple fixed risk-to-stop (SIZING_MODE=risk): loss-if-stopped ≈ RISK_PER_TRADE_PCT.
      const budget = equity * (r.riskPerTradePct / 100) * (0.7 + 0.3 * strength) * streakMultiplier;
      const riskPerUnit = market.contractSize * slDist;
      let raw = riskPerUnit > 0 ? budget / riskPerUnit : market.minDealSize;
      if (market.maxDealSize > 0) raw = Math.min(raw, market.maxDealSize);
      if (r.maxPositionSize > 0) raw = Math.min(raw, r.maxPositionSize);
      size = roundToStep(raw, market.minDealSize);
      if (size < market.minDealSize) size = market.minDealSize;
    } else {
      size = r.maxPositionSize > 0 ? r.maxPositionSize : market.minDealSize;
    }

    // SAFETY CEILING (kept as a cap): whatever the sizer picked, never let a single
    // stop-out lose more than MAX_TRADE_LOSS_PCT of equity. Scale the position DOWN
    // to fit; only REFUSE if even the min lot breaches the ceiling.
    const maxRisk = equity * (r.maxTradeLossPct / 100);
    let riskAmount = round(size * market.contractSize * slDist);
    if (riskAmount > maxRisk * 1.001 && slDist > 0) {
      const capped = maxRisk / (market.contractSize * slDist);
      size = roundToStep(capped, market.minDealSize);
      if (size < market.minDealSize) {
        result.rejected.push({
          epic: d.epic,
          reason: `最小手数风险 ${round(market.minDealSize * market.contractSize * slDist)} 超过单笔上限 ${round(maxRisk)}（${r.maxTradeLossPct}% 权益）`,
        });
        continue;
      }
      riskAmount = round(size * market.contractSize * slDist);
    }

    // Margin safety: don't open a position we can't cover (uses remaining margin).
    const requiredMargin = size * market.contractSize * entry * market.marginFactor;
    if (requiredMargin > availableLeft) {
      result.rejected.push({
        epic: d.epic,
        reason: `所需保证金 ${round(requiredMargin)} 超过可用 ${round(availableLeft)}`,
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
    availableLeft = round(availableLeft - requiredMargin);
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
