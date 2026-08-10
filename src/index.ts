import { config } from "./config.js";
import { log, audit } from "./logger.js";
import { CapitalClient, type MarketSnapshot } from "./capital/client.js";
import { fetchLatestNews } from "./news/fetch.js";
import { think, type BrainOutput } from "./brain/deepseek.js";
import { callQwen } from "./brain/client.js";
import { computeIndicators } from "./brain/indicators.js";
import { combineBrains, type EnsembleResult } from "./brain/ensemble.js";
import { challenge, applyDevilVeto, type DevilResult } from "./brain/devil.js";
import { applyRisk, type RiskResult } from "./risk/guard.js";
import { checkCircuitBreakers, type BreakerStatus } from "./risk/breakers.js";
import { notify, notifyEnabled, notifyProvider, telegramFindChatIds } from "./notify/notify.js";
import { buildDailyReport } from "./analytics/report.js";
import { buildStatsReport, buildPerfHint } from "./analytics/stats.js";
import { loadTrades } from "./analytics/trades.js";
import type { OpenPosition, Transaction } from "./capital/client.js";

function banner() {
  const live = config.mode === "live";
  const wet = !config.dryRun;
  log.info("──────────────────────────────────────────────");
  log.info(`  capitaltinking  |  mode=${config.mode.toUpperCase()}  dryRun=${config.dryRun}`);
  if (live && wet) {
    log.warn("  ⚠️  LIVE + REAL ORDERS: this WILL trade real money.");
  } else if (live) {
    log.warn("  LIVE account, but DRY_RUN — no orders will be sent.");
  } else {
    log.ok("  DEMO account — safe to experiment.");
  }
  log.info(`  allowed: ${config.risk.allowedEpics.join(", ")}`);
  log.info(
    `  brains: DeepSeek(${config.deepseek.model})${config.secondBrain.enabled ? ` + Qwen(${config.secondBrain.model}, ${config.secondBrain.mode})` : ""}`,
  );
  log.info(
    `  devil: ${config.brain.devilAdvocate ? `on (${config.brain.devilMode}, veto≥${config.brain.vetoThreshold})` : "off"}`,
  );
  log.info(
    `  notify: ${notifyEnabled() ? `on (${notifyProvider()}, on=${config.notify.verbosity})` : "off"}`,
  );
  log.info("──────────────────────────────────────────────");
}

/** 生成本轮决策的中文 Telegram 通知。 */
function buildNotification(
  brain: BrainOutput,
  risk: RiskResult,
  balance: number,
  devil?: DevilResult,
  breakers?: BreakerStatus,
  ensemble?: EnsembleResult,
): string {
  const tag = config.dryRun ? "模拟(不下单)" : config.mode === "live" ? "真钱 💰" : "模拟账户";
  const dir = (d: "BUY" | "SELL") => (d === "BUY" ? "买入" : "卖出");
  const lines: string[] = [`🧠 capitaltinking [${tag}]`, `账户余额：${balance}`];

  if (breakers?.active) {
    lines.push("", `🛑 风控熔断（暂停开新仓）：${breakers.reason}`);
  }

  if (ensemble) {
    const dis = ensemble.agreements.filter((a) => !a.agree);
    if (dis.length) {
      lines.push("", "⚖️ 双脑分歧：");
      for (const a of dis) lines.push(`• ${a.epic}：DeepSeek ${a.primary} / Qwen ${a.second}`);
    }
  }

  if (brain.marketSummary && brain.marketSummary !== "parse-error") {
    lines.push("", `📰 行情摘要：${brain.marketSummary}`);
  }

  if (devil && devil.vetoes.length) {
    const verb = config.brain.devilMode === "enforce" ? "否决" : "标记否决(观察中，仍开仓)";
    lines.push("", `😈 反方${verb}：`);
    for (const v of devil.vetoes) {
      lines.push(`• ${v.epic}（counter ${v.counterConfidence.toFixed(2)}）— ${v.rebuttal}`);
    }
  }

  if (risk.closes.length) {
    lines.push("", "❌ 平仓：");
    for (const c of risk.closes) lines.push(`• ${c.epic} — ${c.reasoning}`);
  }
  if (risk.approved.length) {
    lines.push("", config.dryRun ? "📝 本应开仓：" : "✅ 已开仓：");
    for (const t of risk.approved) {
      lines.push(
        `• ${dir(t.direction)} ${t.epic} x${t.size}（信心 ${t.confidence.toFixed(2)}）止损 ${t.stopLevel} / 止盈 ${t.profitLevel}\n  ${t.reasoning}`,
      );
    }
  }
  if (risk.rejected.length) {
    lines.push("", "🚫 被风控拦下：");
    for (const r of risk.rejected) lines.push(`• ${r.epic} — ${r.reason}`);
  }
  if (!risk.closes.length && !risk.approved.length) {
    lines.push("", "😴 本轮不交易，继续观望。");
  }
  return lines.join("\n");
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// ── Notification batching ────────────────────────────────────────────────────
// A fast trading loop shouldn't message you every cycle. Instead we QUEUE each
// cycle's action summary and flush at most once per NOTIFY_INTERVAL_MINUTES
// (default 2h): all actions in the window are sent together, and if nothing
// happened a short heartbeat check-in goes out so you know it's alive.
const NOTIFY_INTERVAL_MS = config.notify.intervalMinutes * 60_000;
let lastNotifyAt = 0;
let lastBalance: number | undefined;
const notifyQueue: string[] = [];

function queueNotification(msg: string): void {
  notifyQueue.push(msg);
}

async function flushNotifications(opts: { force?: boolean } = {}): Promise<void> {
  if (!notifyEnabled()) {
    notifyQueue.length = 0;
    return;
  }
  const now = Date.now();
  if (!opts.force && now - lastNotifyAt < NOTIFY_INTERVAL_MS) return;

  const stamp = new Date().toLocaleString("zh-CN", { hour12: false });
  let body: string;
  if (notifyQueue.length) {
    const header = `🧠 capitaltinking 定时汇报（每 ${config.notify.intervalMinutes} 分钟）· ${stamp}`;
    body = [header, ...notifyQueue].join("\n\n———\n\n");
  } else {
    // Heartbeat: nothing traded this window — a brief "still watching" check-in.
    body =
      `🧠 capitaltinking 定时汇报（每 ${config.notify.intervalMinutes} 分钟）· ${stamp}\n` +
      (lastBalance != null ? `账户余额：${lastBalance}\n` : "") +
      "😴 期间没有触发交易，持续观望中。";
  }
  await notify(body);
  notifyQueue.length = 0;
  lastNotifyAt = now;
}

// Daily report is sent once per calendar day, on/after config.reportHour.
let lastReportDate = "";

async function maybeSendDailyReport(client: CapitalClient): Promise<void> {
  const today = new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD
  if (today === lastReportDate) return;
  if (new Date().getHours() < config.reportHour) return;
  try {
    const account = await client.getAccount();
    const positions = await client.getPositions();
    const report = await buildDailyReport(client, account, positions);
    log.info(report);
    if (notifyEnabled()) await notify(report);
    lastReportDate = today;
  } catch (e) {
    log.warn("Daily report failed:", (e as Error).message);
  }
}

async function showStatus(client: CapitalClient) {
  await client.login();
  const account = await client.getAccount();
  const positions = await client.getPositions();
  log.info(`Account ${account.accountId}: balance ${account.balance} ${account.currency}, available ${account.available}`);
  if (positions.length === 0) log.info("No open positions.");
  for (const p of positions) {
    log.info(`  ${p.epic}: ${p.direction} size ${p.size} @ ${p.level}  uPL ${p.upl}`);
  }
}

/** Parse a Capital.com money string like "USD12.34" or "-5.6" into a number. */
function parseMoney(s: string): number {
  const m = s.match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : 0;
}

/**
 * Detect positions we opened that have since vanished from the account — i.e.
 * closed by the broker's stop-loss / take-profit while no cycle was running.
 * Without this, every SL/TP exit is invisible to the audit log and silently
 * excluded from win-rate. We recover each one's realised P/L from transaction
 * history and write a synthetic "close" so the analytics stay honest.
 */
async function reconcileExits(
  client: CapitalClient,
  positions: OpenPosition[],
): Promise<void> {
  const { stillOpen } = await loadTrades();
  const live = new Set(positions.map((p) => p.dealId));
  const vanished = stillOpen.filter((o) => o.dealId && !live.has(o.dealId));
  if (vanished.length === 0) return;

  // Pull transactions since the oldest vanished open, to source realised P/L.
  const oldest = vanished.reduce(
    (min, o) => (o.at < min ? o.at : min),
    vanished[0]!.at,
  );
  let txns: Transaction[];
  try {
    txns = await client.getTransactions(oldest, new Date().toISOString());
  } catch (e) {
    log.warn("Reconcile: could not load transactions:", (e as Error).message);
    txns = [];
  }
  // Realised-P/L transactions, oldest first, for FIFO attribution per instrument.
  const pnlTxns = txns
    .filter((t) => parseMoney(t.profitAndLoss) !== 0)
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  const consumed = new Set<number>();

  // Resolve each vanished epic to its Capital instrument name for matching.
  const nameByEpic = new Map<string, string>();
  for (const o of vanished) {
    if (nameByEpic.has(o.epic)) continue;
    try {
      nameByEpic.set(o.epic, (await client.getMarket(o.epic)).instrumentName);
    } catch {
      nameByEpic.set(o.epic, o.epic);
    }
  }

  for (const o of vanished.sort((a, b) => (a.at < b.at ? -1 : 1))) {
    const name = nameByEpic.get(o.epic);
    const idx = pnlTxns.findIndex(
      (t, i) => !consumed.has(i) && (t.instrumentName === name || t.instrumentName === o.epic),
    );
    const pnl = idx >= 0 ? parseMoney(pnlTxns[idx]!.profitAndLoss) : undefined;
    if (idx >= 0) consumed.add(idx);
    await audit({
      event: "close",
      epic: o.epic,
      dealId: o.dealId,
      pnl,
      entryLevel: o.entry,
      reason: "reconciled",
    });
    log.info(
      `  Reconciled exit ${o.epic} (${o.dealId}) — realised P/L ${pnl ?? "unknown"}`,
    );
  }
}

async function runCycle(client: CapitalClient): Promise<void> {
  await client.login();

  const account = await client.getAccount();
  lastBalance = account.balance;
  log.info(`Account balance: ${account.balance} ${account.currency} (available ${account.available})`);

  const positions = await client.getPositions();
  // Fold in any broker SL/TP exits that happened between cycles before deciding.
  await reconcileExits(client, positions);

  // Circuit breakers: read the ledger and decide whether new opens are halted.
  const { closed: ledger } = await loadTrades();
  const breakers = checkCircuitBreakers(ledger, account.balance);
  // Feed the brains their own recent track record so they lean into setups/regimes
  // that actually pay (and away from losers) — a lightweight learning loop.
  const perfHint = buildPerfHint(ledger);
  if (perfHint) log.info(`Perf feedback to brain:\n${perfHint}`);
  log.info(
    `Risk budget: 今日 ${breakers.dailyPnl} (亏${breakers.dailyLossPct}%) / 近7日 ${breakers.weeklyPnl} (亏${breakers.weeklyLossPct}%) / 回撤 ${breakers.drawdownPct}%`,
  );
  if (breakers.active) log.warn(`🛑 熔断触发，暂停开新仓：${breakers.reason}`);

  const news = await fetchLatestNews();

  // Snapshot prices for every allowed instrument.
  const markets = new Map<string, MarketSnapshot>();
  const snapshots: MarketSnapshot[] = [];
  for (const epic of config.risk.allowedEpics) {
    try {
      const m = await client.getMarket(epic);
      // Enrich with multi-day trend + technical indicators (the Quant layer) from
      // one price call, so the brain reasons on real momentum/volatility.
      try {
        const bars = await client.getHistoricalBars(epic, "DAY", 60);
        const closes = bars.map((b) => b.close);
        if (closes.length >= 2) {
          const trend = closes.slice(-config.trendDays);
          const first = trend[0]!;
          const last = trend[trend.length - 1]!;
          m.trendCloses = trend.map((c) => round2(c));
          m.trendPct = first ? ((last - first) / first) * 100 : 0;
        }
        m.indicators = computeIndicators(bars);
      } catch (e) {
        log.warn(`No history for ${epic}:`, (e as Error).message);
      }
      markets.set(epic, m);
      snapshots.push(m);
    } catch (e) {
      log.warn(`Could not fetch market ${epic}:`, (e as Error).message);
    }
  }

  // The primary brain (DeepSeek) thinks.
  const brain = await think(news, snapshots, positions, account.balance, perfHint);
  log.info(`Market summary: ${brain.marketSummary}`);
  if (brain.analysis) log.info(`Analysis: ${brain.analysis}`);
  for (const d of brain.decisions) {
    log.info(`  DeepSeek: ${d.epic} -> ${d.action} (conf ${d.confidence.toFixed(2)}) — ${d.reasoning}`);
  }

  let decisions = brain.decisions;

  // Second brain (Qwen) — an independent Chief Trader on a DIFFERENT model.
  // observe: record both + agreement; enforce: a trade needs both to agree.
  let ensemble: EnsembleResult | undefined;
  let second: BrainOutput | undefined;
  if (config.secondBrain.enabled) {
    try {
      second = await think(news, snapshots, positions, account.balance, perfHint, callQwen);
      ensemble = combineBrains(brain, second, config.secondBrain.mode);
      decisions = ensemble.decisions;
      log.info(
        `  Qwen(${config.secondBrain.model}): ${second.decisions.map((d) => `${d.epic} ${d.action}`).join(", ")}`,
      );
      for (const a of ensemble.agreements.filter((x) => !x.agree)) {
        log.info(`  ⚖️ 双脑分歧 ${a.epic}: DeepSeek ${a.primary} vs Qwen ${a.second}`);
      }
    } catch (e) {
      log.warn("Second brain (Qwen) failed, using DeepSeek only:", (e as Error).message);
    }
  }

  // The Devil's Advocate argues against every open proposal (post-ensemble). In
  // "observe" mode it only records its verdict; in "enforce" a veto -> HOLD.
  let devil: DevilResult | undefined;
  if (config.brain.devilAdvocate) {
    const critiques = await challenge({ ...brain, decisions }, news, snapshots);
    devil = applyDevilVeto(decisions, critiques, config.brain.vetoThreshold, config.brain.devilMode);
    decisions = devil.decisions;
    const tag = config.brain.devilMode === "enforce" ? "否决" : "标记否决(观察)";
    for (const v of devil.vetoes) {
      log.warn(`  😈 反方${tag} ${v.epic}（counter ${v.counterConfidence.toFixed(2)}）：${v.rebuttal}`);
    }
    for (const r of devil.reduced) {
      log.info(`  😈 反方建议降信心 ${r.epic} ${r.from} → ${r.to}`);
    }
  }

  // The risk gate decides what is actually permitted (halted opens if breached).
  const risk = applyRisk(decisions, account, positions, markets, {
    active: breakers.active,
    reason: breakers.reason,
  });
  for (const rj of risk.rejected) log.warn(`  Rejected ${rj.epic}: ${rj.reason}`);

  await audit({
    event: "cycle",
    mode: config.mode,
    dryRun: config.dryRun,
    balance: account.balance,
    breakers,
    regime: brain.regime,
    secondBrain: ensemble
      ? { model: config.secondBrain.model, mode: config.secondBrain.mode, decisions: second?.decisions, agreements: ensemble.agreements, disagreements: ensemble.disagreements }
      : undefined,
    summary: brain.marketSummary,
    decisions: brain.decisions, // original Chief Trader judgment (pre-veto)
    devil: devil
      ? { mode: config.brain.devilMode, vetoes: devil.vetoes, reduced: devil.reduced }
      : undefined,
    finalDecisions: decisions, // post-veto (differs from decisions only in enforce mode)
    approved: risk.approved,
    closes: risk.closes,
    rejected: risk.rejected,
  });

  // Execute closes. We record the position's uPL at decision time as the
  // realised P/L — close-at-market makes it effectively realised.
  for (const c of risk.closes) {
    if (config.dryRun) {
      log.info(`  [DRY_RUN] would CLOSE ${c.epic} (${c.dealId}) — ${c.reasoning}`);
    } else {
      await client.closePosition(c.dealId);
      log.ok(`  CLOSED ${c.epic} (${c.dealId}) — P/L ${c.upl}`);
      await audit({
        event: "close",
        epic: c.epic,
        dealId: c.dealId,
        pnl: c.upl,
        entryLevel: c.entry,
        reason: "ai",
      });
    }
  }

  // Execute opens.
  for (const t of risk.approved) {
    const stopDesc = config.risk.useTrailingStop
      ? `trailing SL dist ${t.stopDistance}`
      : `SL ${t.stopLevel}`;
    if (config.dryRun) {
      log.info(
        `  [DRY_RUN] would ${t.direction} ${t.epic} size ${t.size} ${stopDesc} TP ${t.profitLevel} (conf ${t.confidence.toFixed(2)})`,
      );
    } else {
      const order = config.risk.useTrailingStop
        ? {
            epic: t.epic,
            direction: t.direction,
            size: t.size,
            trailingStop: true,
            stopDistance: t.stopDistance,
            profitDistance: t.profitDistance,
          }
        : {
            epic: t.epic,
            direction: t.direction,
            size: t.size,
            stopLevel: t.stopLevel,
            profitLevel: t.profitLevel,
          };
      const { dealReference } = await client.openPosition(order);
      // Resolve the fill so the trade carries a real dealId (join key) + entry.
      const confirm = await client.getDealConfirmation(dealReference);
      const entryLevel = confirm?.level || t.entry;
      log.ok(
        `  OPENED ${t.direction} ${t.epic} size ${t.size} (${stopDesc}) @ ${entryLevel} (ref ${dealReference}${confirm ? `, deal ${confirm.dealId}` : ""})`,
      );
      await audit({
        event: "open",
        ...t,
        entry: entryLevel,
        regime: brain.regime,
        trailing: config.risk.useTrailingStop,
        dealReference,
        dealId: confirm?.dealId,
      });
    }
  }

  if (risk.approved.length === 0 && risk.closes.length === 0) {
    log.info("No trades this cycle — holding.");
  }

  // Notify. In "actions" mode, stay quiet on pure-HOLD cycles. Messages are
  // QUEUED here and flushed on the 2h cadence by the caller (see flushNotifications).
  const hadAction = risk.approved.length > 0 || risk.closes.length > 0;
  if (notifyEnabled() && (config.notify.verbosity === "all" || hadAction)) {
    queueNotification(buildNotification(brain, risk, account.balance, devil, breakers, ensemble));
  }
}

async function main() {
  const args = process.argv.slice(2);
  const client = new CapitalClient();
  banner();

  if (args.includes("--telegram-setup")) {
    await telegramFindChatIds();
    return;
  }

  if (args.includes("--test-notify")) {
    if (!notifyEnabled()) {
      log.warn("No notification provider configured in .env.");
      return;
    }
    await notify("✅ capitaltinking test message — notifications are working.");
    return;
  }

  if (args.includes("--report")) {
    await client.login();
    const account = await client.getAccount();
    const positions = await client.getPositions();
    const report = await buildDailyReport(client, account, positions);
    log.info("\n" + report);
    if (notifyEnabled()) await notify(report);
    return;
  }

  if (args.includes("--status")) {
    await showStatus(client);
    return;
  }

  // Analytics: win-rate by regime / setup / instrument. Reads the audit log,
  // no account needed. Pass --notify to also push it to Telegram.
  if (args.includes("--stats")) {
    const report = await buildStatsReport();
    log.info("\n" + report);
    if (args.includes("--notify") && notifyEnabled()) await notify(report);
    return;
  }

  if (args.includes("--loop")) {
    const intervalMs = config.loopIntervalMinutes * 60_000;
    log.info(`Loop mode: every ${config.loopIntervalMinutes} min. Ctrl-C to stop.`);
    // Run immediately, then on interval.
    log.info(
      `Notifications batched: at most one push every ${config.notify.intervalMinutes} min.`,
    );
    const tick = async () => {
      try {
        await runCycle(client);
        await maybeSendDailyReport(client);
      } catch (e) {
        log.error("Cycle failed:", (e as Error).message);
      }
      // Flush queued action summaries on the 2h cadence (heartbeat if idle).
      await flushNotifications();
    };
    await tick();
    setInterval(tick, intervalMs);
    return;
  }

  // Default: single cycle (--once or no flag). One-shot invocations (e.g. a cron)
  // send their summary immediately rather than waiting for the batch window.
  await runCycle(client);
  await flushNotifications({ force: true });
}

main().catch((e) => {
  log.error(e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});
