import { config } from "../config.js";
import { log } from "../logger.js";

/**
 * Minimal Capital.com REST client.
 * Docs: https://open-api.capital.com/
 *
 * Auth flow: POST /api/v1/session with the API key header returns two tokens
 * (CST and X-SECURITY-TOKEN) that must be sent on every subsequent request.
 */

export interface Account {
  accountId: string;
  balance: number;
  available: number;
  currency: string;
}

/** Extract a mid price from a Capital price field (a number or {bid, ask}). */
function mid(p: any): number {
  if (typeof p === "number") return p;
  const bid = p?.bid ?? 0;
  const ask = p?.ask ?? bid;
  return bid && ask ? (bid + ask) / 2 : bid || ask;
}

/** One OHLC bar (mid prices). */
export interface Bar {
  high: number;
  low: number;
  close: number;
}

/** Computed technical indicators — the "Quant" view fed to the brain. */
export interface Indicators {
  rsi14: number; // 0-100; >70 overbought, <30 oversold
  ema20: number;
  ema50: number; // NaN if <50 bars
  macd: number; // MACD line (EMA12 - EMA26)
  macdSignal: number; // 9-EMA of the MACD line
  macdHist: number; // macd - signal (>0 bullish momentum)
  atr14: number; // average true range (volatility, price units)
  atrPct: number; // ATR as % of price
}

export interface MarketSnapshot {
  epic: string;
  instrumentName: string;
  bid: number;
  offer: number;
  marketStatus: string;
  netChange: number; // absolute price change today
  percentageChange: number; // % change today (negative = falling)
  high: number;
  low: number;
  trendPct?: number; // % change over the recent trend window (multi-day)
  trendCloses?: number[]; // recent daily closes, oldest -> newest
  indicators?: Indicators; // computed technical indicators (see brain/indicators.ts)
  // Instrument dealing rules (for balance/leverage-based position sizing).
  marginFactor: number; // fraction of notional required as margin (e.g. 0.05 = 20:1)
  contractSize: number; // units per 1 lot
  minDealSize: number; // smallest allowed order size
  maxDealSize: number; // largest allowed order size (0 = unknown)
}

export interface OpenPosition {
  dealId: string;
  epic: string;
  direction: "BUY" | "SELL";
  size: number;
  level: number;
  upl: number; // unrealised P/L
}

export interface OpenOrder {
  epic: string;
  direction: "BUY" | "SELL";
  size: number;
  stopLevel?: number;
  profitLevel?: number;
  stopDistance?: number; // for trailing stop (points from entry)
  profitDistance?: number;
  trailingStop?: boolean;
}

export interface Transaction {
  date: string;
  instrumentName: string;
  transactionType: string;
  size: string;
  profitAndLoss: string; // e.g. "USD12.34"
}

export class CapitalClient {
  private cst?: string;
  private securityToken?: string;

  private headers(auth = true): Record<string, string> {
    const h: Record<string, string> = {
      "X-CAP-API-KEY": config.capital.apiKey,
      "Content-Type": "application/json",
    };
    if (auth) {
      if (!this.cst || !this.securityToken) {
        throw new Error("Not authenticated — call login() first");
      }
      h["CST"] = this.cst;
      h["X-SECURITY-TOKEN"] = this.securityToken;
    }
    return h;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    auth = true,
  ): Promise<{ data: T; res: Response }> {
    const res = await fetch(config.capital.baseUrl + path, {
      method,
      headers: this.headers(auth),
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Capital.com ${method} ${path} -> ${res.status}: ${text}`);
    }
    const data = (res.status === 204 ? {} : await res.json()) as T;
    return { data, res };
  }

  async login(): Promise<void> {
    const res = await fetch(config.capital.baseUrl + "/api/v1/session", {
      method: "POST",
      headers: this.headers(false),
      body: JSON.stringify({
        identifier: config.capital.identifier,
        password: config.capital.password,
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Capital.com login failed ${res.status}: ${text}`);
    }
    this.cst = res.headers.get("CST") ?? undefined;
    this.securityToken = res.headers.get("X-SECURITY-TOKEN") ?? undefined;
    if (!this.cst || !this.securityToken) {
      throw new Error("Login succeeded but tokens missing in response headers");
    }
    log.ok(`Authenticated to Capital.com (${config.mode.toUpperCase()} account)`);
  }

  async getAccount(): Promise<Account> {
    const { data } = await this.request<{ accounts: any[] }>("GET", "/api/v1/accounts");
    const a = data.accounts?.[0];
    if (!a) throw new Error("No accounts returned");
    return {
      accountId: a.accountId,
      balance: a.balance?.balance ?? 0,
      available: a.balance?.available ?? 0,
      currency: a.currency,
    };
  }

  async getPositions(): Promise<OpenPosition[]> {
    const { data } = await this.request<{ positions: any[] }>("GET", "/api/v1/positions");
    return (data.positions ?? []).map((p) => ({
      dealId: p.position.dealId,
      epic: p.market.epic,
      direction: p.position.direction,
      size: p.position.size,
      level: p.position.level,
      upl: p.position.upl ?? 0,
    }));
  }

  async getMarket(epic: string): Promise<MarketSnapshot> {
    const { data } = await this.request<any>("GET", `/api/v1/markets/${encodeURIComponent(epic)}`);
    const s = data.snapshot;
    const inst = data.instrument ?? {};
    const rules = data.dealingRules ?? {};

    // marginFactor can be a percentage (e.g. 5 -> 0.05) or already a fraction.
    let mf = Number(inst.marginFactor ?? 0.05);
    if (inst.marginFactorUnit === "PERCENTAGE" || mf > 1) mf = mf / 100;
    if (!mf || mf <= 0) mf = 0.05;

    return {
      epic,
      instrumentName: inst.name ?? epic,
      bid: s?.bid ?? 0,
      offer: s?.offer ?? 0,
      marketStatus: s?.marketStatus ?? "UNKNOWN",
      netChange: s?.netChange ?? 0,
      percentageChange: s?.percentageChange ?? 0,
      high: s?.high ?? 0,
      low: s?.low ?? 0,
      marginFactor: mf,
      contractSize: Number(inst.contractSize ?? 1) || 1,
      minDealSize: Number(rules.minDealSize?.value ?? 0.01) || 0.01,
      maxDealSize: Number(rules.maxDealSize?.value ?? 0) || 0,
    };
  }

  /** Historical OHLC bars (mid prices, oldest -> newest) at a given resolution. */
  async getHistoricalBars(epic: string, resolution: string, max: number): Promise<Bar[]> {
    const { data } = await this.request<{ prices: any[] }>(
      "GET",
      `/api/v1/prices/${encodeURIComponent(epic)}?resolution=${resolution}&max=${max}`,
    );
    return (data.prices ?? [])
      .map((p) => ({
        high: mid(p.highPrice),
        low: mid(p.lowPrice),
        close: mid(p.closePrice),
      }))
      .filter((b: Bar) => b.close > 0);
  }

  /** Daily historical mid-close prices for an epic (oldest -> newest). */
  async getHistoricalCloses(epic: string, days: number): Promise<number[]> {
    const bars = await this.getHistoricalBars(epic, "DAY", days);
    return bars.map((b) => b.close);
  }

  /** Transactions (incl. realised P/L) between two ISO timestamps. */
  async getTransactions(fromIso: string, toIso: string): Promise<Transaction[]> {
    const { data } = await this.request<{ transactions: any[] }>(
      "GET",
      `/api/v1/history/transactions?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`,
    );
    return (data.transactions ?? []).map((t) => ({
      date: t.date,
      instrumentName: t.instrumentName,
      transactionType: t.transactionType,
      size: t.size,
      profitAndLoss: t.profitAndLoss ?? "0",
    }));
  }

  /** Open a market position with attached stop-loss and take-profit. */
  async openPosition(order: OpenOrder): Promise<{ dealReference: string }> {
    const body: Record<string, unknown> = {
      epic: order.epic,
      direction: order.direction,
      size: order.size,
    };
    if (order.trailingStop) {
      // Trailing stop requires a stop DISTANCE (not level) and no guaranteed stop.
      body["trailingStop"] = true;
      body["guaranteedStop"] = false;
      if (order.stopDistance !== undefined) body["stopDistance"] = order.stopDistance;
      if (order.profitDistance !== undefined) body["profitDistance"] = order.profitDistance;
    } else {
      if (order.stopLevel !== undefined) body["stopLevel"] = order.stopLevel;
      if (order.profitLevel !== undefined) body["profitLevel"] = order.profitLevel;
    }
    const { data } = await this.request<{ dealReference: string }>(
      "POST",
      "/api/v1/positions",
      body,
    );
    return data;
  }

  /**
   * Confirm a just-placed deal to recover the resulting position's dealId and
   * actual fill level. Capital.com fills are async: the POST returns only a
   * dealReference, and /confirms resolves it. Returns null if it can't confirm.
   */
  async getDealConfirmation(
    dealReference: string,
  ): Promise<{ dealId: string; level: number; status: string } | null> {
    try {
      const { data } = await this.request<any>(
        "GET",
        `/api/v1/confirms/${encodeURIComponent(dealReference)}`,
      );
      const dealId = data.affectedDeals?.[0]?.dealId ?? data.dealId;
      if (!dealId) return null;
      return {
        dealId,
        level: Number(data.level ?? 0) || 0,
        status: data.dealStatus ?? data.status ?? "UNKNOWN",
      };
    } catch (e) {
      log.warn(`Deal confirmation failed for ${dealReference}:`, (e as Error).message);
      return null;
    }
  }

  async closePosition(dealId: string): Promise<void> {
    await this.request("DELETE", `/api/v1/positions/${encodeURIComponent(dealId)}`);
  }
}
