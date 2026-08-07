import { log } from "../logger.js";

/**
 * Best-effort push notifier. Never throws — a failed notification must never
 * interrupt or crash a trading cycle.
 *
 * Providers, auto-selected by which env vars are set (in priority order):
 *   1. Telegram   (recommended: free, instant, reliable)
 *   2. Twilio     (production-grade WhatsApp)
 *   3. CallMeBot  (free WhatsApp, but often slow/unreliable)
 *
 * Configure ONE in .env. If none is set, notifications are skipped.
 */

interface TelegramCfg {
  kind: "telegram";
  token: string;
  chatId: string;
}
interface TwilioCfg {
  kind: "twilio";
  accountSid: string;
  authToken: string;
  from: string;
  to: string;
}
interface CallMeBotCfg {
  kind: "callmebot";
  phone: string;
  apikey: string;
}
type NotifierCfg = TelegramCfg | TwilioCfg | CallMeBotCfg | { kind: "none" };

function resolveConfig(): NotifierCfg {
  const e = process.env;
  if (e.TELEGRAM_BOT_TOKEN && e.TELEGRAM_CHAT_ID) {
    return { kind: "telegram", token: e.TELEGRAM_BOT_TOKEN, chatId: e.TELEGRAM_CHAT_ID };
  }
  if (
    e.TWILIO_ACCOUNT_SID &&
    e.TWILIO_AUTH_TOKEN &&
    e.TWILIO_WHATSAPP_FROM &&
    e.WHATSAPP_TO
  ) {
    const wa = (s: string) => (s.startsWith("whatsapp:") ? s : `whatsapp:${s}`);
    return {
      kind: "twilio",
      accountSid: e.TWILIO_ACCOUNT_SID,
      authToken: e.TWILIO_AUTH_TOKEN,
      from: wa(e.TWILIO_WHATSAPP_FROM),
      to: wa(e.WHATSAPP_TO),
    };
  }
  if (e.CALLMEBOT_PHONE && e.CALLMEBOT_APIKEY) {
    return { kind: "callmebot", phone: e.CALLMEBOT_PHONE, apikey: e.CALLMEBOT_APIKEY };
  }
  return { kind: "none" };
}

const cfg = resolveConfig();
let warnedOnce = false;

export function notifyEnabled(): boolean {
  return cfg.kind !== "none";
}
export function notifyProvider(): string {
  return cfg.kind;
}

async function sendTelegram(c: TelegramCfg, body: string): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${c.token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: c.chatId, text: body, disable_web_page_preview: true }),
  });
  if (!res.ok) throw new Error(`Telegram ${res.status}: ${await res.text()}`);
}

async function sendTwilio(c: TwilioCfg, body: string): Promise<void> {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${c.accountSid}/Messages.json`;
  const form = new URLSearchParams({ From: c.from, To: c.to, Body: body });
  const auth = Buffer.from(`${c.accountSid}:${c.authToken}`).toString("base64");
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form,
  });
  if (!res.ok) throw new Error(`Twilio ${res.status}: ${await res.text()}`);
}

async function sendCallMeBot(c: CallMeBotCfg, body: string): Promise<void> {
  const url = new URL("https://api.callmebot.com/whatsapp.php");
  url.searchParams.set("phone", c.phone);
  url.searchParams.set("text", body);
  url.searchParams.set("apikey", c.apikey);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`CallMeBot ${res.status}: ${await res.text()}`);
}

/** Send a push notification. Never throws. */
export async function notify(message: string): Promise<void> {
  if (cfg.kind === "none") {
    if (!warnedOnce) {
      log.warn("Notifications disabled (no provider configured in .env)");
      warnedOnce = true;
    }
    return;
  }
  try {
    if (cfg.kind === "telegram") await sendTelegram(cfg, message);
    else if (cfg.kind === "twilio") await sendTwilio(cfg, message);
    else await sendCallMeBot(cfg, message);
    log.info(`Notification sent via ${cfg.kind}`);
  } catch (e) {
    log.warn(`Notification failed (${cfg.kind}):`, (e as Error).message);
  }
}

/**
 * Helper for `--telegram-setup`: given only TELEGRAM_BOT_TOKEN, poll getUpdates
 * and print any chat IDs that have messaged the bot, so the user can copy theirs.
 */
export async function telegramFindChatIds(): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    log.error("Set TELEGRAM_BOT_TOKEN in .env first (from @BotFather).");
    return;
  }
  const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates`);
  if (!res.ok) {
    log.error(`getUpdates failed ${res.status}: ${await res.text()}`);
    return;
  }
  const data = (await res.json()) as { result: any[] };
  const chats = new Map<string, string>();
  for (const u of data.result ?? []) {
    const chat = u.message?.chat ?? u.channel_post?.chat;
    if (chat) {
      const who = chat.username ?? chat.title ?? `${chat.first_name ?? ""} ${chat.last_name ?? ""}`.trim();
      chats.set(String(chat.id), who || "(unknown)");
    }
  }
  if (chats.size === 0) {
    log.warn("No chats found. Open Telegram, send your bot any message, then re-run this.");
    return;
  }
  log.ok("Found these chat IDs — put yours in .env as TELEGRAM_CHAT_ID:");
  for (const [id, who] of chats) log.info(`  ${id}  (${who})`);
}
