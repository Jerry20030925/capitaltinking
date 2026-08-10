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
    maxPositionSize: num("MAX_POSITION_SIZE", 1),
    maxOpenPositions: num("MAX_OPEN_POSITIONS", 3),
    minAccountBalance: num("MIN_ACCOUNT_BALANCE", 100),
    stopLossPct: num("STOP_LOSS_PCT", 2),
    takeProfitPct: num("TAKE_PROFIT_PCT", 4),
    minConfidence: num("MIN_CONFIDENCE", 0.65),
    // Dynamic sizing: size each trade by RISK-TO-STOP so the loss if the stop is
    // hit is capped at RISK_PER_TRADE_PCT of equity. MAX_POSITION_SIZE is a hard
    // anti-runaway ceiling. (false = fixed MAX_POSITION_SIZE lot.)
    dynamicSizing: bool("DYNAMIC_SIZING", true),
    // Max % of equity lost on a single trade if its stop-loss is hit. This is the
    // core per-trade risk budget — one trade risks ~1R.
    riskPerTradePct: num("RISK_PER_TRADE_PCT", 0.5),
    // Circuit breakers (realised-P/L based, computed from the committed ledger).
    // On breach the risk engine halts ALL new opens; closes still allowed.
    maxDailyLossPct: num("MAX_DAILY_LOSS_PCT", 2),
    maxWeeklyLossPct: num("MAX_WEEKLY_LOSS_PCT", 5),
    maxDrawdownPct: num("MAX_DRAWDOWN_PCT", 10),
    // Trailing stop: the stop follows the price as it moves in your favour.
    useTrailingStop: bool("USE_TRAILING_STOP", true),
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
  },
} as const;

export type Config = typeof config;
