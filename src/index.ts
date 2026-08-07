import { config } from "./config.js";
import { log, audit } from "./logger.js";
import { CapitalClient, type MarketSnapshot } from "./capital/client.js";
import { fetchLatestNews } from "./news/fetch.js";
import { think } from "./brain/deepseek.js";
import { applyRisk, type RiskResult } from "./risk/guard.js";
import { notify, notifyEnabled, notifyProvider, telegramFindChatIds } from "./notify/notify.js";
import { buildDailyReport } from "./analytics/report.js";
import type { BrainOutput } from "./brain/deepseek.js";

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
    `  notify: ${notifyEnabled() ? `on (${notifyProvider()}, on=${config.notify.verbosity})` : "off"}`,
  );
  log.info("──────────────────────────────────────────────");
}

/** 生成本轮决策的中文 Telegram 通知。 */
function buildNotification(brain: BrainOutput, risk: RiskResult, balance: number): string {
  const tag = config.dryRun ? "模拟(不下单)" : config.mode === "live" ? "真钱 💰" : "模拟账户";
  const dir = (d: "BUY" | "SELL") => (d === "BUY" ? "买入" : "卖出");
  const lines: string[] = [`🧠 capitaltinking [${tag}]`, `账户余额：${balance}`];

  if (brain.marketSummary && brain.marketSummary !== "parse-error") {
    lines.push("", `📰 行情摘要：${brain.marketSummary}`);
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

async function runCycle(client: CapitalClient): Promise<void> {
  await client.login();

  const account = await client.getAccount();
  log.info(`Account balance: ${account.balance} ${account.currency} (available ${account.available})`);

  const positions = await client.getPositions();
  const news = await fetchLatestNews();

  // Snapshot prices for every allowed instrument.
  const markets = new Map<string, MarketSnapshot>();
  const snapshots: MarketSnapshot[] = [];
  for (const epic of config.risk.allowedEpics) {
    try {
      const m = await client.getMarket(epic);
      // Enrich with multi-day trend so the brain distinguishes trend from noise.
      try {
        const closes = await client.getHistoricalCloses(epic, config.trendDays);
        if (closes.length >= 2) {
          const first = closes[0]!;
          const last = closes[closes.length - 1]!;
          m.trendCloses = closes.map((c) => round2(c));
          m.trendPct = first ? ((last - first) / first) * 100 : 0;
        }
      } catch (e) {
        log.warn(`No history for ${epic}:`, (e as Error).message);
      }
      markets.set(epic, m);
      snapshots.push(m);
    } catch (e) {
      log.warn(`Could not fetch market ${epic}:`, (e as Error).message);
    }
  }

  // The brain thinks.
  const brain = await think(news, snapshots, positions, account.balance);
  log.info(`Market summary: ${brain.marketSummary}`);
  if (brain.analysis) log.info(`Analysis: ${brain.analysis}`);
  for (const d of brain.decisions) {
    log.info(`  DeepSeek: ${d.epic} -> ${d.action} (conf ${d.confidence.toFixed(2)}) — ${d.reasoning}`);
  }

  // The risk gate decides what is actually permitted.
  const risk = applyRisk(brain.decisions, account, positions, markets);
  for (const rj of risk.rejected) log.warn(`  Rejected ${rj.epic}: ${rj.reason}`);

  await audit({
    event: "cycle",
    mode: config.mode,
    dryRun: config.dryRun,
    balance: account.balance,
    summary: brain.marketSummary,
    decisions: brain.decisions,
    approved: risk.approved,
    closes: risk.closes,
    rejected: risk.rejected,
  });

  // Execute closes.
  for (const c of risk.closes) {
    if (config.dryRun) {
      log.info(`  [DRY_RUN] would CLOSE ${c.epic} (${c.dealId}) — ${c.reasoning}`);
    } else {
      await client.closePosition(c.dealId);
      log.ok(`  CLOSED ${c.epic} (${c.dealId})`);
      await audit({ event: "close", epic: c.epic, dealId: c.dealId });
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
      log.ok(`  OPENED ${t.direction} ${t.epic} size ${t.size} (${stopDesc}) (ref ${dealReference})`);
      await audit({ event: "open", ...t, trailing: config.risk.useTrailingStop, dealReference });
    }
  }

  if (risk.approved.length === 0 && risk.closes.length === 0) {
    log.info("No trades this cycle — holding.");
  }

  // Notify. In "actions" mode, stay quiet on pure-HOLD cycles.
  const hadAction = risk.approved.length > 0 || risk.closes.length > 0;
  if (notifyEnabled() && (config.notify.verbosity === "all" || hadAction)) {
    await notify(buildNotification(brain, risk, account.balance));
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

  if (args.includes("--loop")) {
    const intervalMs = config.loopIntervalMinutes * 60_000;
    log.info(`Loop mode: every ${config.loopIntervalMinutes} min. Ctrl-C to stop.`);
    // Run immediately, then on interval.
    const tick = async () => {
      try {
        await runCycle(client);
        await maybeSendDailyReport(client);
      } catch (e) {
        log.error("Cycle failed:", (e as Error).message);
      }
    };
    await tick();
    setInterval(tick, intervalMs);
    return;
  }

  // Default: single cycle (--once or no flag).
  await runCycle(client);
}

main().catch((e) => {
  log.error(e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});
