import { config } from "../config.js";
import type { CapitalClient, Account, OpenPosition } from "../capital/client.js";

/** Parse a Capital.com money string like "USD12.34" or "-5.6" into a number. */
function parsePnl(s: string): number {
  const m = s.match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : 0;
}

/** Build today's Chinese review report from realised transactions + open positions. */
export async function buildDailyReport(
  client: CapitalClient,
  account: Account,
  positions: OpenPosition[],
): Promise<string> {
  const now = new Date();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const fromIso = start.toISOString();
  const toIso = now.toISOString();

  let realised = 0;
  let wins = 0;
  let losses = 0;
  let trades = 0;
  try {
    const txns = await client.getTransactions(fromIso, toIso);
    for (const t of txns) {
      const pnl = parsePnl(t.profitAndLoss);
      // count only entries that carry a realised P/L (i.e. closed trades)
      if (pnl !== 0) {
        realised += pnl;
        trades++;
        if (pnl > 0) wins++;
        else losses++;
      }
    }
  } catch {
    // history endpoint may be unavailable; fall back to just balance + positions
  }

  const winRate = trades > 0 ? Math.round((wins / trades) * 100) : 0;
  const openUpl = positions.reduce((s, p) => s + (p.upl ?? 0), 0);
  const sign = (n: number) => (n >= 0 ? "+" : "");
  const tag = config.mode === "live" ? "真钱 💰" : "模拟账户";
  const dateStr = now.toLocaleDateString("zh-CN");

  const lines = [
    `📊 每日复盘 ${dateStr} [${tag}]`,
    ``,
    `账户余额：${account.balance} ${account.currency}（可用 ${account.available}）`,
    `今日已平仓盈亏：${sign(realised)}${realised.toFixed(2)}`,
    `今日成交笔数：${trades}　胜/负：${wins}/${losses}　胜率：${winRate}%`,
    `当前持仓浮动盈亏：${sign(openUpl)}${openUpl.toFixed(2)}`,
  ];

  if (positions.length) {
    lines.push(``, `持仓明细：`);
    for (const p of positions) {
      const d = p.direction === "BUY" ? "多" : "空";
      lines.push(`• ${p.epic} ${d} ${p.size}手 @ ${p.level}，浮盈亏 ${sign(p.upl)}${p.upl.toFixed(2)}`);
    }
  } else {
    lines.push(``, `当前无持仓。`);
  }

  const total = realised + openUpl;
  lines.push("");
  if (trades === 0 && positions.length === 0) {
    lines.push(`今日无交易活动。`);
  } else if (total >= 0) {
    lines.push(`今日整体（含浮动）：${sign(total)}${total.toFixed(2)}，小赚不飘。`);
  } else {
    lines.push(`今日整体（含浮动）：${total.toFixed(2)}。亏损是正常波动，切勿追单。`);
  }
  lines.push(`提醒：模拟盈利不代表真钱能复制，继续观察胜率与回撤。`);

  return lines.join("\n");
}
