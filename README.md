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
npm run stats      # win-rate by regime / setup / instrument (reads the ledger)
npm run typecheck  # verify the code compiles
```

## Devil's Advocate (adversarial second opinion)

Before a proposed BUY/SELL reaches the risk gate, a second DeepSeek call plays
**Devil's Advocate** — its only job is to argue *against* the trade (counter-news,
price already priced-in, momentum/trend divergence, imminent CPI/NFP/FOMC, weak
reasoning). It returns a `counterConfidence` (0–1) and a verdict
(`uphold` / `reduce` / `veto`).

It runs in one of two modes (`DEVIL_MODE`):

- **`observe` (default):** the critic's verdict is *recorded* but trades still
  open. This is deliberate — to know whether vetoing *helps*, you need the actual
  outcome of the trades it wanted to veto. Every trade logs the Chief Trader's
  original judgment, the critic's verdict, the final decision, and (on close) the
  realised P/L.
- **`enforce`:** a high-conviction veto (`counterConfidence ≥ DEVIL_VETO_THRESHOLD`)
  downgrades the trade to HOLD; a `reduce` shaves its confidence.

**The intended workflow:** run in `observe` on the Capital.com demo, let trades
accumulate, then check `npm run stats` — it computes an **A/B** comparing *all
trades* vs *trades excluding the vetoed ones*, on win-rate, expectancy, profit
factor and max drawdown. Only if the veto shows a real improvement on a big
enough sample do you switch `DEVIL_MODE=enforce` — and only then consider
scaling up to a full multi-agent (News/Quant/Macro/Chief/Jury) brain.

## Trade analytics (`npm run stats`)

Every open records the **market regime** (`risk-off`, `panic`, `trending`, …) and the
trade's **setup** (`momentum`, `breakout`, `safe-haven`, …) that DeepSeek assigned; every
close records the realised P/L. `npm run stats` reconstructs round-trip trades from
`trades.log.jsonl` and groups them by regime, setup, instrument, direction and confidence
band — so over time you learn *which conditions actually pay* and can retire the ones that
don't. Exits that hit the broker's stop-loss / take-profit between cycles are reconciled
back into the ledger automatically, so they aren't silently missing from your win-rate.

**The ledger is committed back to the repo.** In GitHub Actions each run is a throwaway
runner, so the `trade` workflow commits `trades.log.jsonl` after every cycle (hence a bot
commit on `main` every 2h) — that's what lets the analytics accumulate. The daily report
workflow also pushes the stats summary to Telegram.

## The risk gate (`src/risk/guard.ts`)

DeepSeek can only *suggest*. These hard rules decide what actually happens, and the AI
cannot override them:

| Rule | Env var |
|---|---|
| Only trade instruments on the allow-list | `ALLOWED_EPICS` |
| **Size by risk-to-stop: cap loss-if-stopped at this % of equity** | `RISK_PER_TRADE_PCT` |
| **Refuse a trade whose min lot exceeds the per-trade risk cap** | (built-in) |
| **Halt new opens on daily / weekly / drawdown breach** | `MAX_DAILY_LOSS_PCT`, `MAX_WEEKLY_LOSS_PCT`, `MAX_DRAWDOWN_PCT` |
| Never exceed the anti-runaway size ceiling | `MAX_POSITION_SIZE` |
| Cap total open positions | `MAX_OPEN_POSITIONS` |
| Refuse to trade a near-empty account | `MIN_ACCOUNT_BALANCE` |
| Refuse if required margin exceeds available | (built-in) |
| Require a minimum AI confidence | `MIN_CONFIDENCE` |
| Attach stop-loss / take-profit to every trade | `STOP_LOSS_PCT`, `TAKE_PROFIT_PCT` |
| No new position if one already exists on that epic | (built-in) |
| Only trade when the market status is `TRADEABLE` | (built-in) |

### Risk budget & objective

The goal is **not** "maximise profit" — it's *maximise long-run risk-adjusted return
subject to strict loss limits*. Two mechanisms enforce that, both pure code:

- **Risk-to-stop sizing.** Position size is `equity × RISK_PER_TRADE_PCT / (contractSize ×
  stopDistance)`, scaled down for lower conviction (never up). So the loss if the stop is
  hit is capped at a fixed % of equity — every trade risks ~**1R**. If even the smallest
  tradeable lot would risk more than the cap, the trade is refused rather than oversized.
- **Circuit breakers.** Realised daily / weekly loss and peak-to-current drawdown are
  computed from the ledger each cycle; on breach the engine **halts all new opens** (closes
  still allowed) and says so in the log and Telegram. No Martingale — losses never increase
  the next size.

Because trades are sized in R, `npm run stats` reports **expectancy in R** alongside win-rate,
profit factor and max drawdown — so "positive risk-adjusted expectancy" is a number you read
off the report, not a vibe. Backtesting the news-driven core faithfully is effectively
impossible (no time-aligned historical news corpus; the LLM already knows how past events
resolved → lookahead bias), so **the Capital.com demo, running forward, is the out-of-sample,
cost-inclusive test** — demo pricing includes real spread and overnight funding.

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
