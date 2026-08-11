import { config } from "../config.js";

/**
 * Portfolio-level concentration control ("portfolio heat").
 *
 * Every per-trade gate already caps a SINGLE trade's risk. But a book of many
 * individually-fine trades can still be dangerous in aggregate:
 *   1. Total open risk (heat) — 5 positions each risking 2% = 10% at risk
 *      simultaneously; one bad session stops them all out together.
 *   2. Correlated concentration — GOLD long + SILVER long is not two independent
 *      bets, it's ONE leveraged "long precious metals / short USD" bet. Best-first
 *      capital allocation, left unchecked, piles the whole book into one theme, so
 *      when that theme reverses every stop fires at once.
 *
 * This module tracks heat two ways and hands the risk gate a per-candidate "room"
 * budget so oversized/over-concentrated trades are scaled DOWN to fit (or refused):
 *   - PORTFOLIO heat: Σ risk of all open + newly-approved positions ≤ cap.
 *   - GROUP heat (direction-aware): within a correlation group, the larger of the
 *     aggregate long-side risk vs short-side risk ≤ cap. Same-direction risks add
 *     (concentration); opposite directions are a genuine hedge and don't stack.
 *
 * All risk is measured as "loss if the stop is hit" in account currency — the same
 * 1R unit the rest of the risk engine uses. Set either cap to 0 to disable it.
 */

export interface Exposure {
  epic: string;
  direction: "BUY" | "SELL";
  risk: number; // loss-if-stopped, account currency (the trade's 1R)
}

export interface ExposureLimits {
  maxPortfolioRisk: number; // account currency
  maxGroupRisk: number; // account currency
}

/** Default instrument → correlation-group map. Override via CORR_GROUPS env. */
const DEFAULT_GROUPS: Record<string, string> = {
  GOLD: "metals",
  SILVER: "metals",
  PLATINUM: "metals",
  US500: "equities",
  US100: "equities",
  US30: "equities",
  GER40: "equities",
  UK100: "equities",
  OIL: "energy",
  CRUDEOIL: "energy",
  NATURALGAS: "energy",
  BTC: "crypto",
  BTCUSD: "crypto",
  ETH: "crypto",
  ETHUSD: "crypto",
  EURUSD: "fx-eur",
  GBPUSD: "fx-gbp",
  USDJPY: "fx-jpy",
};

/**
 * Parse CORR_GROUPS="metals:GOLD,SILVER;equities:US500,US100" into an epic→group
 * map. Falls back to the built-in defaults when the env var is empty/malformed.
 */
function parseGroups(): Record<string, string> {
  const raw = process.env.CORR_GROUPS?.trim();
  if (!raw) return DEFAULT_GROUPS;
  const map: Record<string, string> = {};
  for (const chunk of raw.split(";")) {
    const [group, members] = chunk.split(":");
    if (!group || !members) continue;
    for (const epic of members.split(",")) {
      const e = epic.trim().toUpperCase();
      if (e) map[e] = group.trim();
    }
  }
  return Object.keys(map).length ? map : DEFAULT_GROUPS;
}

const GROUPS = parseGroups();

/** Correlation group for an epic; unlisted instruments are their own singleton. */
export function groupOf(epic: string): string {
  const e = epic.toUpperCase();
  return GROUPS[e] ?? e;
}

/** Resolve the two heat caps (account currency) from equity + config. */
export function exposureLimits(equity: number): ExposureLimits {
  return {
    maxPortfolioRisk: equity * (config.risk.maxPortfolioHeatPct / 100),
    maxGroupRisk: equity * (config.risk.maxGroupHeatPct / 100),
  };
}

/**
 * Live heat accounting. Seed with the risk of already-open positions, then, as the
 * risk gate approves trades this cycle, ask `roomFor` how much additional risk a
 * candidate may take and `admit` it once sized. Zero-valued caps mean "unlimited".
 */
export class ExposureBook {
  private list: Exposure[] = [];

  constructor(private limits: ExposureLimits, seed: Exposure[] = []) {
    this.list = seed.filter((e) => e.risk > 0);
  }

  private portfolioHeat(): number {
    return this.list.reduce((s, e) => s + e.risk, 0);
  }

  /** Direction-aware group heat: the heavier of the long vs short side of a group. */
  private groupHeat(group: string, direction?: "BUY" | "SELL"): number {
    let long = 0;
    let short = 0;
    for (const e of this.list) {
      if (groupOf(e.epic) !== group) continue;
      if (e.direction === "BUY") long += e.risk;
      else short += e.risk;
    }
    if (direction === "BUY") return long;
    if (direction === "SELL") return short;
    return Math.max(long, short);
  }

  /**
   * Max additional risk a new trade in (epic, direction) may take without
   * breaching either cap. Infinity when both caps are disabled (0).
   */
  roomFor(epic: string, direction: "BUY" | "SELL"): number {
    let room = Infinity;
    if (this.limits.maxPortfolioRisk > 0) {
      room = Math.min(room, this.limits.maxPortfolioRisk - this.portfolioHeat());
    }
    if (this.limits.maxGroupRisk > 0) {
      const side = this.groupHeat(groupOf(epic), direction);
      room = Math.min(room, this.limits.maxGroupRisk - side);
    }
    return Math.max(0, room);
  }

  admit(exp: Exposure): void {
    if (exp.risk > 0) this.list.push(exp);
  }

  /** Snapshot of current heat for logging (in account currency + % of equity). */
  summary(equity: number): string {
    const port = this.portfolioHeat();
    const groups = new Map<string, number>();
    for (const e of this.list) {
      const g = groupOf(e.epic);
      groups.set(g, Math.max(groups.get(g) ?? 0, this.groupHeat(g)));
    }
    const pct = (v: number) => (equity > 0 ? ((v / equity) * 100).toFixed(1) : "0");
    const parts = [...groups.entries()]
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([g, v]) => `${g} ${pct(v)}%`);
    return `组合风险敞口 ${pct(port)}%${parts.length ? "（" + parts.join("，") + "）" : ""}`;
  }
}
