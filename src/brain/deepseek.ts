import { config } from "../config.js";
import { log } from "../logger.js";
import { callDeepSeek, extractJson } from "./client.js";
import type { NewsItem } from "../news/fetch.js";
import type { MarketSnapshot, OpenPosition } from "../capital/client.js";

/** Discrete market-regime label, used to group trades in the analytics engine. */
export type Regime =
  | "risk-on"
  | "risk-off"
  | "trending"
  | "ranging"
  | "high-vol"
  | "news-driven"
  | "panic"
  | "normal";

/** Per-trade setup archetype, so we can learn which playbooks actually pay. */
export type Setup =
  | "momentum"
  | "breakout"
  | "mean-reversion"
  | "news"
  | "safe-haven"
  | "macro";

export const REGIMES: readonly Regime[] = [
  "risk-on",
  "risk-off",
  "trending",
  "ranging",
  "high-vol",
  "news-driven",
  "panic",
  "normal",
];
export const SETUPS: readonly Setup[] = [
  "momentum",
  "breakout",
  "mean-reversion",
  "news",
  "safe-haven",
  "macro",
];

export interface TradeDecision {
  epic: string;
  action: "BUY" | "SELL" | "CLOSE" | "HOLD";
  confidence: number; // 0..1
  reasoning: string;
  setup?: Setup; // which playbook this trade expresses (for BUY/SELL)
  // --- annotations added by the Devil's Advocate stage (see brain/devil.ts) ---
  counterConfidence?: number; // 0..1: how hard the critic argued against this trade
  devilVerdict?: "uphold" | "reduce" | "veto";
  wouldVeto?: boolean; // true if the critic would block it (recorded even in observe mode)
}

export interface BrainOutput {
  marketSummary: string;
  analysis?: string; // the model's step-by-step reasoning (chain of thought)
  regime: Regime; // overall market regime this cycle
  decisions: TradeDecision[];
}

const SYSTEM_PROMPT = `你是一名严谨、专业的宏观交易分析师，为一位在 Capital.com 交易的散户服务。
你会收到：今日财经新闻、允许交易的品种清单、实时价格与当日涨跌幅、以及用户当前持仓（含浮动盈亏）。

请按以下分析框架，一步步认真思考（把思考过程写进 analysis 字段）：

1. 宏观环境（regime）：先判断当前整体市场情绪——避险(risk-off) 还是 冒险(risk-on)？
   利率、地缘政治、通胀、美元强弱等主线是什么？这决定各资产的方向倾向。
2. 逐品种共振分析：对每个允许的品种，判断【新闻方向】与【当日动量(涨跌幅)】是否一致：
   - 新闻利多 + 价格在涨 → 考虑 BUY（做多）；
   - 新闻利空 + 价格在跌 → 考虑 SELL（做空，即“看到跌的就卖”）；
   - 二者矛盾、或没有明确驱动 → HOLD。
   同时看价格在当日高低区间的位置：已接近日内高点的多头、接近日内低点的空头，追高杀低风险大，需降低信心。
   还要区分【近几日趋势】与【单日波动】：单日大涨/大跌若与多日趋势相反，可能只是回调/反弹的噪音；
   趋势与单日方向、新闻三者一致时，信心才应更高。
3. 组合与相关性：避免同时重仓高度相关的品种（如 GOLD 与 SILVER 同为避险、会放大同向风险；
   US500 与科技情绪高度相关）。若已有同向敞口，新仓要更谨慎或分散。
4. 持仓管理：审视每个现有持仓的浮动盈亏(uPL)与最新新闻/动量：
   - 若行情/新闻已转为不利 → 用 CLOSE 及时止损；
   - 若逻辑已兑现、动量衰竭 → 可 CLOSE 止盈。
5. 诚实定价信心：confidence 必须反映真实把握度，不确定就给低分并 HOLD。
   你无法、也绝不能保证盈利——不要编造不存在的把握。

6. 市场状态标注（regime）：用一个词概括当前整体市场状态，只能从下列英文枚举中选一个：
   risk-on（冒险情绪）、risk-off（避险情绪）、trending（单边趋势）、ranging（区间震荡）、
   high-vol（高波动）、news-driven（消息驱动）、panic（恐慌）、normal（平常）。
   这个标注会被系统用来长期统计"哪种市场状态下的交易更赚钱"，请如实标注。
7. 每笔开仓标注打法（setup）：对每个 BUY/SELL 决策，标注它属于哪种打法，只能从下列枚举中选一个：
   momentum（顺势动量）、breakout（突破）、mean-reversion（均值回归/抄底摸顶）、
   news（纯消息驱动）、safe-haven（避险资金流）、macro（宏观数据/利率驱动）。
   HOLD/CLOSE 不需要 setup。

约束：
- 只允许操作清单内的品种；每个允许品种给出且仅给出一个决策。
- "marketSummary"、"analysis"、每个 "reasoning" 用简体中文书写；
  JSON 的键名、"action"(BUY/SELL/CLOSE/HOLD)、"regime"、"setup"、"epic" 保持英文枚举值。

只输出一个 JSON 对象（不要 markdown 代码块），结构如下：
{
  "marketSummary": "2-3 句今日新闻与市场情绪总览",
  "analysis": "你按上面 1-7 步的推理过程",
  "regime": "risk-off",
  "decisions": [
    { "epic": "GOLD", "action": "BUY|SELL|CLOSE|HOLD", "confidence": 0.0-1.0, "setup": "safe-haven", "reasoning": "理由，引用具体新闻与动量" }
  ]
}`;

function buildUserPrompt(
  news: NewsItem[],
  markets: MarketSnapshot[],
  positions: OpenPosition[],
  balance: number,
  allowedEpics: string[],
): string {
  const newsBlock = news
    .map((n, i) => `${i + 1}. [${n.source}] ${n.title}${n.summary ? ` — ${n.summary}` : ""}`)
    .join("\n");
  const marketBlock = markets
    .map((m) => {
      const arrow = m.percentageChange > 0 ? "▲" : m.percentageChange < 0 ? "▼" : "—";
      const range = m.high && m.low ? `，当日区间 ${m.low}-${m.high}` : "";
      let trend = "";
      if (m.trendPct !== undefined) {
        const tArrow = m.trendPct > 0 ? "▲" : m.trendPct < 0 ? "▼" : "—";
        const series = m.trendCloses?.length ? `，近期收盘 ${m.trendCloses.join(" → ")}` : "";
        trend = `；近${config.trendDays}日趋势 ${tArrow}${m.trendPct.toFixed(2)}%${series}`;
      }
      return `- ${m.epic} (${m.instrumentName})：现价 ${m.offer}，今日 ${arrow}${m.percentageChange}%（净变动 ${m.netChange}${range}）${trend} [${m.marketStatus}]`;
    })
    .join("\n");
  const posBlock =
    positions.length === 0
      ? "（无持仓）"
      : positions
          .map(
            (p) =>
              `- ${p.epic}：${p.direction} ${p.size} 手 @ ${p.level}，浮动盈亏 ${p.upl}`,
          )
          .join("\n");

  return `允许交易的品种：${allowedEpics.join(", ")}
账户余额：${balance}
最大持仓数：${config.risk.maxOpenPositions}，单品种最大手数：${config.risk.maxPositionSize}

今日新闻标题：
${newsBlock}

实时价格与当日动量：
${marketBlock}

当前持仓：
${posBlock}

请按系统提示的框架分析，并返回所要求的 JSON。`;
}

export async function think(
  news: NewsItem[],
  markets: MarketSnapshot[],
  positions: OpenPosition[],
  balance: number,
): Promise<BrainOutput> {
  const content = await callDeepSeek(
    SYSTEM_PROMPT,
    buildUserPrompt(news, markets, positions, balance, config.risk.allowedEpics),
  );

  let parsed: BrainOutput;
  try {
    parsed = extractJson(content) as BrainOutput;
  } catch {
    log.warn("DeepSeek returned non-JSON, treating as no-op:", content.slice(0, 200));
    return { marketSummary: "parse-error", regime: "normal", decisions: [] };
  }

  // sanitise
  const allowed = new Set(config.risk.allowedEpics);
  const regimeSet = new Set<string>(REGIMES);
  const setupSet = new Set<string>(SETUPS);

  parsed.regime = regimeSet.has(parsed.regime) ? parsed.regime : "normal";
  parsed.decisions = (parsed.decisions ?? []).filter((d) => {
    const ok = allowed.has(d.epic?.toUpperCase());
    if (!ok) log.warn(`Dropping decision for non-allowed epic: ${d.epic}`);
    return ok;
  });
  // Normalise setup tags; drop unknown values rather than trusting them.
  for (const d of parsed.decisions) {
    if (d.setup && !setupSet.has(d.setup)) d.setup = undefined;
  }
  return parsed;
}
