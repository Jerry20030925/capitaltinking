# capitaltinking

A news-driven trading assistant for **Capital.com**, using **DeepSeek** as the reasoning
"brain". It fetches today's financial news, asks DeepSeek how the news affects a small
allow-list of instruments, runs the suggestions through a **hard risk gate**, and (optionally)
places trades with automatic stop-loss / take-profit.

## ⚠️ Read this before you do anything

- **No software can guarantee profits.** This is a research/automation tool, not a money
  printer. News-driven trading has no guaranteed edge — the market has usually already
  priced in the news by the time you read it.
- **Capital.com trades leveraged CFDs.** You can lose money quickly.
- Ships **DEMO account + DRY_RUN by default.** In this mode it touches no real money and
  sends no orders — it only logs what it *would* do.
- Going live requires **deliberately** setting `TRADING_MODE=live` **and** `DRY_RUN=false`.
  Do not do this until you have watched it behave over many cycles and you accept the risk.
- Only you can decide whether to risk real money. This tool defaults to keeping you safe.

## How it works

```
news (RSS / NewsAPI)  ─┐
live prices (Capital)  ─┼─►  DeepSeek reasons  ─►  Risk gate  ─►  Execute (or dry-run)  ─►  WhatsApp alert
open positions         ─┘      (suggests)          (decides)       on Capital.com
```

Every cycle is written to an append-only audit log: `trades.log.jsonl`, and (if configured)
sent to your phone via WhatsApp.

## Notifications

After each cycle you get a message with the market summary, what it opened/closed, and
anything the risk gate blocked. Configure **one** provider in `.env` (priority:
Telegram > Twilio > CallMeBot):

**Telegram (recommended — free, instant, reliable):**
1. In Telegram, message **@BotFather**, send `/newbot`, follow the prompts, copy the
   bot **token** into `TELEGRAM_BOT_TOKEN`.
2. Open your new bot and send it any message (e.g. `hi`).
3. Run `npm run telegram-setup` — it prints your chat id. Put it in `TELEGRAM_CHAT_ID`.
4. Test it: `npm run test-notify`.

Other options: **Twilio** (`TWILIO_*` + `WHATSAPP_TO`) or **CallMeBot**
(`CALLMEBOT_PHONE` + `CALLMEBOT_APIKEY`).

`NOTIFY_ON=actions` (default) only messages when a trade actually opens/closes; set it to
`all` to also get pure-HOLD cycles. Notifications are best-effort — a failed send is logged
but never interrupts trading.

## Setup

```bash
npm install
cp .env.example .env      # then fill in your keys
```

Get your keys:
- **Capital.com API key:** log in → Settings → API integrations → Generate API key.
  Use your **demo** account credentials while `TRADING_MODE=demo`.
- **DeepSeek:** https://platform.deepseek.com → API keys.
- **News (optional):** https://newsapi.org for richer news; otherwise free RSS is used.

## Usage

```bash
npm run status     # show account balance + open positions (read-only)
npm run once       # run a single decide-and-(dry)-trade cycle
npm run loop       # run continuously every LOOP_INTERVAL_MINUTES
npm run typecheck  # verify the code compiles
```

## The risk gate (`src/risk/guard.ts`)

DeepSeek can only *suggest*. These hard rules decide what actually happens, and the AI
cannot override them:

| Rule | Env var |
|---|---|
| Only trade instruments on the allow-list | `ALLOWED_EPICS` |
| Never exceed max size per position | `MAX_POSITION_SIZE` |
| Cap total open positions | `MAX_OPEN_POSITIONS` |
| Refuse to trade a near-empty account | `MIN_ACCOUNT_BALANCE` |
| Require a minimum AI confidence | `MIN_CONFIDENCE` |
| Attach stop-loss / take-profit to every trade | `STOP_LOSS_PCT`, `TAKE_PROFIT_PCT` |
| No new position if one already exists on that epic | (built-in) |
| Only trade when the market status is `TRADEABLE` | (built-in) |

## Recommended path to (maybe) going live

1. Run `npm run status` — confirm it reads your **demo** account.
2. Run `npm run once` in `DRY_RUN=true` — read the reasoning and the "would trade" logs.
3. Set `DRY_RUN=false` while still on **demo** — let it actually trade fake money for weeks.
4. Review `trades.log.jsonl` and your demo P/L honestly. Is it actually profitable, after
   spreads? Usually the honest answer is "not reliably."
5. Only if you're satisfied and accept the risk: switch `TRADING_MODE=live`, start with the
   smallest possible size and a low `MAX_OPEN_POSITIONS`.

## Disclaimer

This is not financial advice. Automated trading with real funds can lose your money.
You are solely responsible for any trades placed with your account.
