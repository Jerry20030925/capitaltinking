import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import { log } from "../logger.js";
import type { OpenPosition, MarketSnapshot } from "../capital/client.js";

/**
 * Partial profit-taking (scale-outs) — "let winners run". As an open position
 * moves into profit we BANK pieces of it at rising tiers (e.g. +1%→20%, +2%→30%,
 * +3%→20%) and let the remainder ride its trailing stop. This locks in gains on a
 * favourable move while keeping upside if the trend continues.
 *
 * State (per dealId) persists on the same volume as the ledger so tiers aren't
 * re-fired every cycle. Reductions are done via CapitalClient.reducePosition (an
 * opposite-direction deal that nets the position down — the dealId + entry survive,
 * so profit% keeps accruing from the ORIGINAL entry across cycles).
 */

interface Entry {
  originalSize: number; // size when we first saw the position (tiers are % of this)
  fired: number; // how many tiers have already been banked
}
type State = Record<string, Entry>;

export interface ScaleOut {
  dealId: string;
  epic: string;
  direction: "BUY" | "SELL";
  size: number; // size to close now
  tier: number; // tier index reached (1-based count of tiers crossed)
  profitPct: number;
  fullClose: boolean; // remainder too small to leave open → close it all
  entry: number; // original entry level (for the audit trail)
  // Realised P/L banked by closing `size` at the current exit price. Recorded on
  // the "partial" audit event so the ledger can attribute these banked winnings to
  // the round-trip — otherwise every scaled-out winner is silently under-counted,
  // biasing the EV gate, Kelly sizing and drawdown maths (all read realised P/L).
  pnl: number;
}

const STATE_FILE = process.env.LEDGER_DIR
  ? join(process.env.LEDGER_DIR, "scaleout-state.json")
  : fileURLToPath(new URL("../../scaleout-state.json", import.meta.url));

const round2 = (n: number) => Math.round(n * 100) / 100;
function roundToStep(value: number, step: number): number {
  if (step <= 0) return round2(value);
  const decimals = Math.min(4, (String(step).split(".")[1] ?? "").length);
  return Number((Math.floor(value / step) * step).toFixed(decimals));
}

export async function loadScaleoutState(): Promise<State> {
  try {
    const s = JSON.parse(await readFile(STATE_FILE, "utf8")) as State;
    return s && typeof s === "object" ? s : {};
  } catch {
    return {};
  }
}

export async function saveScaleoutState(state: State): Promise<void> {
  try {
    await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    log.warn("Failed to persist scale-out state:", (e as Error).message);
  }
}

/** Drop state entries for positions that are no longer open. */
export function pruneScaleoutState(state: State, positions: OpenPosition[]): void {
  const live = new Set(positions.map((p) => p.dealId));
  for (const id of Object.keys(state)) if (!live.has(id)) delete state[id];
}

/**
 * Decide which positions have crossed a new scale-out tier this cycle and how
 * much of each to bank now. Mutates `state` (records first-seen size + advances
 * the fired-tier count). Pure w.r.t. the broker — the caller executes the plans.
 */
export function planScaleOuts(
  positions: OpenPosition[],
  markets: Map<string, MarketSnapshot>,
  state: State,
): ScaleOut[] {
  const tiers = config.risk.partialTpTiers;
  if (!config.risk.partialTp || tiers.length === 0) return [];

  const plans: ScaleOut[] = [];
  for (const p of positions) {
    const m = markets.get(p.epic);
    if (!m || !p.level) continue;
    // Exit price: sell a long at the bid, buy back a short at the offer.
    const exit = p.direction === "BUY" ? m.bid : m.offer;
    if (!exit || exit <= 0) continue;
    const profitPct =
      p.direction === "BUY"
        ? ((exit - p.level) / p.level) * 100
        : ((p.level - exit) / p.level) * 100;
    if (profitPct <= 0) continue;

    let e = state[p.dealId];
    if (!e) e = state[p.dealId] = { originalSize: p.size, fired: 0 };

    let crossed = 0;
    for (const t of tiers) if (profitPct >= t.profitPct) crossed++;
    if (crossed <= e.fired) continue;

    let pct = 0;
    for (let i = e.fired; i < crossed; i++) pct += tiers[i]!.closePct;
    let size = roundToStep((e.originalSize * pct) / 100, m.minDealSize);
    if (size < m.minDealSize) continue; // chunk too small to close — wait (don't advance)

    let fullClose = false;
    if (size >= p.size || p.size - size < m.minDealSize) {
      size = p.size;
      fullClose = true;
    }

    // Realised P/L on the banked chunk: price move from entry × size × contract
    // size (gross, consistent with how close/uPL P/L is recorded elsewhere).
    const pnl = round2(
      (p.direction === "BUY" ? exit - p.level : p.level - exit) * size * m.contractSize,
    );

    plans.push({
      dealId: p.dealId,
      epic: p.epic,
      direction: p.direction,
      size,
      tier: crossed,
      profitPct: round2(profitPct),
      fullClose,
      entry: p.level,
      pnl,
    });
    e.fired = crossed;
  }
  return plans;
}
