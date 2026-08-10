import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import { log } from "../logger.js";
import { loadTrades, type ClosedTrade } from "./trades.js";
import { metrics, learningTrend } from "./stats.js";

/**
 * Go-live readiness gauge: a set of OBJECTIVE, demo-account criteria that should
 * all pass before even considering trading real money. Computed purely from the
 * trade ledger. The loop auto-alerts (once) the first time everything passes, so
 * the user gets a milestone ping instead of having to eyeball the stats.
 */

export interface ReadinessCheck {
  label: string;
  ok: boolean;
  detail: string;
}
export interface ReadinessResult {
  ready: boolean;
  passed: number;
  total: number;
  checks: ReadinessCheck[];
}

// Thresholds — deliberately conservative; live money is unforgiving.
const MIN_SAMPLE = 30; // scored round-trips before stats are meaningful
const MIN_WIN_RATE = 0.45;
const MIN_PROFIT_FACTOR = 1.3;
const MIN_EXPECTANCY_R = 0.1;
const MAX_DRAWDOWN_PCT = 10; // peak-to-trough on the closed-trade equity curve, % of balance

export async function computeReadiness(
  balance: number,
  closed?: ClosedTrade[],
): Promise<ReadinessResult> {
  const trades = closed ?? (await loadTrades()).closed;
  const m = metrics(trades);
  const trend = learningTrend(trades);
  const ddPct = balance > 0 ? (m.maxDrawdown / balance) * 100 : 0;
  const notWorse = trend.hasData && trend.recent.expectancy >= trend.early.expectancy;

  const checks: ReadinessCheck[] = [
    { label: `样本量 ≥${MIN_SAMPLE} 笔`, ok: m.n >= MIN_SAMPLE, detail: `${m.n}/${MIN_SAMPLE}` },
    { label: "正期望 (>0)", ok: m.n > 0 && m.expectancy > 0, detail: m.expectancy.toFixed(2) },
    {
      label: `盈亏比 ≥${MIN_PROFIT_FACTOR}`,
      ok: (m.profitFactor ?? 99) >= MIN_PROFIT_FACTOR,
      detail: m.profitFactor === null ? "∞" : m.profitFactor.toFixed(2),
    },
    {
      label: `胜率 ≥${Math.round(MIN_WIN_RATE * 100)}%`,
      ok: m.winRate >= MIN_WIN_RATE,
      detail: `${Math.round(m.winRate * 100)}%`,
    },
    {
      label: `R期望 ≥${MIN_EXPECTANCY_R}R`,
      ok: m.expectancyR !== null && m.expectancyR >= MIN_EXPECTANCY_R,
      detail: m.expectancyR === null ? "无R数据" : `${m.expectancyR.toFixed(2)}R`,
    },
    {
      label: `最大回撤 ≤${MAX_DRAWDOWN_PCT}%`,
      ok: m.n > 0 && ddPct <= MAX_DRAWDOWN_PCT,
      detail: `${ddPct.toFixed(1)}%`,
    },
    {
      label: "学习趋势不恶化",
      ok: notWorse,
      detail: trend.hasData
        ? `早${trend.early.expectancy.toFixed(1)}→近${trend.recent.expectancy.toFixed(1)}`
        : "样本不足",
    },
  ];

  const passed = checks.filter((c) => c.ok).length;
  return { ready: passed === checks.length, passed, total: checks.length, checks };
}

/** Render the checklist as a Chinese Telegram/log message. */
export function renderReadiness(r: ReadinessResult): string {
  const tag = config.mode === "live" ? "真钱 💰" : "模拟账户";
  const lines = [`🚦 切真钱自检清单 [${tag}]　${r.passed}/${r.total} 达标`, ``];
  for (const c of r.checks) lines.push(`${c.ok ? "✅" : "❌"} ${c.label}：${c.detail}`);
  lines.push("");
  lines.push(
    r.ready
      ? "🎉 全部达标！可以【考虑】切真钱。建议：先把资金部署比例(CAPITAL_DEPLOY_PCT)调低、用最小仓位试跑，确认无误再逐步加大。"
      : "⏳ 尚未全部达标，继续在 demo 上积累。达标前不建议切真钱。",
  );
  return lines.join("\n");
}

// --- one-shot milestone alert (persists a flag so it never spams) ---

const STATE_FILE = process.env.LEDGER_DIR
  ? join(process.env.LEDGER_DIR, "readiness-state.json")
  : fileURLToPath(new URL("../../readiness-state.json", import.meta.url));

async function loadNotified(): Promise<boolean> {
  try {
    const s = JSON.parse(await readFile(STATE_FILE, "utf8")) as { notifiedReady?: boolean };
    return s.notifiedReady === true;
  } catch {
    return false;
  }
}
async function saveNotified(notifiedReady: boolean): Promise<void> {
  try {
    await writeFile(STATE_FILE, JSON.stringify({ notifiedReady, at: new Date().toISOString() }, null, 2));
  } catch (e) {
    log.warn("Failed to persist readiness state:", (e as Error).message);
  }
}

/**
 * Compute readiness and, the FIRST time everything passes, fire a milestone
 * notification. Resets the flag if it later falls out of readiness, so a genuine
 * re-qualification can alert again. Never throws.
 */
export async function maybeAlertReadiness(
  balance: number,
  closed: ClosedTrade[],
  send: (msg: string) => Promise<void>,
): Promise<ReadinessResult> {
  const r = await computeReadiness(balance, closed);
  try {
    const alreadyNotified = await loadNotified();
    if (r.ready && !alreadyNotified) {
      await send("🎉 capitaltinking 里程碑：切真钱自检【全部达标】！\n\n" + renderReadiness(r));
      await saveNotified(true);
    } else if (!r.ready && alreadyNotified) {
      await saveNotified(false);
    }
  } catch (e) {
    log.warn("Readiness alert failed:", (e as Error).message);
  }
  return r;
}
