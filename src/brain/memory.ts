import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "../logger.js";

/**
 * The brain's PERSISTENT memory — how the bot "keeps learning" the global market
 * without any model fine-tuning. Each cycle the brain reads its accumulated
 * understanding (a running macro thesis + a rolling list of hard-won lessons),
 * trades, then writes back an updated thesis and any new lessons. Knowledge
 * therefore COMPOUNDS across cycles and survives restarts (stored on the same
 * persistent volume as the trade ledger, LEDGER_DIR=/data on Fly).
 */

export interface BrainMemory {
  updatedAt: string;
  thesis: string; // the brain's current running view of the global market
  lessons: string[]; // rolling, deduped list of reusable trading lessons (newest first)
}

const MEMORY_FILE = process.env.LEDGER_DIR
  ? join(process.env.LEDGER_DIR, "brain-memory.json")
  : fileURLToPath(new URL("../../brain-memory.json", import.meta.url));

const MAX_LESSONS = 25;
const MAX_LESSON_LEN = 240;
const MAX_THESIS_LEN = 900;
const EMPTY: BrainMemory = { updatedAt: "", thesis: "", lessons: [] };

/** Load the brain's memory from disk. Never throws — missing/corrupt → empty. */
export async function loadBrainMemory(): Promise<BrainMemory> {
  try {
    const m = JSON.parse(await readFile(MEMORY_FILE, "utf8")) as Partial<BrainMemory>;
    return {
      updatedAt: typeof m.updatedAt === "string" ? m.updatedAt : "",
      thesis: typeof m.thesis === "string" ? m.thesis : "",
      lessons: Array.isArray(m.lessons)
        ? m.lessons.filter((x): x is string => typeof x === "string")
        : [],
    };
  } catch {
    return { ...EMPTY };
  }
}

/**
 * Fold a cycle's learning into memory and persist it. Keeps the latest thesis,
 * prepends new lessons, dedupes case-insensitively, and caps the list so the
 * prompt stays bounded. Never throws — a write failure must not break trading.
 */
export async function updateBrainMemory(
  prev: BrainMemory,
  update: { thesis?: string; lessons?: string[] },
): Promise<BrainMemory> {
  const thesis = (update.thesis?.trim() || prev.thesis).slice(0, MAX_THESIS_LEN);
  const incoming = (update.lessons ?? [])
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.slice(0, MAX_LESSON_LEN));

  const merged: string[] = [];
  const seen = new Set<string>();
  for (const l of [...incoming, ...prev.lessons]) {
    const k = l.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    merged.push(l);
    if (merged.length >= MAX_LESSONS) break;
  }

  const next: BrainMemory = { updatedAt: new Date().toISOString(), thesis, lessons: merged };
  try {
    await writeFile(MEMORY_FILE, JSON.stringify(next, null, 2));
  } catch (e) {
    log.warn("Failed to persist brain memory:", (e as Error).message);
  }
  return next;
}

/** Render memory as a compact prompt block (top lessons only); "" when empty. */
export function describeBrainMemory(m: BrainMemory): string {
  if (!m.thesis && m.lessons.length === 0) return "";
  const parts: string[] = [];
  if (m.thesis) parts.push(`你当前对全球市场的判断(thesis)：${m.thesis}`);
  if (m.lessons.length) {
    const top = m.lessons.slice(0, 12).map((l, i) => `  ${i + 1}. ${l}`).join("\n");
    parts.push(`你积累的交易经验(lessons，越靠前越新)：\n${top}`);
  }
  return parts.join("\n");
}
