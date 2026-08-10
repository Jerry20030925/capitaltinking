import { log } from "../logger.js";
import { callDeepSeek, extractJson } from "./client.js";
import type { NewsItem } from "../news/fetch.js";
import type { MarketSnapshot, OpenPosition } from "../capital/client.js";
import type { TradeDecision, BrainOutput } from "./deepseek.js";

/**
 * The Devil's Advocate: a second, adversarial AI whose ONLY job is to argue
 * against the Chief Trader's open proposals. It never agrees for the sake of
 * agreeing — it hunts for reasons each trade is wrong. Its output is advisory;
 * the deterministic gate (applyDevilVeto) decides what to do with it.
 *
 * Two modes (config.brain.devilMode):
 *   - "observe": record the critic's verdict but DON'T block — trades still open.
 *                This lets us measure the counterfactual (how vetoed trades
 *                actually performed) and A/B win-rate before trusting the veto.
 *   - "enforce": high-conviction vetoes downgrade the trade to HOLD.
 */

export type DevilVerdict = "uphold" | "reduce" | "veto";

export interface Critique {
  epic: string;
  counterConfidence: number; // 0..1: strength of the argument AGAINST the trade
  verdict: DevilVerdict;
  rebuttal: string;
}

export interface DevilResult {
  decisions: TradeDecision[]; // annotated (and, in enforce mode, possibly downgraded)
  vetoes: { epic: string; counterConfidence: number; rebuttal: string }[];
  reduced: { epic: string; from: number; to: number }[];
}

const SYSTEM_PROMPT = `你是一名极度谨慎、专门唱反调的"反方"风控交易员（Devil's Advocate）。
另一名"主交易员"已经给出了若干开仓建议（BUY/SELL）。你唯一的职责是：竭尽全力反驳每一个开仓建议，主动寻找它可能是错的理由。你绝不能附和主交易员。

对每一个开仓建议，请从以下角度找反方证据：
- 是否存在相反方向的新闻或基本面；
- 价格是否已经把利好/利空 price-in、是否在追高杀低、是否临近关键支撑/阻力；
- 动量与多日趋势是否背离，单日大涨大跌是否只是回调/反弹的噪音；
- 是否临近重大数据（CPI/NFP/FOMC），spread 或波动是否异常；
- 主交易员给出的理由本身是否站得住脚、信心是否被高估。

对每个开仓建议给出：
- counterConfidence（0-1）：你反对这笔交易的把握。越接近 1 表示越应该否决。
- verdict："veto"（强烈反对，应改为观望）｜"reduce"（有隐患，应降低信心/减小仓位）｜"uphold"（反方也找不到有力反驳，可放行）。
- rebuttal：简体中文，简述你的反驳；若确实无有力反驳，也要如实说明。

只输出一个 JSON 对象（不要 markdown 代码块）：
{ "critiques": [ { "epic": "GOLD", "counterConfidence": 0.0-1.0, "verdict": "veto|reduce|uphold", "rebuttal": "..." } ] }`;

function marketLine(m: MarketSnapshot): string {
  const arrow = m.percentageChange > 0 ? "▲" : m.percentageChange < 0 ? "▼" : "—";
  const range = m.high && m.low ? `，当日区间 ${m.low}-${m.high}` : "";
  const trend =
    m.trendPct !== undefined
      ? `；近期趋势 ${m.trendPct > 0 ? "▲" : m.trendPct < 0 ? "▼" : "—"}${m.trendPct.toFixed(2)}%`
      : "";
  return `- ${m.epic}：现价 ${m.offer}，今日 ${arrow}${m.percentageChange}%${range}${trend} [${m.marketStatus}]`;
}

function buildDevilPrompt(
  chief: BrainOutput,
  proposals: TradeDecision[],
  news: NewsItem[],
  markets: MarketSnapshot[],
): string {
  const newsBlock = news
    .slice(0, 15)
    .map((n, i) => `${i + 1}. [${n.source}] ${n.title}${n.summary ? ` — ${n.summary}` : ""}`)
    .join("\n");
  const marketBlock = markets.map(marketLine).join("\n");
  const propBlock = proposals
    .map(
      (d) =>
        `- ${d.action} ${d.epic}（主交易员信心 ${d.confidence.toFixed(2)}，打法 ${d.setup ?? "?"}）：${d.reasoning}`,
    )
    .join("\n");

  return `当前市场状态(regime)：${chief.regime}
主交易员的今日总结：${chief.marketSummary}

今日新闻标题：
${newsBlock}

实时价格与当日动量：
${marketBlock}

主交易员的开仓建议（请逐一反驳）：
${propBlock}

请对上述每个开仓建议给出反方意见，并返回所要求的 JSON。`;
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Run the Devil's Advocate over the Chief Trader's BUY/SELL proposals.
 * Fails OPEN: if the critic call/parse fails, returns [] (no critique) so a
 * transient DeepSeek hiccup never halts trading — the deterministic risk gate
 * still applies. HOLD/CLOSE decisions are never challenged.
 */
export async function challenge(
  chief: BrainOutput,
  news: NewsItem[],
  markets: MarketSnapshot[],
): Promise<Critique[]> {
  const proposals = chief.decisions.filter((d) => d.action === "BUY" || d.action === "SELL");
  if (proposals.length === 0) return [];

  let content: string;
  try {
    content = await callDeepSeek(SYSTEM_PROMPT, buildDevilPrompt(chief, proposals, news, markets));
  } catch (e) {
    log.warn("Devil's Advocate call failed — upholding all (fail-open):", (e as Error).message);
    return [];
  }

  let parsed: { critiques?: Critique[] };
  try {
    parsed = extractJson(content) as { critiques?: Critique[] };
  } catch {
    log.warn("Devil's Advocate returned non-JSON — upholding all.");
    return [];
  }

  const verdicts = new Set<DevilVerdict>(["uphold", "reduce", "veto"]);
  return (parsed.critiques ?? [])
    .filter((c) => c?.epic && verdicts.has(c.verdict))
    .map((c) => ({
      epic: c.epic.toUpperCase(),
      counterConfidence: clamp01(Number(c.counterConfidence) || 0),
      verdict: c.verdict,
      rebuttal: c.rebuttal ?? "",
    }));
}

/**
 * Deterministic gate over the critiques. Annotates every BUY/SELL decision with
 * the critic's verdict (so the ledger records original judgment → veto judgment
 * → final decision → outcome), and — in "enforce" mode — downgrades vetoed
 * trades to HOLD and shaves confidence on "reduce". In "observe" mode nothing is
 * blocked; the annotations are recorded for later A/B analysis.
 */
export function applyDevilVeto(
  decisions: TradeDecision[],
  critiques: Critique[],
  threshold: number,
  mode: "enforce" | "observe",
): DevilResult {
  const byEpic = new Map(critiques.map((c) => [c.epic, c]));
  const vetoes: DevilResult["vetoes"] = [];
  const reduced: DevilResult["reduced"] = [];

  const out = decisions.map((d) => {
    if (d.action !== "BUY" && d.action !== "SELL") return d;
    const c = byEpic.get(d.epic);
    if (!c) return d;

    const wouldVeto = c.verdict === "veto" || c.counterConfidence >= threshold;
    // Always annotate so the trade log carries the critic's judgment.
    const annotated: TradeDecision = {
      ...d,
      counterConfidence: c.counterConfidence,
      devilVerdict: c.verdict,
      wouldVeto,
    };

    if (wouldVeto) {
      vetoes.push({ epic: d.epic, counterConfidence: c.counterConfidence, rebuttal: c.rebuttal });
      if (mode === "enforce") {
        return {
          ...annotated,
          action: "HOLD" as const,
          reasoning: `反方否决(counter ${c.counterConfidence.toFixed(2)})：${c.rebuttal}`,
        };
      }
      return annotated; // observe: record but let it through
    }

    if (c.verdict === "reduce") {
      const to = round2(d.confidence * (1 - 0.5 * c.counterConfidence));
      reduced.push({ epic: d.epic, from: d.confidence, to });
      if (mode === "enforce") return { ...annotated, confidence: to };
    }
    return annotated;
  });

  return { decisions: out, vetoes, reduced };
}
