import "dotenv/config";

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name} (see .env.example)`);
  return v;
}

function num(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return def;
  const n = Number(v);
  if (Number.isNaN(n)) throw new Error(`Env var ${name} must be a number, got "${v}"`);
  return n;
}

function bool(name: string, def: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return def;
  return v.toLowerCase() === "true" || v === "1";
}

/** Parse "1:20,2:30,3:20" → tiers [{profitPct,closePct},…] sorted by profit. */
function tiers(name: string, def: string): { profitPct: number; closePct: number }[] {
  return (process.env[name] ?? def)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((pair) => {
      const [p, c] = pair.split(":").map(Number);
      return { profitPct: p!, closePct: c! };
    })
    .filter((t) => Number.isFinite(t.profitPct) && Number.isFinite(t.closePct) && t.closePct > 0)
    .sort((a, b) => a.profitPct - b.profitPct);
}

const mode = (process.env.TRADING_MODE ?? "demo").toLowerCase();
if (mode !== "demo" && mode !== "live") {
  throw new Error(`TRADING_MODE must be "demo" or "live", got "${mode}"`);
}

export const config = {
  mode: mode as "demo" | "live",
  dryRun: bool("DRY_RUN", true),

  capital: {
    apiKey: req("CAPITAL_API_KEY"),
    identifier: req("CAPITAL_IDENTIFIER"),
    password: req("CAPITAL_PASSWORD"),
    baseUrl:
      mode === "live"
        ? "https://api-capital.backend-capital.com"
        : "https://demo-api-capital.backend-capital.com",
  },

  deepseek: {
    apiKey: req("DEEPSEEK_API_KEY"),
    model: process.env.DEEPSEEK_MODEL ?? "deepseek-chat",
    baseUrl: "https://api.deepseek.com",
  },

  // Second Chief Trader — Qwen (a DIFFERENT model, for genuine ensemble
  // diversity). When both brains agree, conviction is higher; disagreement is a
  // caution signal. Enabled automatically when QWEN_API_KEY is present.
  secondBrain: {
    apiKey: process.env.QWEN_API_KEY ?? "",
    baseUrl:
      process.env.QWEN_BASE_URL ?? "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    model: process.env.QWEN_MODEL ?? "qwen-plus",
    enabled: !!process.env.QWEN_API_KEY && bool("SECOND_BRAIN", true),
    // "observe" = record both brains + agreement, trade the primary's calls (A/B).
    // "enforce" = a BUY/SELL needs BOTH brains to agree, else HOLD.
    // "either"  = OR-logic: trade if EITHER brain sees an opportunity (most
    //             aggressive — more trades, more chances to profit).
    mode: (() => {
      const m = (process.env.SECOND_BRAIN_MODE ?? "observe").toLowerCase();
      return (m === "enforce" ? "enforce" : m === "either" ? "either" : "observe") as
        | "enforce"
        | "observe"
        | "either";
    })(),
  },

  brain: {
    // Devil's Advocate: a second AI that argues against every open proposal.
    devilAdvocate: bool("DEVIL_ADVOCATE", true),
    // counterConfidence at/above this => the critic "would veto" the trade.
    vetoThreshold: num("DEVIL_VETO_THRESHOLD", 0.7),
    // "observe" = record the critic's verdict but DON'T block (collect A/B data).
    // "enforce" = vetoed trades are downgraded to HOLD. Start in observe.
    devilMode: ((process.env.DEVIL_MODE ?? "observe").toLowerCase() === "enforce"
      ? "enforce"
      : "observe") as "enforce" | "observe",
  },

  news: {
    apiKey: process.env.NEWS_API_KEY ?? "",
  },

  risk: {
    allowedEpics: (process.env.ALLOWED_EPICS ?? "GOLD,SILVER,US500")
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean),
    // Optional HARD lot ceiling per position. 0 = no fixed-lot ceiling (let the
    // capital-%/margin/loss-cap decide the size). Kept small only if you want to
    // clamp lots regardless of capital.
    maxPositionSize: num("MAX_POSITION_SIZE", 0),
    maxOpenPositions: num("MAX_OPEN_POSITIONS", 5),
    minAccountBalance: num("MIN_ACCOUNT_BALANCE", 100),
    stopLossPct: num("STOP_LOSS_PCT", 2),
    takeProfitPct: num("TAKE_PROFIT_PCT", 4),
    minConfidence: num("MIN_CONFIDENCE", 0.65),
    // Minimum composite opportunity score (0-100) to trade at all. Below this the
    // setup lacks a real edge → no trade. Above it, size scales with the score.
    minSignalScore: num("MIN_SIGNAL_SCORE", 55),
    // Expected-Value gate: once a SETUP has ≥ MIN_EV_SAMPLE scored round-trips,
    // block new trades of that setup if its realised expectancy (avg R-multiple =
    // win%×avgWinR − loss%×avgLossR, costs already in realised P/L) is below
    // MIN_EV_R. Only enforced with enough data — no gating on thin samples.
    minEvSample: num("MIN_EV_SAMPLE", 8),
    minEvR: num("MIN_EV_R", 0),
    // Position-sizing mode:
    //   "capital" = DYNAMIC RISK-BASED sizing: risk-per-trade (scaled by signal
    //               strength) is the control; capital % is only a utilisation
    //               CEILING. Decouples "how much I can deploy" from "how much I can
    //               lose" — the default, and how you maximise risk-adjusted return.
    //   "risk"    = simple fixed risk-to-stop so a stop-out loses ~RISK_PER_TRADE_PCT.
    sizingMode: ((process.env.SIZING_MODE ?? "capital").toLowerCase() === "risk"
      ? "risk"
      : "capital") as "capital" | "risk",
    // Capital-UTILISATION CEILING: the MOST margin a single trade may commit, as a
    // % of funds still available this cycle. 100 = may use all available funds.
    // This is NOT a loss limit — it only caps how much capital gets deployed.
    capitalDeployPct: num("CAPITAL_DEPLOY_PCT", 100),
    // Dynamic risk band: risk-per-trade scales with the brain's signal strength
    // (confidence) from MIN (weak edge) to MAX (strong edge). size = riskBudget /
    // stopDistance, so a tighter stop buys a bigger position at the SAME risk.
    targetRiskMinPct: num("TARGET_RISK_MIN_PCT", 0.5),
    targetRiskMaxPct: num("TARGET_RISK_MAX_PCT", 1.5),
    // EDGE-SCALED SIZING (fractional Kelly): once a SETUP has ≥MIN_EV_SAMPLE
    // realised trades and a POSITIVE expectancy, bet MORE on it — Kelly's growth-
    // optimal fraction f* = winRate·(PF−1)/PF, of which we risk KELLY_FRACTION (a
    // conservative fraction of full Kelly = much lower variance). The boost can lift
    // the signal-based risk up to EDGE_MAX_MULT×, always clamped by MAX_TRADE_LOSS_PCT.
    // This is how you maximise long-run growth: press proven winners, not hunches.
    edgeSizing: bool("EDGE_SIZING", true),
    kellyFraction: num("KELLY_FRACTION", 0.34), // ≈ third-Kelly (prudent-aggressive)
    edgeMaxMult: num("EDGE_MAX_MULT", 2.5), // proven edge → up to 2.5× the base risk
    // Dynamic sizing (risk mode): size each trade by RISK-TO-STOP so the loss if
    // the stop is hit is capped at RISK_PER_TRADE_PCT of equity.
    dynamicSizing: bool("DYNAMIC_SIZING", true),
    // "risk" mode only: fixed % of equity risked per trade (before conviction scale).
    riskPerTradePct: num("RISK_PER_TRADE_PCT", 0.5),
    // ABSOLUTE per-trade risk ceiling: whatever the sizer picks, a single stop-out
    // may never lose more than this % of equity (scaled DOWN to fit; refused only
    // if even the min lot breaches it). The hard cap above the dynamic risk band.
    maxTradeLossPct: num("MAX_TRADE_LOSS_PCT", 2),
    // Circuit breakers (realised-P/L based, computed from the committed ledger).
    // On breach the risk engine halts ALL new opens; closes still allowed.
    maxDailyLossPct: num("MAX_DAILY_LOSS_PCT", 3),
    maxWeeklyLossPct: num("MAX_WEEKLY_LOSS_PCT", 7),
    maxDrawdownPct: num("MAX_DRAWDOWN_PCT", 10),
    // Halt new opens after this many consecutive losing trades (a cold-streak
    // guard). Resets on the next win. 0 = disabled.
    maxConsecutiveLosses: num("MAX_CONSECUTIVE_LOSSES", 4),
    // Portfolio-level concentration control ("portfolio heat"). Per-trade gates
    // cap ONE trade; these cap the AGGREGATE so best-first allocation can't pile
    // the whole book into one correlated theme (see src/risk/exposure.ts).
    //   - MAX_PORTFOLIO_HEAT_PCT: Σ loss-if-stopped across ALL open positions ≤
    //     this % of equity (total simultaneous risk). 0 = disabled.
    //   - MAX_GROUP_HEAT_PCT: within a correlation group, the heavier of the long
    //     vs short side's aggregate risk ≤ this % of equity (concentration). Same-
    //     direction correlated trades stack; opposite directions hedge. 0 = off.
    // Oversized/over-concentrated candidates are scaled DOWN to fit, refused only
    // if even the min lot breaches the cap. CORR_GROUPS overrides the group map.
    maxPortfolioHeatPct: num("MAX_PORTFOLIO_HEAT_PCT", 10),
    maxGroupHeatPct: num("MAX_GROUP_HEAT_PCT", 6),
    // Trailing stop: the stop follows the price as it moves in your favour.
    useTrailingStop: bool("USE_TRAILING_STOP", true),
    // Partial profit-taking (scale-outs): let winners run by banking pieces of a
    // position as it moves in favour and trailing the rest. Tiers are
    // "profit%:close%-of-original" pairs; whatever isn't scaled out rides the
    // trailing stop. e.g. "1:20,2:30,3:20" = at +1% bank 20%, +2% 30%, +3% 20%.
    partialTp: bool("PARTIAL_TP", true),
    partialTpTiers: tiers("PARTIAL_TP_TIERS", "1:20,2:30,3:20"),
  },

  // Number of trailing days of price history fed to the brain as a trend signal.
  trendDays: num("TREND_DAYS", 7),

  // Daily report: at this local hour (0-23) the loop sends a Chinese summary once/day.
  reportHour: num("REPORT_HOUR", 21),

  loopIntervalMinutes: num("LOOP_INTERVAL_MINUTES", 60),

  notify: {
    // "actions" = only notify when something happens (opens/closes) — default.
    // "all"     = also notify on cycles that only HOLD.
    verbosity: (process.env.NOTIFY_ON ?? "actions").toLowerCase() as "actions" | "all",
    // Push messages are BATCHED and sent at most once per this many minutes, so
    // a fast trading loop doesn't spam you every cycle. Default: one message /2h.
    // Actions inside the window are collected and flushed together; if nothing
    // happened, a brief heartbeat check-in is sent instead.
    intervalMinutes: num("NOTIFY_INTERVAL_MINUTES", 120),
  },
} as const;

export type Config = typeof config;
