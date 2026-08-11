import { readFile } from "node:fs/promises";
import { AUDIT_FILE } from "../logger.js";
import type { Regime, Setup } from "../brain/deepseek.js";
import type { DevilVerdict } from "../brain/devil.js";

/**
 * Trade reconstruction from the append-only audit log (trades.log.jsonl).
 *
 * The log records these event kinds we care about here:
 *   - "open":    a position we opened (carries regime/setup/confidence/entry/dealId)
 *   - "close":   a position that closed (carries realised pnl + dealId)
 *   - "partial": a scale-out that banked PART of a still-open winner (carries the
 *                banked pnl + dealId). These are folded into the round-trip's total
 *                so scaled-out winners aren't under-counted (which would bias the
 *                EV gate, Kelly sizing and drawdown maths — all read realised P/L).
 * A round-trip trade is an "open" paired with its "close". Pairing is by dealId
 * when available, otherwise FIFO within an epic (legacy records predate dealId
 * capture). Broker-side SL/TP exits are folded in via reconciled "close" events.
 */

export interface OpenRecord {
  at: string;
  dealId?: string;
  dealReference?: string;
  epic: string;
  direction: "BUY" | "SELL";
  size: number;
  entry?: number;
  stopLevel?: number;
  profitLevel?: number;
  riskAmount?: number; // the trade's 1R (loss if stopped), for R-multiple analysis
  confidence: number;
  regime?: Regime;
  setup?: Setup;
  // Devil's Advocate judgment recorded at open time (for veto A/B analysis).
  counterConfidence?: number;
  devilVerdict?: DevilVerdict;
  wouldVeto?: boolean;
  // Second-brain (Qwen) ensemble judgment (for two-brain-agreement A/B).
  secondAgree?: boolean;
}

export interface CloseRecord {
  at: string;
  dealId?: string;
  epic: string;
  pnl?: number; // realised P/L; undefined for legacy closes with no recorded outcome
  exitLevel?: number;
  reason?: string; // "ai" | "reconciled" | ...
}

export interface ClosedTrade {
  open: OpenRecord;
  close: CloseRecord;
  pnl?: number; // full realised P/L = final close P/L + any banked scale-outs
  bankedPartials?: number; // realised P/L already banked via scale-outs (subset of pnl)
  holdMs: number;
}

export interface Reconstruction {
  closed: ClosedTrade[];
  stillOpen: OpenRecord[];
  // Scale-out P/L banked on positions that are STILL OPEN (not yet in a round-trip).
  // Already sits in the account balance; surfaced so reports can reflect it.
  openBankedPnl: number;
}

interface PartialRecord {
  dealId: string;
  pnl: number;
}

function toPartial(e: Record<string, any>): PartialRecord | undefined {
  // Only genuine scale-outs (position stays open) carry banked P/L we must add.
  // A fullClose partial closes the remainder → that chunk becomes a reconciled
  // "close" event carrying its own P/L, so counting it here too would double-count.
  if (e.fullClose || !e.dealId || typeof e.pnl !== "number") return undefined;
  return { dealId: String(e.dealId), pnl: e.pnl };
}

/** Read and JSON-parse the audit log, tolerating blank/corrupt lines. */
export async function readAuditLog(): Promise<Record<string, unknown>[]> {
  let raw: string;
  try {
    raw = await readFile(AUDIT_FILE, "utf8");
  } catch {
    return [];
  }
  const events: Record<string, unknown>[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      events.push(JSON.parse(t));
    } catch {
      // skip malformed line
    }
  }
  return events;
}

function toOpen(e: Record<string, any>): OpenRecord {
  return {
    at: e.at,
    dealId: e.dealId,
    dealReference: e.dealReference,
    epic: String(e.epic).toUpperCase(),
    direction: e.direction,
    size: Number(e.size ?? 0),
    entry: e.entry ?? e.entryLevel,
    stopLevel: e.stopLevel,
    profitLevel: e.profitLevel,
    riskAmount: typeof e.riskAmount === "number" ? e.riskAmount : undefined,
    confidence: Number(e.confidence ?? 0),
    regime: e.regime,
    setup: e.setup,
    counterConfidence: typeof e.counterConfidence === "number" ? e.counterConfidence : undefined,
    devilVerdict: e.devilVerdict,
    wouldVeto: typeof e.wouldVeto === "boolean" ? e.wouldVeto : undefined,
    secondAgree: typeof e.secondAgree === "boolean" ? e.secondAgree : undefined,
  };
}

function toClose(e: Record<string, any>): CloseRecord {
  return {
    at: e.at,
    dealId: e.dealId,
    epic: String(e.epic).toUpperCase(),
    pnl: typeof e.pnl === "number" ? e.pnl : undefined,
    exitLevel: e.exitLevel,
    reason: e.reason,
  };
}

/**
 * Pair opens with closes into round-trip trades.
 * Primary key: dealId. Fallback: FIFO within the same epic (for legacy records
 * that predate dealId capture). Opens never matched remain in `stillOpen`.
 */
export function reconstructTrades(events: Record<string, unknown>[]): Reconstruction {
  const opens = events.filter((e) => e.event === "open").map(toOpen);
  const closes = events.filter((e) => e.event === "close").map(toClose);

  // Banked scale-out P/L, summed per dealId, to fold into each round-trip's total.
  const partialByDeal = new Map<string, number>();
  for (const e of events) {
    if (e.event !== "partial") continue;
    const p = toPartial(e as Record<string, any>);
    if (p) partialByDeal.set(p.dealId, (partialByDeal.get(p.dealId) ?? 0) + p.pnl);
  }

  const openByDeal = new Map<string, OpenRecord>();
  const unmatched: OpenRecord[] = [];
  for (const o of opens) {
    if (o.dealId) openByDeal.set(o.dealId, o);
    else unmatched.push(o);
  }

  const closed: ClosedTrade[] = [];
  const consumed = new Set<OpenRecord>();

  const pair = (o: OpenRecord, c: CloseRecord) => {
    consumed.add(o);
    // Full realised P/L = the final close's P/L + everything banked via scale-outs
    // before it. Keep undefined only when neither piece carries a number (legacy).
    const banked = o.dealId ? partialByDeal.get(o.dealId) : undefined;
    const pnl =
      c.pnl === undefined && banked === undefined ? undefined : (c.pnl ?? 0) + (banked ?? 0);
    closed.push({
      open: o,
      close: c,
      pnl,
      bankedPartials: banked,
      holdMs: Math.max(0, new Date(c.at).getTime() - new Date(o.at).getTime()),
    });
  };

  // Pass 1: claim every open that has an exact dealId match FIRST, so a
  // legacy FIFO close can never steal a dealId'd open out from under its own
  // close (which can happen when the two are interleaved in log order).
  const remaining: CloseRecord[] = [];
  for (const c of closes) {
    const o = c.dealId ? openByDeal.get(c.dealId) : undefined;
    if (o && !consumed.has(o)) pair(o, c);
    else remaining.push(c);
  }

  // Pass 2: FIFO fallback for closes without a (matched) dealId — oldest
  // still-unconsumed open on the same epic.
  for (const c of remaining) {
    const candidate = opens
      .filter((o) => !consumed.has(o) && o.epic === c.epic)
      .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime())[0];
    if (candidate) pair(candidate, c);
    // else: a close with no matching open — ignore (nothing we can attribute)
  }

  const stillOpen = opens.filter((o) => !consumed.has(o));
  // Scale-out P/L already banked on positions that haven't closed yet (their
  // round-trip isn't in `closed`, but the cash is real and in the balance).
  let openBankedPnl = 0;
  const openDeals = new Set(stillOpen.map((o) => o.dealId).filter(Boolean) as string[]);
  for (const [dealId, pnl] of partialByDeal) if (openDeals.has(dealId)) openBankedPnl += pnl;
  void unmatched;
  return { closed, stillOpen, openBankedPnl: Math.round(openBankedPnl * 100) / 100 };
}

/** Convenience: read the log from disk and reconstruct in one call. */
export async function loadTrades(): Promise<Reconstruction> {
  return reconstructTrades(await readAuditLog());
}
