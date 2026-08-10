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
 */

type Action = TradeDecision["action"];

export interface EnsembleResult {
  decisions: TradeDecision[]; // annotated (and, in enforce mode, gated)
  agreements: { epic: string; primary: Action; second: Action; agree: boolean }[];
  disagreements: number; // count of BUY/SELL the two brains disagreed on
}

export function combineBrains(
  primary: BrainOutput,
  second: BrainOutput,
  mode: "observe" | "enforce",
): EnsembleResult {
  const secondByEpic = new Map(second.decisions.map((d) => [d.epic, d]));
  const agreements: EnsembleResult["agreements"] = [];
  let disagreements = 0;

  const decisions = primary.decisions.map((d) => {
    const s = secondByEpic.get(d.epic);
    // If the second brain didn't rule on this epic, treat as HOLD (no support).
    const secondAction: Action = s?.action ?? "HOLD";
    const secondConfidence = s?.confidence ?? 0;
    const agree = d.action === secondAction;
    agreements.push({ epic: d.epic, primary: d.action, second: secondAction, agree });

    const isTrade = d.action === "BUY" || d.action === "SELL";
    if (isTrade && !agree) disagreements++;

    const annotated: TradeDecision = { ...d, secondAction, secondConfidence, secondAgree: agree };

    if (mode === "enforce" && isTrade) {
      if (!agree) {
        return {
          ...annotated,
          action: "HOLD" as const,
          reasoning: `双脑不一致（DeepSeek ${d.action} / Qwen ${secondAction}），观望。原因：${d.reasoning}`,
        };
      }
      // consensus BUY/SELL: take the conservative (lower) confidence.
      return { ...annotated, confidence: Math.min(d.confidence, secondConfidence) };
    }
    return annotated;
  });

  return { decisions, agreements, disagreements };
}
