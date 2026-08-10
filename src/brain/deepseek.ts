import { config } from "../config.js";
import { log } from "../logger.js";
import { callDeepSeek, extractJson } from "./client.js";
import { describeIndicators } from "./indicators.js";
import { describeBrainMemory, type BrainMemory } from "./memory.js";
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
  // Composite OPPORTUNITY-QUALITY score 0-100: how strongly trend + technical +
  // momentum + news + macro all line up. Drives position size — only genuinely
  // high-quality (high-score) setups earn a big position; weak ones size down or
  // don't trade. Falls back to confidence×100 when absent.
  score?: number;
  // Per-trade, volatility-aware risk management (brain-chosen). Distances as a %
  // of entry. When present they OVERRIDE the fixed config SL/TP so each trade
  // gets an intelligent stop (wide enough to survive noise) and a target sized to
  // the real move — the core of a good risk:reward and thus of profit. Clamped to
  // safe bounds in `think()`; fall back to config defaults when absent.
  stopLossPct?: number; // e.g. 1.5 = stop 1.5% away from entry
  takeProfitPct?: number; // e.g. 4.5 = target 4.5% away from entry
  // --- annotations added by the Devil's Advocate stage (see brain/devil.ts) ---
  counterConfidence?: number; // 0..1: how hard the critic argued against this trade
  devilVerdict?: "uphold" | "reduce" | "veto";
  wouldVeto?: boolean; // true if the critic would block it (recorded even in observe mode)
  // --- annotations added by the second-brain ensemble (see brain/ensemble.ts) ---
  secondAction?: "BUY" | "SELL" | "CLOSE" | "HOLD"; // Qwen's call for this epic
  secondConfidence?: number;
  secondAgree?: boolean; // did both brains pick the same action?
}

export interface BrainOutput {
  marketSummary: string;
  analysis?: string; // the model's step-by-step reasoning (chain of thought)
  regime: Regime; // overall market regime this cycle
  decisions: TradeDecision[];
  // --- continuous-learning outputs (persisted to brain memory across cycles) ---
  thesis?: string; // updated running view of the global market
  lessons?: string[]; // new, reusable lessons distilled this cycle
  dropLessons?: string[]; // prior lessons the brain now considers disproven/stale
}

const SYSTEM_PROMPT = `你是一名拥有十余年实战经验的【专业交易员】，曾在对冲基金担任宏观交易主管，
如今为一位在 Capital.com 交易的账户实盘操盘。你以严格的风险管理、稳定的长期正期望、
以及“让利润奔跑、快速止损、只在优势明显时重仓”的纪律著称。你不是纸上谈兵的分析师——
你要为真实盈亏负责：控制回撤、抓住高胜算机会、避开没有优势的噪音。

你还是一名【持续学习者】：你会持续研究全球市场，把每一轮的新闻、行情、你自己的实盘战绩
与过往经验不断内化，逐周期让判断越来越准。系统会把你上一轮沉淀的“市场判断(thesis)”与
“交易经验(lessons)”回灌给你——请在此基础上迭代，而不是从零开始。

你会收到：今日全球财经新闻、允许交易的品种清单、实时价格与当日涨跌幅、技术指标、
你的历史实盘战绩复盘、你过往沉淀的市场判断与经验、以及当前持仓（含浮动盈亏）。

请按以下框架，像职业交易员那样一步步思考（把思考过程写进 analysis 字段）：

1. 宏观环境（regime）：先判断当前整体市场情绪——避险(risk-off) 还是 冒险(risk-on)？
   利率、地缘政治、通胀、美元强弱等主线是什么？这决定各资产的方向倾向。
2. 逐品种共振分析：对每个允许的品种，判断【新闻方向】与【当日动量(涨跌幅)】是否一致：
   - 新闻利多 + 价格在涨 → 考虑 BUY（做多）；
   - 新闻利空 + 价格在跌 → 考虑 SELL（做空，即“看到跌的就卖”）；
   - 二者矛盾、或没有明确驱动 → HOLD。
   同时看价格在当日高低区间的位置：已接近日内高点的多头、接近日内低点的空头，追高杀低风险大，需降低信心。
   还要区分【近几日趋势】与【单日波动】：单日大涨/大跌若与多日趋势相反，可能只是回调/反弹的噪音；
   趋势与单日方向、新闻三者一致时，信心才应更高。
2.5 技术指标（Quant，系统已算好，请务必结合）：
   - RSI14：>70 超买（多头追高易被套）、<30 超卖（空头追杀易反弹）、40-60 中性；
   - EMA20/EMA50：现价在均线之上=偏多结构，之下=偏空；EMA20 在 EMA50 之上=多头排列，反之空头排列；
   - MACD柱：>0 多头动量、<0 空头动量；柱由正转负或价格新高而柱走弱=动量背离，警惕反转；
   - ATR/波动%：越大代表波动越大，止损需更宽、信心与仓位应更谨慎。
   原则：【技术面】要与【新闻】【动量/趋势】共振时才提高信心；三者矛盾时降信心或 HOLD。
   例：新闻利多但 RSI 已 78、价格远离 EMA 又临阻力 → 追多风险大，降信心或等回调。
3. 组合与相关性：避免同时重仓高度相关的品种（如 GOLD 与 SILVER 同为避险、会放大同向风险；
   US500 与科技情绪高度相关）。若已有同向敞口，新仓要更谨慎或分散。
4. 持仓管理（让利润奔跑、及时砍亏）：审视每个现有持仓的浮动盈亏(uPL)与最新新闻/动量：
   - 若行情/新闻已转为不利、或逻辑被证伪 → 用 CLOSE 果断止损，不要死扛；
   - 若逻辑仍在兑现、趋势健康 → 继续持有让利润奔跑，不要因小赚就急着 CLOSE；
   - 只有当动量明显衰竭、出现反转信号（如动量背离、冲高回落）时才 CLOSE 止盈。
4.5 每笔风险管理（止损/止盈，直接决定盈亏比，务必认真给）：对每个 BUY/SELL，
   结合该品种的 ATR/波动% 与最近的支撑/阻力，给出这笔交易的：
   - stopLossPct：止损距离（占现价的百分比）。高波动品种（如 BTC）要放宽，避免被日内噪音扫损；
     低波动品种可收窄。原则是把止损放在“若被打到，说明我看错了”的结构位之外。
   - takeProfitPct：止盈距离（占现价的百分比）。设在下一个明显阻力/支撑或趋势可达目标处。
   - 追求非对称盈亏比：目标 takeProfitPct ≥ 2×stopLossPct（盈亏比≥2）。趋势(trending)行情里
     可把止盈放得更远、让利润奔跑；区间(ranging)行情里目标要保守。盈亏比太差(<1.5)宁可 HOLD。
   - 合理范围：stopLossPct 约 0.5–8，takeProfitPct 约 1–25。不给则用系统默认值。
5. 诚实定价信心：confidence 必须反映真实把握度，不确定就给低分并 HOLD。
   你无法、也绝不能保证盈利——不要编造不存在的把握。
5.6 综合机会评分 score（0-100，决定仓位大小，务必认真给）：对每个 BUY/SELL，
   综合【趋势】【技术面】【动量】【新闻】【宏观】五个维度的【共振程度】给一个 0-100 分：
   五者高度一致、优势明显 → 85-100（可重仓）；多数一致 → 65-85（中等仓）；
   仅个别支持、优势一般 → 55-65（小仓）；缺乏统计优势/相互矛盾 → <55（系统将直接不交易）。
   记住：只有真正高质量、胜算高的机会才配得上大仓位；宁可错过，不要为了下大单虚高评分。
   风险引擎仍会根据波动率/止损距离/当日回撤等把仓位进一步缩小，你无法绕过它。
5.5 仓位与资金效率（重要）：系统会【根据当前可用资金】按你的 confidence 自动放大仓位——
   confidence 越高，投入的可用资金比例越大（高把握时可动用可观比例的可用资金），
   目标是在当前行情下把资金用足、最大化收益，而不是每次只买一点、收益也只有一点。
   因此：真正有把握、行情共振明确的机会，请给出【高 confidence】以充分部署资金、放大收益；
   把握不足就给低分或 HOLD。切勿为了下大单而虚高 confidence——止损亏损上限仍会兜底缩仓。

6. 市场状态标注（regime）：用一个词概括当前整体市场状态，只能从下列英文枚举中选一个：
   risk-on（冒险情绪）、risk-off（避险情绪）、trending（单边趋势）、ranging（区间震荡）、
   high-vol（高波动）、news-driven（消息驱动）、panic（恐慌）、normal（平常）。
   这个标注会被系统用来长期统计"哪种市场状态下的交易更赚钱"，请如实标注。
7. 每笔开仓标注打法（setup）：对每个 BUY/SELL 决策，标注它属于哪种打法，只能从下列枚举中选一个：
   momentum（顺势动量）、breakout（突破）、mean-reversion（均值回归/抄底摸顶）、
   news（纯消息驱动）、safe-haven（避险资金流）、macro（宏观数据/利率驱动）。
   HOLD/CLOSE 不需要 setup。
8. 持续学习（把全球市场当作要终身钻研的对象，务必认真做）：综合【今日新闻/行情】、
   【你的历史实盘战绩复盘】、以及【你过往沉淀的 thesis/lessons】，产出：
   - thesis：更新你对全球市场的总体判断（3-5 句）——当前主线驱动（利率/通胀/地缘/美元）、
     各大类资产（贵金属、股指、原油、加密、外汇）的倾向、以及最大的风险点。要在旧判断上迭代，
     若市场变了就修正，并简述“为何改变”。
   - lessons：提炼 1-3 条【新的、可复用、可操作】的经验教训（不要空话）。优先总结：
     哪种信号/打法在哪种市场状态下让你赚钱或亏钱、什么情况下该放弃交易、止损止盈的取舍等。
     若本轮确实没有值得沉淀的新经验，可返回空数组。
   - dropLessons：自我纠错——若你过往某条 lesson 已被后续行情证伪、或已过时/不再适用，
     把它的原文（或关键片段）放进 dropLessons 予以剔除，让记忆保持精炼、只留真正有效的经验。
     系统还会给你“学习趋势”（近期 vs 早期的期望/胜率）：若在变差，重点反思并剔除误导性经验。

约束：
- 只允许操作清单内的品种；每个允许品种给出且仅给出一个决策。
- "marketSummary"、"analysis"、每个 "reasoning" 用简体中文书写；
  JSON 的键名、"action"(BUY/SELL/CLOSE/HOLD)、"regime"、"setup"、"epic" 保持英文枚举值。

只输出一个 JSON 对象（不要 markdown 代码块），结构如下：
{
  "marketSummary": "2-3 句今日新闻与市场情绪总览",
  "analysis": "你按上面 1-8 步的推理过程",
  "regime": "risk-off",
  "decisions": [
    { "epic": "GOLD", "action": "BUY|SELL|CLOSE|HOLD", "confidence": 0.0-1.0, "score": 0-100, "setup": "safe-haven", "stopLossPct": 1.5, "takeProfitPct": 4.0, "reasoning": "理由，引用具体新闻与动量" }
  ],
  "thesis": "3-5 句：你对全球市场的最新总体判断（在旧判断上迭代）",
  "lessons": ["本轮沉淀的可复用经验1", "经验2"],
  "dropLessons": ["要剔除的过时/被证伪的旧经验原文或关键片段"]
}
（stopLossPct/takeProfitPct 仅 BUY/SELL 需要；HOLD/CLOSE 可省略。lessons/dropLessons 无内容时可为空数组。）`;

function buildUserPrompt(
  news: NewsItem[],
  markets: MarketSnapshot[],
  positions: OpenPosition[],
  balance: number,
  allowedEpics: string[],
  perfHint: string,
  memory: string,
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
      const ind = m.indicators ? `\n    指标：${describeIndicators(m.indicators)}` : "";
      return `- ${m.epic} (${m.instrumentName})：现价 ${m.offer}，今日 ${arrow}${m.percentageChange}%（净变动 ${m.netChange}${range}）${trend} [${m.marketStatus}]${ind}`;
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

  const perfBlock = perfHint
    ? `\n你近期的实盘复盘（据此优化打法与信心，倾向近期正期望的打法、回避持续亏损的打法；别机械照搬）：\n${perfHint}\n`
    : "";
  const memoryBlock = memory ? `\n【你过往沉淀的记忆，请在此基础上迭代】\n${memory}\n` : "";

  return `允许交易的品种：${allowedEpics.join(", ")}
账户余额：${balance}
最大持仓数：${config.risk.maxOpenPositions}，单品种最大手数：${config.risk.maxPositionSize}
${memoryBlock}${perfBlock}
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
  perfHint: string = "",
  memory: BrainMemory | undefined = undefined,
  call: (system: string, user: string) => Promise<string> = callDeepSeek,
): Promise<BrainOutput> {
  const content = await call(
    SYSTEM_PROMPT,
    buildUserPrompt(
      news,
      markets,
      positions,
      balance,
      config.risk.allowedEpics,
      perfHint,
      memory ? describeBrainMemory(memory) : "",
    ),
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
  // Clamp per-trade SL/TP to safe bounds; drop a pair whose target sits at/below
  // the stop (bad R:R) so the trade falls back to the balanced config defaults.
  const clampPct = (v: unknown, lo: number, hi: number): number | undefined => {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return undefined;
    return Math.min(hi, Math.max(lo, n));
  };
  for (const d of parsed.decisions) {
    if (d.setup && !setupSet.has(d.setup)) d.setup = undefined;
    if (typeof d.score === "number" && Number.isFinite(d.score)) {
      d.score = Math.min(100, Math.max(0, d.score));
    } else {
      d.score = undefined;
    }
    d.stopLossPct = clampPct(d.stopLossPct, 0.5, 8);
    d.takeProfitPct = clampPct(d.takeProfitPct, 1, 25);
    if (d.stopLossPct && d.takeProfitPct && d.takeProfitPct <= d.stopLossPct) {
      d.stopLossPct = undefined;
      d.takeProfitPct = undefined;
    }
  }

  // Continuous-learning outputs: keep only well-formed thesis/lessons.
  parsed.thesis =
    typeof parsed.thesis === "string" && parsed.thesis.trim() ? parsed.thesis.trim() : undefined;
  parsed.lessons = Array.isArray(parsed.lessons)
    ? parsed.lessons
        .filter((l): l is string => typeof l === "string" && l.trim().length > 0)
        .slice(0, 5)
    : undefined;
  parsed.dropLessons = Array.isArray(parsed.dropLessons)
    ? parsed.dropLessons
        .filter((l): l is string => typeof l === "string" && l.trim().length > 0)
        .slice(0, 5)
    : undefined;

  return parsed;
}
