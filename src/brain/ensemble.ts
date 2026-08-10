import type { BrainOutput, TradeDecision } from "./deepseek.js";

/**
 * Combine two independent Chief Traders (DeepSeek + Qwen) into an ensemble.
 * Genuine model diversity: agreement = higher conviction, disagreement = caution.
 *
 *   - "observe": annotate the primary's decisions with the second brain's call +
 *     whether they agree, but DON'T change behaviour (trade the primary's calls).
 *     Lets us A/B — over time — whether "both agreed" trades outperform.
 *   - "enforce": a BUY/SELL survives only if BOTH brains pick the same direction;
 *     otherwise HOLD. On agreement, confidence is the (conservative) minimum.
 *   - "either" (OR-logic): trade if EITHER brain sees an opportunity — you don't
 *     need both to agree. When only one wants in, take its call; when both want
 *     in and agree, use the HIGHER confidence (shared conviction); when they want
 *     opposite directions, take the more confident side. A CLOSE from either brain
 *     always wins (reducing risk is never blocked). This is the most aggressive
 *     mode — more trades, more chances to profit.
 */

type Action = TradeDecision["action"];

export interface EnsembleResult {
  decisions: TradeDecision[]; // annotated (and, in enforce/either mode, gated)
  agreements: { epic: string; primary: Action; second: Action; agree: boolean }[];
  disagreements: number; // count of BUY/SELL the two brains disagreed on
}

export function combineBrains(
  primary: BrainOutput,
  second: BrainOutput,
  mode: "observe" | "enforce" | "either",
): EnsembleResult {
  const primaryByEpic = new Map(primary.decisions.map((d) => [d.epic, d]));
  const secondByEpic = new Map(second.decisions.map((d) => [d.epic, d]));
  // Union of epics either brain ruled on, so a second-brain-only opportunity
  // (which the primary didn't mention) is still considered in "either" mode.
  const epics = [
    ...new Set([
      ...primary.decisions.map((d) => d.epic),
      ...second.decisions.map((d) => d.epic),
    ]),
  ];

  const agreements: EnsembleResult["agreements"] = [];
  let disagreements = 0;
  const decisions: TradeDecision[] = [];

  for (const epic of epics) {
    const p = primaryByEpic.get(epic);
    const s = secondByEpic.get(epic);
    const primaryAction: Action = p?.action ?? "HOLD";
    const secondAction: Action = s?.action ?? "HOLD";
    const secondConfidence = s?.confidence ?? 0;
    const agree = primaryAction === secondAction;
    agreements.push({ epic, primary: primaryAction, second: secondAction, agree });

    const isTradeP = primaryAction === "BUY" || primaryAction === "SELL";
    const isTradeS = secondAction === "BUY" || secondAction === "SELL";
    if ((isTradeP || isTradeS) && !agree) disagreements++;

    // Annotate off the primary when it ruled on this epic, else off the second.
    const base = p ?? s!;
    const annotated: TradeDecision = {
      ...base,
      epic,
      secondAction,
      secondConfidence,
      secondAgree: agree,
    };

    if (mode === "either") {
      // Risk-reduction wins first: if either brain says CLOSE, close.
      if (primaryAction === "CLOSE" || secondAction === "CLOSE") {
        const src = primaryAction === "CLOSE" ? p! : s!;
        decisions.push({ ...annotated, action: "CLOSE", confidence: src.confidence, reasoning: src.reasoning });
        continue;
      }
      // If EITHER brain wants to trade, take the highest-conviction trading side.
      if (isTradeP || isTradeS) {
        const candidates: TradeDecision[] = [];
        if (isTradeP) candidates.push(p!);
        if (isTradeS) candidates.push(s!);
        const win = candidates.sort((a, b) => b.confidence - a.confidence)[0]!;
        const who = win === p ? "DeepSeek" : "Qwen";
        const conflict = isTradeP && isTradeS && !agree;
        decisions.push({
          ...annotated,
          action: win.action,
          confidence: win.confidence,
          setup: win.setup,
          stopLossPct: win.stopLossPct,
          takeProfitPct: win.takeProfitPct,
          reasoning: conflict
            ? `双脑方向不一致，采用信心更高的一方（${who} ${win.action}，信心 ${win.confidence.toFixed(2)}）。${win.reasoning}`
            : `${who} 看到机会（${win.action}，信心 ${win.confidence.toFixed(2)}），单脑看好即下单。${win.reasoning}`,
        });
        continue;
      }
      decisions.push({ ...annotated, action: "HOLD" });
      continue;
    }

    if (mode === "enforce" && isTradeP) {
      if (!agree) {
        decisions.push({
          ...annotated,
          action: "HOLD",
          reasoning: `双脑不一致（DeepSeek ${primaryAction} / Qwen ${secondAction}），观望。原因：${p!.reasoning}`,
        });
      } else {
        // consensus BUY/SELL: take the conservative (lower) confidence.
        decisions.push({ ...annotated, confidence: Math.min(p!.confidence, secondConfidence) });
      }
      continue;
    }

    // observe (default): keep the primary's call, annotated. Epics the primary
    // didn't rule on default to HOLD (the second brain's call is recorded only).
    decisions.push(p ? annotated : { ...annotated, action: "HOLD" });
  }

  return { decisions, agreements, disagreements };
}
